<script lang="ts">
  import { onDestroy } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import ErrorShell from '$lib/features/shell/error-shell.svelte';
  import { createRetryController } from '$lib/foundation/navigation/svelte/retry';

  let pending = $state(false);
  let retryFailed = $state(false);
  const retryController = createRetryController({
    retry: async (signal) => {
      signal.throwIfAborted();
      await invalidate('ai-usage:report-root');
      signal.throwIfAborted();
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
    status={page.status}
  />
{/if}
