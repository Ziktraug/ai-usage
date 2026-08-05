<script lang="ts" module>
  import {
    advancedAnalysis,
    advancedAnalysisContent,
    advancedAnalysisHeader,
    advancedAnalysisHeaderText,
    emptyPanel,
    overviewGrid,
    twoColumns,
  } from '@ai-usage/design-system/report';
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
  import ActivityHeatmap from './activity-heatmap.svelte';
  import DashboardMetrics from './dashboard-metrics.svelte';
  import OverviewHero from './overview-hero.svelte';
  import ProviderStatus from './provider-status.svelte';
  import Punchcard from './punchcard.svelte';
  import Records from './records.svelte';
  import SessionShape from './session-shape.svelte';
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

<div class={overviewGrid} data-report-overview data-report-revision={result.revision}>
  {#if overviewHasContent(result)}
    <OverviewHero {range} summary={result.summary} />
    <ActivityHeatmap heatmap={result.view.heatmap} {onSelectDay} />
    <TokenAnatomy summary={result.summary} />
    <Records
      {onSelectDay}
      {onSelectSession}
      {presentSessionItem}
      records={result.view.records}
      topSessions={result.view.topSessions}
    />
    <section aria-labelledby="advanced-analysis-title" class={advancedAnalysis} data-overview-advanced-analysis>
      <header class={advancedAnalysisHeader}>
        <h2 id="advanced-analysis-title">Advanced analysis</h2>
        <span class={advancedAnalysisHeaderText}
          >{result.view.advancedSummary?.summary ?? 'Session shape and weekly/hourly activity'}</span
        >
      </header>
      <div class={advancedAnalysisContent}>
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
          <p class={emptyPanel}>No advanced analysis is available for these filters.</p>
        {/if}
      </div>
    </section>
    <DashboardMetrics {comparisonState} {metrics} />
    <ProviderStatus {...(onOpenQuotaHistory === undefined ? {} : { onOpenHistory: onOpenQuotaHistory })} {providers} />
  {:else}
    <p class={emptyPanel}>No sessions match the selected report range and filters.</p>
  {/if}
</div>
