<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import ErrorShell from '#lib/features/shell/error-shell.svelte';
  import { createRetryController } from '#lib/foundation/navigation/svelte/retry.ts';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  let pending = $state(false);
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });
  let retryFailed = $state(false);
  let destroyed = false;
  const retryController = createRetryController({
    retry: async (signal) => {
      signal.throwIfAborted();
      // SvelteKit 3's refreshAll/replace rerun every load in place, without a document reload.
      // The native form remains a progressive fallback only before JavaScript has hydrated.
      await goto(new URL(page.url.href), { refreshAll: true, replace: true });
      if (destroyed || signal.aborted) {
        return;
      }
      signal.throwIfAborted();
      if (page.status >= 400 || page.error) {
        throw new Error('The route is still unavailable.');
      }
    },
  });
  const retry = async (): Promise<void> => {
    pending = true;
    retryFailed = false;
    try {
      await retryController.run();
    } catch {
      if (!destroyed) {
        retryFailed = true;
      }
    } finally {
      if (!destroyed) {
        pending = retryController.pending();
      }
    }
  };
  onDestroy(() => {
    destroyed = true;
    retryController.dispose();
  });
</script>

{#if page.status === 404}
  <ErrorShell {pending} status={page.status} />
{:else}
  <ErrorShell
    {hydrated}
    message={retryFailed ? 'Retry failed. Try again.' : undefined}
    onRetry={retry}
    {pending}
    retryHref={`${page.url.pathname}${page.url.search}`}
    retryParameters={[...page.url.searchParams]}
    status={page.status}
  />
{/if}
