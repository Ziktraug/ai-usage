<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const page = css({ display: 'grid', gap: '16px' });
  const twoColumns = css({
    display: 'grid',
    gap: '16px',
    gridTemplateColumns: { base: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
  });
  const empty = css({
    p: '24px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    color: 'muted',
    textAlign: 'center',
  });
</script>

<script lang="ts">
  import type {
    FocusedMachineFreshness,
    FocusedOverviewResult,
    FocusedOverviewSessionItem,
  } from '@ai-usage/report-core/focused-report-query';
  import type { LocalTimeCell } from '@ai-usage/report-core/session-query';
  import { metricComparisonStateFor } from '../../../../dashboard-metric-model';
  import type { DashboardDateRangeSearch, DashboardSearch } from '../../../../dashboard-search';
  import type { MigrationGranularity, TimelineDimension, TimelineValue } from '../../../../overview-model';
  import type { ProviderStatusView } from '../../../../provider-status-model';
  import type { SearchNavigationIntent } from '../../../foundation/navigation/search-intent';
  import ReportRangeControl from '../range/report-range-control.svelte';
  import ActivityHeatmap from './activity-heatmap.svelte';
  import DashboardMetrics from './dashboard-metrics.svelte';
  import OverviewHero from './overview-hero.svelte';
  import ProviderStatus from './provider-status.svelte';
  import Punchcard from './punchcard.svelte';
  import Records from './records.svelte';
  import SourceFreshness from './source-freshness.svelte';
  import TokenAnatomy from './token-anatomy.svelte';
  import { buildOverviewMetrics, overviewHasContent } from './view-model';

  interface Props {
    dimension?: TimelineDimension;
    freshness?: FocusedMachineFreshness;
    granularity?: MigrationGranularity;
    navigate?: SearchNavigationIntent<DashboardSearch>;
    onOptionsChange?: (options: {
      dimension: TimelineDimension;
      granularity: MigrationGranularity;
      value: TimelineValue;
    }) => void;
    onRangeChange?: (range: DashboardDateRangeSearch) => void;
    onSelectDay?: (date: string) => void;
    onSelectSession?: (item: FocusedOverviewSessionItem) => void;
    onSelectTimeCell?: (cell: LocalTimeCell) => void;
    providers?: readonly ProviderStatusView[];
    range: DashboardDateRangeSearch;
    result: FocusedOverviewResult;
    value?: TimelineValue;
  }

  let {
    dimension,
    freshness,
    granularity = 'day',
    navigate,
    onOptionsChange = () => undefined,
    onRangeChange = () => undefined,
    onSelectDay = () => undefined,
    onSelectSession = () => undefined,
    onSelectTimeCell = () => undefined,
    providers = [],
    range,
    result,
    value = 'cost',
  }: Props = $props();

  const metrics = $derived(buildOverviewMetrics(result.summary, result.view.previousSummary));
  const comparisonState = $derived(metricComparisonStateFor(range.mode, result.view.previousSummary));
  const activeDimension = $derived(dimension ?? result.timeline?.dimension ?? 'harness');
</script>

<div class={page} data-report-overview data-report-revision={result.revision}>
  <SourceFreshness {freshness} />
  {#if overviewHasContent(result)}
    <OverviewHero summary={result.summary} />
    <DashboardMetrics {comparisonState} {metrics} />
    <ReportRangeControl
      dateDomain={result.dateDomain}
      dimension={activeDimension}
      generatedAt={result.metadata.generatedAt}
      {granularity}
      {navigate}
      {onOptionsChange}
      {onRangeChange}
      {range}
      timeline={result.timeline}
      {value}
    />
    <div class={twoColumns}>
      <ActivityHeatmap heatmap={result.view.heatmap} {onSelectDay} />
      <Punchcard {onSelectTimeCell} punchcard={result.view.punchcard} />
    </div>
    <div class={twoColumns}>
      <TokenAnatomy summary={result.summary} />
      <ProviderStatus {providers} />
    </div>
    <Records {onSelectDay} {onSelectSession} records={result.view.records} topSessions={result.view.topSessions} />
  {:else}
    <p class={empty}>No sessions match the selected report range and filters.</p>
  {/if}
</div>
