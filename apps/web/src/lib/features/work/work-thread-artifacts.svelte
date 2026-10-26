<script lang="ts">
  import { parseWorkThreadLinkKey } from '@ai-usage/report-core/work-thread';
  import type { WorkThreadRow } from '@ai-usage/report-core/work-thread-view';
  import { localCheckoutStatus, observedWebUrl, threadDate, threadTime } from './work-thread-model';

  let { row, now, timeZone }: { row: WorkThreadRow; now: string; timeZone: string } = $props();
  const freshness = (at: string | undefined, outcome: string | undefined): string => {
    if (!at) {
      return 'Not observed';
    }
    const date = `${threadDate(at, timeZone)} ${threadTime(at, timeZone)}`;
    if (outcome !== 'observed') {
      return `Latest read: ${outcome} · ${date}`;
    }
    return `${Date.parse(now) - Date.parse(at) > 7 * 86_400_000 ? 'Stale · ' : ''}Observed ${date}`;
  };
</script>
<div class="wt-artifacts">
  {#each row.markers.pullRequests as marker (marker.key)}
    {@const fact = marker.latest?.outcome === 'observed' ? marker.latest : marker.latestSuccessful}
    {@const parsed = parseWorkThreadLinkKey('pull-request', marker.key)}
    {@const url = observedWebUrl(
      fact?.url ??
        (parsed?.kind === 'pull-request' ? `https://${parsed.host}/${parsed.repository}/pull/${parsed.number}` : null),
    )}
    <div class="wt-artifact" title={freshness(marker.latest?.observedAt, marker.latest?.outcome)}>
      {#if url}
        <a class="wt-link" href={url} rel="noopener noreferrer" target="_blank"
          >PR #{fact?.number ?? (parsed?.kind === 'pull-request' ? parsed.number : '?')}
          ↗</a
        >
      {:else}
        <span>PR</span>
      {/if}
      <span class="wt-status" data-state={fact?.state}
        >{fact?.draft && fact.state === 'OPEN' ? 'Draft' : (fact?.state?.toLowerCase() ?? 'Unknown')}</span
      >
      <span class="wt-status" data-state={fact?.checksRollup}>CI {fact?.checksRollup ?? 'unknown'}</span>
      {#if fact?.state === 'OPEN'}
        <span>{fact.reviewDecision?.replaceAll('_', ' ').toLowerCase() ?? 'Review unknown'}</span>
      {/if}
      {#if marker.latest?.outcome !== 'observed'}
        <span class="wt-read-warning">{marker.latest ? `Read: ${marker.latest.outcome}` : 'Not observed'}</span>
      {/if}
    </div>
  {/each}
  {#each row.markers.jiraIssues as marker (marker.key)}
    {@const fact = marker.latest?.outcome === 'observed' ? marker.latest : marker.latestSuccessful}
    {@const url = observedWebUrl(fact?.url ?? null)}
    {@const parsed = parseWorkThreadLinkKey('jira-issue', marker.key)}
    <div class="wt-artifact" title={freshness(marker.latest?.observedAt, marker.latest?.outcome)}>
      {#if url}
        <a class="wt-link" href={url} rel="noopener noreferrer" target="_blank">{fact?.key} ↗</a>
      {:else}
        <span>{fact?.key ?? (parsed?.kind === 'jira-issue' ? parsed.key : 'Jira')} · link unavailable</span>
      {/if}
      <span>{fact?.status ?? 'Status unknown'}</span>
      {#if marker.latest && marker.latest.outcome !== 'observed'}
        <span class="wt-read-warning">Read: {marker.latest.outcome}</span>
      {/if}
    </div>
  {/each}
  {#each row.markers.local as marker (marker.key)}
    {@const fact = marker.latest?.outcome === 'observed' ? marker.latest : marker.latestSuccessful}
    <div
      class="wt-artifact"
      title={`${marker.latest?.checkoutPath ?? fact?.checkoutPath ?? ''} · ${freshness(marker.latest?.observedAt, marker.latest?.outcome)}`}
    >
      <span>{fact?.branch ?? 'Local checkout'}</span>
      <span>{localCheckoutStatus(marker)}</span>
    </div>
  {/each}
</div>
