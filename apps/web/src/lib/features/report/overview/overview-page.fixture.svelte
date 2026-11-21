<script lang="ts">
  import type {
    FocusedOverviewResult,
    FocusedOverviewSessionItem,
    FocusedTimelineSeries,
  } from '@ai-usage/report-core/focused-report-query';
  import type { DashboardDateRangeSearch } from '../../../foundation/dashboard/dashboard-search';
  import type { ProviderStatusView } from '../provider-status-model';
  import ReportPeriodControl from '../range/report-period-control.svelte';
  import OverviewPage from './overview-page.svelte';
  import { type OverviewResultScope, overviewResultScope, queriedRangeFor } from './overview-result-scope';
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
    resultScope,
    totalSessionCount = result.summary.sessionCount,
  }: {
    activeSeriesKeys?: readonly string[];
    machineFreshnessStatus?: string | null;
    presentCampaignSeries?: (series: FocusedTimelineSeries) => FocusedTimelineSeries;
    presentMachineSeries?: MachineSeriesPresenter;
    presentSessionItem?: (item: FocusedOverviewSessionItem) => FocusedOverviewSessionItem;
    providers?: readonly ProviderStatusView[];
    /** The selection in the URL. */
    range?: DashboardDateRangeSearch;
    result: FocusedOverviewResult;
    /** What `result` answers; by default the URL selection without filters. */
    resultScope?: OverviewResultScope;
    totalSessionCount?: number;
  } = $props();

  const requestedRange = $derived(queriedRangeFor(range, new Date(result.metadata.generatedAt)));
  const scope = $derived(
    resultScope ??
      overviewResultScope({
        answered: { filters: { fields: {}, harness: [], machine: [], origin: [], query: '' }, range: requestedRange },
        queryGeneratedAt: result.metadata.generatedAt,
        requested: { range: requestedRange, selection: range },
        revisionDateDomain: result.dateDomain,
      }),
  );
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
  {...presentSessionItem ? { presentSessionItem } : {}}
  modelsHref="?tab=models"
  onOpenModels={openModels}
  {providers}
  {result}
  resultScope={scope}
  {totalSessionCount}
/>
