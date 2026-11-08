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
  import ReportRegion from '../core/report-region.svelte';
  import ReportWorkspace from '../core/report-workspace.svelte';
  import OverviewPage from '../overview/overview-page.svelte';
  import ReportPeriodControl from '../range/report-period-control.svelte';
  import type { ReportRegionStaleness } from './report-region-staleness';

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
    fetching = pending,
    range = null,
    refreshError = null,
    sessions,
    sessionsReady,
    summary,
    staleRegions = { overview: pending, panel: pending },
    onRetryRegion = () => onRetry(),
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
    fetching?: boolean;
    range?: RangePresentation | null;
    refreshError?: string | null;
    sessions: Snippet;
    sessionsReady: boolean;
    summary: Snippet;
    staleRegions?: ReportRegionStaleness;
    onRetryRegion?: (region: 'overview' | 'panel') => Promise<void>;
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
    <ReportRegion
      kind="overview"
      onRetry={() => onRetryRegion('overview')}
      pending={fetching}
      stale={staleRegions.overview}
    >
      <OverviewPage {...overview} />
    </ReportRegion>
  {:else if activeView === 'breakdown' && breakdownReady}
    <ReportRegion kind="panel" onRetry={() => onRetryRegion('panel')} pending={fetching} stale={staleRegions.panel}>
      {@render breakdown()}
    </ReportRegion>
  {:else if activeView === 'sessions' && sessionsReady}
    <ReportRegion kind="panel" onRetry={() => onRetryRegion('panel')} pending={fetching} stale={staleRegions.panel}>
      {@render sessions()}
    </ReportRegion>
  {:else if loadFailed}
    <div class={unavailable}>
      <p role="status">Report view is temporarily unavailable.</p>
      <button class={cx(ghostButton, retryButton)} onclick={retry} type="button">Retry</button>
    </div>
  {:else}
    <p aria-live="polite" role="status">Loading report…</p>
  {/if}
</ReportWorkspace>
