<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const reportToolbar = css({ display: 'grid', gap: '10px' });
  const unavailable = css({ alignItems: 'start', display: 'grid', gap: '12px', justifyItems: 'start' });
  const retryButton = css({ minH: '44px' });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';
  import type { ComponentProps, Snippet } from 'svelte';
  import FilterBar from '../breakdown/filter-bar.svelte';
  import ReportWorkspace from '../core/report-workspace.svelte';
  import OverviewPage from '../overview/overview-page.svelte';
  import ReportPeriodControl from '../range/report-period-control.svelte';

  interface RangePresentation {
    hidden: boolean;
    props: ComponentProps<typeof ReportPeriodControl>;
  }

  let {
    activeView,
    breakdown,
    breakdownReady,
    filters,
    hasOutput,
    loadFailed,
    onRetry,
    overview = null,
    pending,
    range = null,
    refreshError = null,
    sessions,
    sessionsReady,
    summary,
  }: {
    activeView: 'overview' | 'breakdown' | 'sessions';
    breakdown: Snippet;
    breakdownReady: boolean;
    filters: ComponentProps<typeof FilterBar>;
    hasOutput: boolean;
    loadFailed: boolean;
    onRetry: () => Promise<void>;
    overview?: ComponentProps<typeof OverviewPage> | null;
    pending: boolean;
    range?: RangePresentation | null;
    refreshError?: string | null;
    sessions: Snippet;
    sessionsReady: boolean;
    summary: Snippet;
  } = $props();

  const workspaceProps = $derived({
    hasOutput,
    onRetry,
    pending,
    refreshError,
  });
  const retry = async (): Promise<void> => {
    await onRetry();
  };
</script>

<div class={reportToolbar} data-report-toolbar>
  <FilterBar {...filters} />
  {#if range}
    <div hidden={range.hidden}>
      <ReportPeriodControl {...range.props} />
    </div>
  {/if}
</div>
{@render summary()}
<ReportWorkspace {...workspaceProps}>
  {#if activeView === 'overview' && overview}
    <OverviewPage {...overview} />
  {:else if activeView === 'breakdown' && breakdownReady}
    {@render breakdown()}
  {:else if activeView === 'sessions' && sessionsReady}
    {@render sessions()}
  {:else if loadFailed}
    <div class={unavailable}>
      <p role="status">Report view is temporarily unavailable.</p>
      <button class={cx(ghostButton, retryButton)} onclick={retry} type="button">Retry</button>
    </div>
  {:else}
    <p aria-live="polite" role="status">Loading report…</p>
  {/if}
</ReportWorkspace>
