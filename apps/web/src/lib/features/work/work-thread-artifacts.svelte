<script lang="ts">
  import { parseWorkThreadLinkKey } from '@ai-usage/report-core/work-thread';
  import type { WorkThreadRow } from '@ai-usage/report-core/work-thread-view';
  import {
    localCheckoutStatus,
    observedWebUrl,
    pullRequestBadge,
    pullRequestChecks,
    threadDate,
    threadTime,
  } from './work-thread-model';

  let { row, now, timeZone }: { row: WorkThreadRow; now: string; timeZone: string } = $props();
  const freshness = (at: string | undefined, outcome: string | undefined): string => {
    if (!at) {
      return 'Not observed';
    }
    const date = `${threadDate(at, timeZone, false, now)} ${threadTime(at, timeZone)}`;
    if (outcome !== 'observed') {
      return `Latest read: ${outcome} · ${date}`;
    }
    return `${Date.parse(now) - Date.parse(at) > 7 * 86_400_000 ? 'Stale · ' : ''}Observed ${date}`;
  };
  const checkGlyph = { passing: '✓', failing: '✕', pending: '◌', unknown: '?' } as const;
</script>
<div class="wt-artifacts">
  {#each row.markers.pullRequests as marker (marker.key)}
    {@const fact = marker.latest?.outcome === 'observed' ? marker.latest : marker.latestSuccessful}
    {@const parsed = parseWorkThreadLinkKey('pull-request', marker.key)}
    {@const url = observedWebUrl(
      fact?.url ??
        (parsed?.kind === 'pull-request' ? `https://${parsed.host}/${parsed.repository}/pull/${parsed.number}` : null),
    )}
    {@const badge = pullRequestBadge(marker)}
    {@const checks = pullRequestChecks(marker)}
    <div class="wt-artifact" title={freshness(marker.latest?.observedAt, marker.latest?.outcome)}>
      {#if url}
        <a class="wt-link" href={url} rel="noopener noreferrer" target="_blank"
          >PR #{fact?.number ?? (parsed?.kind === 'pull-request' ? parsed.number : '?')}
          ↗</a
        >
      {:else}
        <span>PR</span>
      {/if}
      <span class="wt-pill" data-tone={badge.tone}>{badge.label}</span>
      {#if checks}
        <span class="wt-checks" data-tone={checks.tone}
          ><span aria-hidden="true" class="wt-check-glyph">{checkGlyph[checks.tone]}</span>{checks.label}</span
        >
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
        <span>{fact?.key ?? (parsed?.kind === 'jira-issue' ? parsed.key : 'Jira')}</span>
      {/if}
      <span class="wt-pill" data-tone={`jira-${fact?.statusCategory ?? 'unknown'}`}
        >{fact?.status ?? 'Not read yet'}</span
      >
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
