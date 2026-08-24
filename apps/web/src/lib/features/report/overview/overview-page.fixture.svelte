<script lang="ts">
  import type {
    FocusedOverviewResult,
    FocusedOverviewSessionItem,
    FocusedTimelineSeries,
  } from '@ai-usage/report-core/focused-report-query';
  import type { DashboardDateRangeSearch } from '../../../../dashboard-search';
  import type { ProviderStatusView } from '../../../../provider-status-model';
  import ReportPeriodControl from '../range/report-period-control.svelte';
  import OverviewPage from './overview-page.svelte';
  import type { MachineSeriesPresenter } from './timeline-model';

  const openModels = (): void => undefined;

  let {
    activeSeriesKeys = [],
    machineFreshnessStatus = null,
    presentCampaignSeries,
    presentMachineSeries,
    presentSessionItem,
    providers = [],
    range = { mode: '30d' },
    result,
    totalSessionCount = result.summary.sessionCount,
  }: {
    activeSeriesKeys?: readonly string[];
    machineFreshnessStatus?: string | null;
    presentCampaignSeries?: (series: FocusedTimelineSeries) => FocusedTimelineSeries;
    presentMachineSeries?: MachineSeriesPresenter;
    presentSessionItem?: (item: FocusedOverviewSessionItem) => FocusedOverviewSessionItem;
    providers?: readonly ProviderStatusView[];
    range?: DashboardDateRangeSearch;
    result: FocusedOverviewResult;
    totalSessionCount?: number;
  } = $props();
</script>

<ReportPeriodControl dateDomain={result.dateDomain} generatedAt={result.metadata.generatedAt} {range} />
<OverviewPage
  activity={{
    activeSeriesKeys,
    dateDomain: result.dateDomain,
    dimension: result.timeline?.dimension ?? 'harness',
    generatedAt: result.metadata.generatedAt,
    granularity: 'day',
    machineFreshnessStatus,
    ...(presentCampaignSeries ? { presentCampaignSeries } : {}),
    ...(presentMachineSeries ? { presentMachineSeries } : {}),
    range,
    revision: result.revision,
    timeline: result.timeline,
    value: 'cost',
  }}
  {...(presentSessionItem ? { presentSessionItem } : {})}
  modelsHref="?tab=models"
  onOpenModels={openModels}
  {providers}
  {range}
  {result}
  {totalSessionCount}
/>
