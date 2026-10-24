<script lang="ts">
  import type { WorkThreadMarkers } from '@ai-usage/report-core/work-thread-view';
  import { observedWebUrl, threadDate, threadTime } from './work-thread-model';

  let {
    markers,
    timeZone,
    now,
    analysisOnly = false,
  }: { markers: WorkThreadMarkers; timeZone: string; now: string; analysisOnly?: boolean } = $props();
  const observed = (at: string): string => `${threadDate(at, timeZone)} at ${threadTime(at, timeZone)}`;
  const stale = (at: string): boolean => Date.parse(now) - Date.parse(at) > 7 * 86_400_000;
  const count = (value: number | null): string => (value === null ? 'Unknown' : String(value));
  const worktreeCaption = (dirty: boolean | null | undefined): string => {
    if (dirty === false) {
      return 'Worktree clean';
    }
    return dirty ? 'Local changes remain' : 'Worktree state unknown';
  };
</script>

{#if !(markers.local.length || markers.pullRequests.length || markers.jiraIssues.length)}
  <p class="wt-no-artifact">
    {analysisOnly ? 'Analysis only · no branch, PR or ticket needed' : 'No branch, PR or ticket linked. This does not establish that the task is complete.'}
  </p>
{:else}
  <div class="wt-markers">
    {#if markers.local.length}
      {@const main = markers.local[0]?.latest?.outcome === 'observed' ? markers.local[0]?.latest : markers.local[0]?.latestSuccessful}
      <details class="wt-source">
        <summary>
          <span class="wt-source-label">LOCAL <span aria-hidden="true">›</span></span
          ><strong>{main?.branch ?? 'Branch unknown'}</strong
          ><span class="wt-meta"
            >{worktreeCaption(main?.dirty)}
            {markers.local.length > 1 ? ` · ${markers.local.length} checkouts` : ''}</span
          >
        </summary>
        <div class="wt-source-detail">
          {#each markers.local as marker (marker.key)}
            {@const fact = marker.latest?.outcome === 'observed' ? marker.latest : marker.latestSuccessful}
            <div class="wt-source-fact">
              {#if !marker.latest}
                <p>Latest read: unknown</p>
              {:else if marker.latest.outcome !== 'observed'}
                <p>
                  Latest read: {marker.latest.outcome} · {observed(marker.latest.observedAt)}. Showing the last
                  successful observation when available.
                </p>
              {/if}
              {#if fact}
                <p class="wt-meta">
                  Observed {observed(fact.observedAt)}{stale(fact.observedAt) ? ' · Stale observation' : ''}
                </p>
                <code class="wt-code">{fact.checkoutPath}</code>
                <dl class="wt-facts">
                  <div>
                    <dt>Branch</dt>
                    <dd>{fact.branch ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Upstream</dt>
                    <dd>{fact.upstream ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Modified / staged / untracked</dt>
                    <dd>{count(fact.modifiedCount)} / {count(fact.stagedCount)} / {count(fact.untrackedCount)}</dd>
                  </div>
                  <div>
                    <dt>Ahead / behind upstream</dt>
                    <dd>{count(fact.ahead)} / {count(fact.behind)}</dd>
                  </div>
                </dl>
              {:else}
                <p>No successful checkout observation available.</p>
              {/if}
            </div>
          {/each}
        </div>
      </details>
    {/if}
    {#if markers.pullRequests.length}
      {@const main = markers.pullRequests[0]?.latest?.outcome === 'observed' ? markers.pullRequests[0]?.latest : markers.pullRequests[0]?.latestSuccessful}
      <details class="wt-source">
        <summary>
          <span class="wt-source-label">GITHUB <span aria-hidden="true">›</span></span
          ><strong>PR #{main?.number ?? '?'} · {main?.state?.toLowerCase() ?? 'Unknown'}</strong
          ><span class="wt-meta"
            >{main?.reviewDecision?.replaceAll('_', ' ').toLowerCase() ?? 'Review unknown'}
            · Checks {main?.checksRollup ?? 'unknown'}</span
          >
        </summary>
        <div class="wt-source-detail">
          {#each markers.pullRequests as marker (marker.key)}
            {@const fact = marker.latest?.outcome === 'observed' ? marker.latest : marker.latestSuccessful}
            <div class="wt-source-fact">
              {#if !marker.latest}
                <p>Latest read: unknown</p>
              {:else if marker.latest.outcome !== 'observed'}
                <p>
                  Latest read: {marker.latest.outcome} · {observed(marker.latest.observedAt)}.
                  {marker.latest.outcomeMessage ?? 'Showing the last successful observation when available.'}
                </p>
              {/if}
              {#if fact}
                <p class="wt-meta">
                  Observed {observed(fact.observedAt)}{stale(fact.observedAt) ? ' · Stale observation' : ''}
                </p>
                <p>PR #{fact.number} · {fact.title ?? fact.repository}</p>
                <dl class="wt-facts">
                  <div>
                    <dt>Head → base</dt>
                    <dd>{fact.headRef ?? 'Unknown'} → {fact.baseRef ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>{fact.state ?? 'Unknown'}{fact.draft ? ' · Draft' : ''}</dd>
                  </div>
                  <div>
                    <dt>Checks</dt>
                    <dd>{fact.checksRollup ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>GitHub review decision</dt>
                    <dd>{fact.reviewDecision?.replaceAll('_', ' ') ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Mergeability</dt>
                    <dd>{marker.mergeable ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Merge state</dt>
                    <dd>{marker.mergeStateStatus ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Behind base</dt>
                    <dd>
                      {marker.mergeStateStatus === 'BEHIND' ? `Behind ${fact.baseRef ?? 'unknown base'}` : 'No behind observation'}
                    </dd>
                  </div>
                </dl>
                {#if fact.state === 'MERGED'}
                  <p class="wt-meta">Merged does not establish deployment.</p>
                {/if}
                {@const url = observedWebUrl(fact.url)}
                {#if url}
                  <a class="wt-link" href={url} rel="noopener noreferrer" target="_blank"
                    >Open PR #{fact.number}
                    on GitHub ↗</a
                  >
                {:else}
                  <p class="wt-meta">No verified web URL available.</p>
                {/if}
              {:else}
                <p>No successful PR observation available.</p>
              {/if}
            </div>
          {/each}
          <p class="wt-meta">An agent review is not a human approval.</p>
        </div>
      </details>
    {/if}
    {#if markers.jiraIssues.length}
      {@const main = markers.jiraIssues[0]?.latest?.outcome === 'observed' ? markers.jiraIssues[0]?.latest : markers.jiraIssues[0]?.latestSuccessful}
      <details class="wt-source">
        <summary>
          <span class="wt-source-label">JIRA <span aria-hidden="true">›</span></span
          ><strong>{main?.key ?? 'Ticket unknown'} · {main?.status ?? 'Unknown'}</strong
          ><span class="wt-meta">The ticket keeps its own status</span>
        </summary>
        <div class="wt-source-detail">
          {#each markers.jiraIssues as marker (marker.key)}
            {@const fact = marker.latest?.outcome === 'observed' ? marker.latest : marker.latestSuccessful}
            <div class="wt-source-fact">
              {#if !marker.latest}
                <p>Latest read: unknown</p>
              {:else if marker.latest.outcome !== 'observed'}
                <p>
                  Latest read: {marker.latest.outcome} · {observed(marker.latest.observedAt)}.
                  {marker.latest.outcomeMessage ?? 'Showing the last successful observation when available.'}
                </p>
              {/if}
              {#if fact}
                <p class="wt-meta">
                  Observed {observed(fact.observedAt)}{stale(fact.observedAt) ? ' · Stale observation' : ''}
                </p>
                <p>{fact.key} · {fact.summary ?? 'Summary not observed'}</p>
                <dl class="wt-facts">
                  <div>
                    <dt>Status</dt>
                    <dd>{fact.status ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Status category</dt>
                    <dd>{fact.statusCategory ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Assignee</dt>
                    <dd>{fact.assigneeLabel ?? 'Unknown'}</dd>
                  </div>
                </dl>
              {:else}
                <p>No successful ticket observation available.</p>
              {/if}
            </div>
          {/each}
        </div>
      </details>
    {/if}
  </div>
{/if}
