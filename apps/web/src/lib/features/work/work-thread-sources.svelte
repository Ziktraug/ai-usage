<script lang="ts">
  import type { WorkThreadSourceStatus } from '@ai-usage/report-core/work-thread-view';
  import { sourceName, threadDate, threadSourceAvailability } from './work-thread-model';
  import { threadStyles } from './work-thread-styles';

  let { sources, now, timeZone }: { sources: readonly WorkThreadSourceStatus[]; now: string; timeZone: string } =
    $props();
  const availability = $derived(threadSourceAvailability(sources, now, timeZone));
</script>

{#if availability.details.length}
  <details aria-label="Source availability" class={`wt-availability ${threadStyles.availability}`}>
    <summary title={availability.summary || 'Source details'}>
      <span>{availability.summary || 'Source details'}</span>
      {#if availability.summary}
        <span class={`wt-link ${threadStyles.link}`}>details</span>
      {/if}
    </summary>
    <div class={`wt-availability-detail ${threadStyles.availabilityDetail}`}>
      {#each availability.details as source (source.source)}
        <p>
          <strong>{sourceName(source.source)}: {source.label}</strong>
          {source.message ? ` · ${source.message}` : ''}
          <span
            >{source.lastRunAt
              ? ` · last read ${threadDate(source.lastRunAt, timeZone)}`
              : ' · no successful read observed'}</span
          >
        </p>
      {/each}
      <p>Unavailable or older evidence does not establish that nothing is left.</p>
    </div>
  </details>
{/if}
