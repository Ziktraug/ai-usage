<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { LazyModuleLoadResult } from '../../report/composition/lazy-module-loader';
  import { reportRenderError } from '../../shell/report-render-error';

  let { onRetry }: { onRetry: () => Promise<LazyModuleLoadResult> } = $props();
  let pending = $state(false);
  let message = $state('Session details are temporarily unavailable.');
  let attempts = 0;
  let alive = true;
  onDestroy(() => {
    alive = false;
  });
  const failed = (): void => {
    if (alive) {
      message = `Session details retry ${attempts} failed. Try again.`;
    }
  };
  const retry = async (): Promise<void> => {
    if (pending) {
      return;
    }
    pending = true;
    attempts += 1;
    message = 'Retrying session details…';
    try {
      if ((await onRetry()) === 'failed') {
        failed();
      }
    } catch (cause) {
      failed();
      reportRenderError(cause);
    } finally {
      if (alive) {
        pending = false;
      }
    }
  };
</script>

<div aria-busy={pending}>
  <p aria-atomic="true" role="status">{message}</p>
  <!-- aria-disabled retains keyboard focus; the handler suppresses duplicate activation. -->
  <button aria-disabled={pending} onclick={retry} type="button">Retry session details</button>
</div>
