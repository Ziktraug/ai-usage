<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { onDestroy, type Snippet, tick } from 'svelte';
  import { recoverRegion, reportRenderError } from './report-render-error';
  import UnavailableRegion from './unavailable-region.svelte';

  let {
    children,
    label,
    onRetry,
    compact = false,
    class: className,
    region,
    stale = false,
    busy = false,
  }: {
    children: Snippet;
    label: string;
    onRetry: () => Promise<void>;
    compact?: boolean;
    class?: string;
    region?: 'overview' | 'panel';
    stale?: boolean;
    busy?: boolean;
  } = $props();
  // Retain the parent's stack gap through this wrapper: opacity needs a real box, not contents.
  const layout = css({ display: 'grid', gap: 'inherit', minW: 0 });
  const status = css({ srOnly: true });
  let container = $state<HTMLElement>();
  let message = $state('');
  let restoreFocus = $state(false);
  let containedFocus = false;
  let alive = true;
  let failureGeneration = 0;
  onDestroy(() => {
    alive = false;
  });
  const handleRenderFailure = (cause: unknown): void => {
    failureGeneration += 1;
    restoreFocus = containedFocus || (typeof document !== 'undefined' && !!container?.contains(document.activeElement));
    message = `${label} is temporarily unavailable.`;
    reportRenderError(cause);
  };
  const retry = async (reset: () => void): Promise<void> => {
    const generation = failureGeneration;
    await recoverRegion(reset, onRetry);
    await tick();
    if (!alive || generation !== failureGeneration) {
      return;
    }
    message = `${label} recovered.`;
    if (alive) {
      container?.focus();
    }
  };
</script>

<section
  aria-busy={stale ? busy : undefined}
  aria-label={`${label} region`}
  class={cx(layout, className)}
  data-region-container
  data-report-region={region}
  data-report-stale={stale ? 'true' : undefined}
  onfocusin={() => {
    containedFocus = true;
  }}
  onfocusout={(event) => {
    if (event.relatedTarget instanceof Node && !container?.contains(event.relatedTarget)) {
      containedFocus = false;
    }
  }}
  tabindex="-1"
  bind:this={container}
>
  <p class={status} role="status">{message}</p>
  <!-- Svelte 5.57 catches client render/effect errors here. Synchronous SSR errors still
       propagate to Kit's error route; the throwing-child SSR test documents that boundary. -->
  <svelte:boundary onerror={handleRenderFailure}>
    {@render children()}
    {#snippet failed(
      _error,
      reset,
    )}
      <UnavailableRegion
        announce={false}
        {compact}
        focusOnMount={restoreFocus}
        {label}
        onFailure={() => {
          message = `${label} retry failed. Try again.`;
        }}
        onRetry={() => retry(reset)}
      />
    {/snippet}
  </svelte:boundary>
</section>
