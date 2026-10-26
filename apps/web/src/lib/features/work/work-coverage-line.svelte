<script lang="ts">
  import type { WorkAttentionCoverage, WorkRoot } from '@ai-usage/report-core/work-attention';
  import {
    formatExactInstant,
    formatRelativeAge,
    workCheckoutUnreadSummary,
    workCodexCoverage,
  } from './work-attention-model';
  import { workCoverageLine } from './work-styles';

  let {
    coverage,
    reference,
    roots,
    synthetic,
  }: { coverage: WorkAttentionCoverage; reference: string; roots: readonly WorkRoot[]; synthetic: boolean } = $props();
  const hasNativeRequests = $derived(
    roots.some((root) => root.facts.some((fact) => fact.kind === 'codex-user-request')),
  );
  // Native request observations and Desktop declarations retain their own provenance.
  const codex = $derived(workCodexCoverage({ coverage, roots }));
  const desktop = $derived(coverage.desktopSessions);
  const pulls = $derived(coverage.pullRequests);
  const checkouts = $derived(coverage.checkouts);
  // The run counts what it could not read without the kinds; the shown roots' facts carry them.
  const checkoutsUnread = $derived(workCheckoutUnreadSummary(roots));
  const jira = $derived(coverage.jira);
  const hidden = $derived(coverage.window.excludedRoots);
  // What the read left out, counted: the bound keeps every session that may carry a wait.
  const unread = $derived.by(() => {
    if (desktop.sessionsRead < desktop.sessionsStored) {
      return ` · ${desktop.sessionsRead} of ${desktop.sessionsStored} stored sessions read (older ones without a wait left out)`;
    }
    return desktop.truncated ? ' · registry listing truncated' : '';
  });
  const refused = $derived(
    desktop.refusedRows > 0
      ? ` · ${desktop.refusedRows} stored ${desktop.refusedRows === 1 ? 'row' : 'rows'} refused on read`
      : '',
  );
</script>

<p class={workCoverageLine} data-work-coverage>
  {#if synthetic}
    <span>Synthetic dataset</span>
  {/if}
  <span data-work-harness-coverage="claude-desktop">
    Claude Desktop registry · declared waits:
    {#if desktop.collectedAt}
      collected
      <time datetime={desktop.collectedAt} title={formatExactInstant(desktop.collectedAt)}
        >{formatRelativeAge(desktop.collectedAt, reference)}</time
      >
      · {desktop.filesParsed} of {desktop.filesSeen} files parsed{desktop.unsupported > 0
        ? ` · ${desktop.unsupported} unsupported`
        : ''}{unread}{refused}
    {:else}
      not observed
    {/if}
  </span>
  <span data-work-harness-coverage="codex"
    >{#if hasNativeRequests}
      {codex}
    {:else}
      Codex · sessions only, no declared waits: {codex}
    {/if}</span
  >
  <span data-work-harness-coverage="other">Other harnesses: not read here</span>
  <span>
    Pull requests:
    {#if pulls.disabled}
      observation disabled
    {:else if pulls.lastRunAt}
      {pulls.observed}
      observed{pulls.failed > 0 ? `, ${pulls.failed} failed` : ''}
      <time datetime={pulls.lastRunAt} title={formatExactInstant(pulls.lastRunAt)}
        >{formatRelativeAge(pulls.lastRunAt, reference)}</time
      >
    {:else}
      not observed
    {/if}
  </span>
  <span>
    Checkouts:
    {#if checkouts.lastRunAt}
      {checkouts.observed}
      observed{checkouts.failed > 0 ? `, ${checkouts.failed} not read` : ''}
      <time datetime={checkouts.lastRunAt} title={formatExactInstant(checkouts.lastRunAt)}
        >{formatRelativeAge(checkouts.lastRunAt, reference)}</time
      >{checkoutsUnread === null ? '' : ` · ${checkoutsUnread}`}
    {:else}
      not observed
    {/if}
  </span>
  <span data-work-jira-coverage>
    Jira:
    {#if jira.disabled && jira.reason}
      {jira.reason}
    {:else if jira.disabled}
      observation disabled
    {:else if jira.lastRunAt}
      {jira.observed}
      observed{jira.failed > 0 ? `, ${jira.failed} failed` : ''}
      <time datetime={jira.lastRunAt} title={formatExactInstant(jira.lastRunAt)}
        >{formatRelativeAge(jira.lastRunAt, reference)}</time
      >
    {:else}
      not observed
    {/if}
  </span>
  {#if hidden > 0}
    <span data-work-window>
      {hidden}
      older {hidden === 1 ? 'root' : 'roots'} without pending declarations hidden ({coverage.window.sinceDays}-day
      window)
    </span>
  {/if}
</p>
