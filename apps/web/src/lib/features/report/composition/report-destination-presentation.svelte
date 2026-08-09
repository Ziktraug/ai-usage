<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const reportToolbar = css({ display: 'grid', gap: '10px' });
</script>

<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte';
  import FilterBar from '../breakdown/filter-bar.svelte';
  import ReportWorkspace from '../core/report-workspace.svelte';
  import OverviewPage from '../overview/overview-page.svelte';
  import ReportPeriodControl from '../range/report-period-control.svelte';

  type DashboardBreakdownComponent = typeof import('../breakdown/dashboard-breakdown.svelte').default;

  interface BreakdownPresentation {
    component: DashboardBreakdownComponent;
    props: ComponentProps<DashboardBreakdownComponent>;
  }

  interface RangePresentation {
    hidden: boolean;
    props: ComponentProps<typeof ReportPeriodControl>;
  }

  let {
    activeView,
    breakdown = null,
    filters,
    hasOutput,
    loadFailed,
    overview = null,
    pending,
    range = null,
    refreshError = null,
    sessions,
    sessionsReady,
    status,
    summary,
  }: {
    activeView: 'overview' | 'breakdown' | 'sessions';
    breakdown?: BreakdownPresentation | null;
    filters: ComponentProps<typeof FilterBar>;
    hasOutput: boolean;
    loadFailed: boolean;
    overview?: ComponentProps<typeof OverviewPage> | null;
    pending: boolean;
    range?: RangePresentation | null;
    refreshError?: string | null;
    sessions: Snippet;
    sessionsReady: boolean;
    status?: Snippet;
    summary: Snippet;
  } = $props();

  const workspaceProps = $derived({
    hasOutput,
    pending,
    refreshError,
    ...(status ? { status } : {}),
  });
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
  {:else if activeView === 'breakdown' && breakdown}
    {@const DashboardBreakdown = breakdown.component}
    <DashboardBreakdown {...breakdown.props} />
  {:else if activeView === 'sessions' && sessionsReady}
    {@render sessions()}
  {:else if loadFailed}
    <p role="status">Report view is temporarily unavailable.</p>
  {:else}
    <p aria-live="polite" role="status">Loading report…</p>
  {/if}
</ReportWorkspace>
