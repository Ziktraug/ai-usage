<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const page = css({ display: 'grid', gap: '16px' });
  const twoColumns = css({
    display: 'grid',
    gap: '16px',
    gridTemplateColumns: { base: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
  });
  const advanced = css({
    display: 'grid',
    gap: '12px',
    p: '12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
  });
  const advancedHeader = css({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: '8px',
    alignItems: 'baseline',
  });
  const advancedTitle = css({ fontSize: '15px', fontWeight: 750 });
  const advancedSummary = css({ color: 'muted', fontSize: '11px' });
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
    FocusedTimelineSeries,
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
  import SessionShape from './session-shape.svelte';
  import SourceFreshness from './source-freshness.svelte';
  import type { MachineSeriesPresenter } from './timeline-model';
  import TokenAnatomy from './token-anatomy.svelte';
  import { buildOverviewMetrics, overviewHasContent } from './view-model';

  interface Props {
    activeSeriesKeys?: readonly string[];
    dimension?: TimelineDimension;
    freshness?: FocusedMachineFreshness;
    granularity?: MigrationGranularity;
    machineFreshnessStatus?: string | null;
    navigate?: SearchNavigationIntent<DashboardSearch>;
    onDimensionFilter?: (dimension: TimelineDimension, key: string) => void;
    onOpenQuotaHistory?: () => void;
    onOptionsChange?: (options: {
      dimension: TimelineDimension;
      granularity: MigrationGranularity;
      value: TimelineValue;
    }) => void;
    onRangeChange?: (range: DashboardDateRangeSearch) => void;
    onSelectDay?: (date: string) => void;
    onSelectSession?: (item: FocusedOverviewSessionItem) => void;
    onSelectTimeCell?: (cell: LocalTimeCell) => void;
    presentCampaignSeries?: (series: FocusedTimelineSeries) => FocusedTimelineSeries;
    presentMachineSeries?: MachineSeriesPresenter;
    presentSessionItem?: (item: FocusedOverviewSessionItem) => FocusedOverviewSessionItem;
    providers?: readonly ProviderStatusView[];
    range: DashboardDateRangeSearch;
    result: FocusedOverviewResult;
    value?: TimelineValue;
  }

  const unchangedCampaignSeries = (series: FocusedTimelineSeries): FocusedTimelineSeries => series;
  const unchangedMachineSeries: MachineSeriesPresenter = (_key, label) => ({ freshness: 'unavailable', label });
  const unchangedSessionItem = (item: FocusedOverviewSessionItem): FocusedOverviewSessionItem => item;

  let {
    activeSeriesKeys = [],
    dimension,
    freshness,
    granularity = 'day',
    machineFreshnessStatus = null,
    navigate,
    onDimensionFilter = () => undefined,
    onOptionsChange = () => undefined,
    onRangeChange = () => undefined,
    onOpenQuotaHistory,
    onSelectDay = () => undefined,
    onSelectSession = () => undefined,
    onSelectTimeCell = () => undefined,
    presentCampaignSeries = unchangedCampaignSeries,
    presentMachineSeries = unchangedMachineSeries,
    presentSessionItem = unchangedSessionItem,
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
      {activeSeriesKeys}
      dateDomain={result.dateDomain}
      dimension={activeDimension}
      generatedAt={result.metadata.generatedAt}
      {granularity}
      {machineFreshnessStatus}
      {navigate}
      {onDimensionFilter}
      {onOptionsChange}
      {onRangeChange}
      {presentCampaignSeries}
      {presentMachineSeries}
      {range}
      timeline={result.timeline}
      {value}
    />
    <ActivityHeatmap heatmap={result.view.heatmap} {onSelectDay} />
    <div class={twoColumns}>
      <TokenAnatomy summary={result.summary} />
      <ProviderStatus
        {...(onOpenQuotaHistory === undefined ? {} : { onOpenHistory: onOpenQuotaHistory })}
        {providers}
      />
    </div>
    <Records
      {onSelectDay}
      {onSelectSession}
      {presentSessionItem}
      records={result.view.records}
      topSessions={result.view.topSessions}
    />
    <section aria-labelledby="advanced-analysis-title" class={advanced} data-overview-advanced-analysis>
      <header class={advancedHeader}>
        <h2 class={advancedTitle} id="advanced-analysis-title">Advanced analysis</h2>
        <span class={advancedSummary}
          >{result.view.advancedSummary?.summary ?? 'Session shape and weekly/hourly activity'}</span
        >
      </header>
      {#if result.view.advancedSummary}
        <div class={twoColumns}>
          {#if result.view.advancedSummary.hasSessionShape}
            <SessionShape
              advancedSummary={result.view.advancedSummary}
              {onSelectSession}
              {presentSessionItem}
              shape={result.view.sessionShape}
            />
          {/if}
          {#if result.view.advancedSummary.hasPunchcard}
            <Punchcard {onSelectTimeCell} punchcard={result.view.punchcard} />
          {/if}
        </div>
      {:else}
        <p class={empty}>No advanced analysis is available for these filters.</p>
      {/if}
    </section>
  {:else}
    <ReportRangeControl
      {activeSeriesKeys}
      dateDomain={result.dateDomain}
      dimension={activeDimension}
      generatedAt={result.metadata.generatedAt}
      {granularity}
      {machineFreshnessStatus}
      {navigate}
      {onDimensionFilter}
      {onOptionsChange}
      {onRangeChange}
      {presentCampaignSeries}
      {presentMachineSeries}
      {range}
      timeline={result.timeline}
      {value}
    />
    <p class={empty}>No sessions match the selected report range and filters.</p>
  {/if}
</div>
