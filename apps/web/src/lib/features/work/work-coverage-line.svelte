<script lang="ts">
  import type { WorkAttentionCoverage } from '@ai-usage/report-core/work-attention';
  import { formatExactInstant, formatRelativeAge } from './work-attention-model';
  import { workCoverageLine } from './work-styles';

  let { coverage, reference, synthetic }: { coverage: WorkAttentionCoverage; reference: string; synthetic: boolean } =
    $props();
  const desktop = $derived(coverage.desktopSessions);
  const pulls = $derived(coverage.pullRequests);
  const checkouts = $derived(coverage.checkouts);
  const jira = $derived(coverage.jira);
  const hidden = $derived(coverage.window.excludedRoots);
</script>

<p class={workCoverageLine} data-work-coverage>
  {#if synthetic}
    <span>Synthetic dataset</span>
  {/if}
  <span>
    Desktop sessions:
    {#if desktop.collectedAt}
      collected
      <time datetime={desktop.collectedAt} title={formatExactInstant(desktop.collectedAt)}
        >{formatRelativeAge(desktop.collectedAt, reference)}</time
      >
      · {desktop.filesParsed} of {desktop.filesSeen} files parsed{desktop.unsupported > 0
        ? ` · ${desktop.unsupported} unsupported`
        : ''}{desktop.truncated ? ' · listing truncated' : ''}
    {:else}
      not observed
    {/if}
  </span>
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
      observed{checkouts.failed > 0 ? `, ${checkouts.failed} failed` : ''}
      <time datetime={checkouts.lastRunAt} title={formatExactInstant(checkouts.lastRunAt)}
        >{formatRelativeAge(checkouts.lastRunAt, reference)}</time
      >
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
