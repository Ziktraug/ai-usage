<script lang="ts">
  import { onDestroy } from 'svelte';
  import { page } from '$app/state';
  import ErrorShell from '$lib/features/shell/error-shell.svelte';
  import { createRetryController } from '$lib/foundation/navigation/svelte/retry';

  let pending = $state(false);
  let retryFailed = $state(false);
  const retryController = createRetryController({
    retry: (signal) => {
      signal.throwIfAborted();
      window.location.reload();
      signal.throwIfAborted();
      return Promise.resolve();
    },
  });
  const retry = async (): Promise<void> => {
    pending = true;
    retryFailed = false;
    try {
      await retryController.run();
    } catch {
      retryFailed = true;
    } finally {
      pending = retryController.pending();
    }
  };
  onDestroy(() => retryController.dispose());
</script>

{#if page.status === 404}
  <ErrorShell {pending} status={page.status} />
{:else}
  <ErrorShell
    message={retryFailed ? 'Retry failed. Try again.' : undefined}
    onRetry={retry}
    {pending}
    retryHref={`${page.url.pathname}${page.url.search}`}
    retryParameters={[...page.url.searchParams]}
    status={page.status}
  />
{/if}
