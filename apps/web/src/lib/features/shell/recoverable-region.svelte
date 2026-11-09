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
  const focusInsideRegion = (): boolean =>
    typeof document !== 'undefined' && !!container?.contains(document.activeElement);
  /** The reader's focus is here or on nothing (body/null, as after the focused Retry unmounted). */
  const focusAvailableToRegion = (): boolean => {
    if (typeof document === 'undefined') {
      return false;
    }
    const active = document.activeElement;
    return active === null || active === document.body || !!container?.contains(active);
  };
  const handleRenderFailure = (cause: unknown): void => {
    failureGeneration += 1;
    restoreFocus = containedFocus || focusInsideRegion();
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
    // Never steal focus the reader moved elsewhere (a filter, a sibling) while the retry was pending.
    if (focusAvailableToRegion()) {
      container?.focus();
    }
  };
  const handleFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node) {
      containedFocus = container?.contains(event.relatedTarget) ?? false;
      return;
    }
    // No relatedTarget: the reader moved focus to nothing (body), the window lost focus with the
    // element still active, or the element unmounted while focused (a failing render removing
    // it). Only the settled state tells them apart; an unmounted element never handed focus back
    // to the reader, so the region still owns it.
    const left = event.target;
    queueMicrotask(() => {
      if (!alive || (left instanceof Node && !left.isConnected)) {
        return;
      }
      containedFocus = focusInsideRegion();
    });
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
  onfocusout={handleFocusOut}
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
