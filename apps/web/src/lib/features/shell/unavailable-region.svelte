<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';
  import { onDestroy, onMount, tick } from 'svelte';
  import { reportUnexpectedPrefetchFailure } from './prefetch-errors';

  let {
    label,
    onRetry,
    compact = false,
    announce = true,
    focusOnMount = false,
    onFailure = () => undefined,
  }: {
    label: string;
    onRetry: () => Promise<void>;
    compact?: boolean;
    announce?: boolean;
    focusOnMount?: boolean;
    onFailure?: () => void;
  } = $props();
  let retryButtonElement = $state<HTMLButtonElement>();
  let alive = true;
  onDestroy(() => {
    alive = false;
  });
  onMount(() => {
    if (focusOnMount) {
      retryButtonElement?.focus();
    }
  });
  let pending = $state(false);
  let failed = $state(false);
  const panel = css({
    border: '1px solid token(colors.line)',
    borderRadius: 'lg',
    p: '16px',
    display: 'grid',
    gap: '12px',
    justifyItems: 'start',
    color: 'ink',
    fontSize: '13px',
  });
  const retryButton = css({ minH: '44px', minW: '44px' });
  const compactPanel = css({ p: { md: '2px', xl: '12px' }, minW: 0, gap: { md: 0, xl: '8px' } });
  const compactText = css({ srOnly: { md: true, xl: false } });
  const compactMark = css({ display: { base: 'none', md: 'inline', xl: 'none' } });
  const retry = async (): Promise<void> => {
    if (pending) {
      return;
    }
    pending = true;
    failed = false;
    try {
      await onRetry();
    } catch (cause) {
      if (alive) {
        failed = true;
        onFailure();
      }
      reportUnexpectedPrefetchFailure(cause);
    } finally {
      if (alive) {
        pending = false;
        await tick();
        if (alive && failed) {
          retryButtonElement?.focus();
        }
      }
    }
  };
</script>

<section aria-busy={pending} aria-label={label} class={cx(panel, compact && compactPanel)} data-region-unavailable>
  <p class={compact ? compactText : undefined} role={announce ? 'status' : undefined}>
    {label}
    is temporarily unavailable.{failed ? ' Retry failed. Try again.' : ''}
  </p>
  <!-- aria-disabled retains keyboard focus (a native disabled button hands it to the body, which a
       failing re-render would then leave stranded); the handler suppresses duplicate activation. -->
  <button
    aria-disabled={pending}
    aria-label={compact ? `${label} unavailable. Retry` : undefined}
    class={cx(ghostButton, retryButton)}
    onclick={retry}
    title={compact ? `${label} is temporarily unavailable. Retry.` : undefined}
    type="button"
    bind:this={retryButtonElement}
  >
    {#if compact}
      <span aria-hidden="true" class={compactMark}>!</span>
    {/if}
    <span class={compact ? compactText : undefined}>{pending ? 'Retrying…' : 'Retry'}</span>
  </button>
</section>
