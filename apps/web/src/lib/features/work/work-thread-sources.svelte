<script lang="ts">
  import type { WorkThreadSourceStatus } from '@ai-usage/report-core/work-thread-view';
  import { sourceName, threadDate } from './work-thread-model';

  let { sources, now, timeZone }: { sources: readonly WorkThreadSourceStatus[]; now: string; timeZone: string } =
    $props();
  const issues = $derived(
    sources.filter(
      (source) =>
        source.state !== 'ok' || !source.lastRunAt || Date.parse(now) - Date.parse(source.lastRunAt) > 7 * 86_400_000,
    ),
  );
</script>

{#if issues.length}
  <aside aria-label="Source availability" class="wt-source-warning">
    {#each issues as source (source.source)}
      <p>
        <strong>{sourceName(source.source)}: {source.state === 'ok' ? 'stale observation' : source.state}</strong>
        {source.message ? ` · ${source.message}` : ''}
        <span
          >{source.lastRunAt ? ` · last read ${threadDate(source.lastRunAt, timeZone)}` : ' · no successful read observed'}</span
        >
      </p>
    {/each}
    <p>Unavailable or older evidence does not establish that nothing is left.</p>
  </aside>
{/if}
