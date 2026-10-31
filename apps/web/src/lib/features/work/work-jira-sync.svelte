<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import { collectionSwrKey } from '../../query/keys';
  import { useSourceControl } from '../sources/context.svelte';
  import { presentJiraSync } from './work-jira-sync-model';

  let { timeZone }: { timeZone: string } = $props();
  const control = useSourceControl();
  const queryClient = useQueryClient();
  const status = $derived(presentJiraSync(control.state()));
  // Jira facts are outside the served report revision. Invalidate their named SWR identity
  // at each completed batch, including partial batches, so already visible tasks update.
  let previousFinishedAt: string | null = null;
  $effect(() => {
    if (status.lastFinishedAt && status.lastFinishedAt !== previousFinishedAt) {
      previousFinishedAt = status.lastFinishedAt;
      queryClient.invalidateQueries({ queryKey: collectionSwrKey('work-threads') });
    }
  });
</script>

<p class="wt-meta" data-jira-sync role="status">
  {status.label}
  {#if status.lastFinishedAt}
    {status.checked ? ' · ' : ' · Last run '}
    <time datetime={status.lastFinishedAt}
      >{new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
        new Date(status.lastFinishedAt),
      )}</time
    >
  {/if}
  · <a class="wt-link" href="/sources">Sources</a>
</p>
