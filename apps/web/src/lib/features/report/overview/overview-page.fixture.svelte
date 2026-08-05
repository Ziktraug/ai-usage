<script lang="ts">
  import type {
    FocusedOverviewResult,
    FocusedOverviewSessionItem,
    FocusedTimelineSeries,
  } from '@ai-usage/report-core/focused-report-query';
  import type { ProviderStatusView } from '../../../../provider-status-model';
  import ReportRangeControl from '../range/report-range-control.svelte';
  import OverviewPage from './overview-page.svelte';
  import OverviewStatus from './overview-status.svelte';
  import type { MachineSeriesPresenter } from './timeline-model';

  let {
    activeSeriesKeys = [],
    machineFreshnessStatus = null,
    presentCampaignSeries,
    presentMachineSeries,
    presentSessionItem,
    providers = [],
    result,
  }: {
    activeSeriesKeys?: readonly string[];
    machineFreshnessStatus?: string | null;
    presentCampaignSeries?: (series: FocusedTimelineSeries) => FocusedTimelineSeries;
    presentMachineSeries?: MachineSeriesPresenter;
    presentSessionItem?: (item: FocusedOverviewSessionItem) => FocusedOverviewSessionItem;
    providers?: readonly ProviderStatusView[];
    result: FocusedOverviewResult;
  } = $props();
</script>

<ReportRangeControl
  {activeSeriesKeys}
  {machineFreshnessStatus}
  {...(presentCampaignSeries ? { presentCampaignSeries } : {})}
  {...(presentMachineSeries ? { presentMachineSeries } : {})}
  dateDomain={result.dateDomain}
  dimension={result.timeline?.dimension ?? 'harness'}
  generatedAt={result.metadata.generatedAt}
  granularity="day"
  range={{ mode: '30d' }}
  timeline={result.timeline}
  value="cost"
/>
<OverviewPage
  {activeSeriesKeys}
  {machineFreshnessStatus}
  {...(presentCampaignSeries ? { presentCampaignSeries } : {})}
  {...(presentMachineSeries ? { presentMachineSeries } : {})}
  {...(presentSessionItem ? { presentSessionItem } : {})}
  range={{ mode: '30d' }}
  {result}
/>
<OverviewStatus {providers} range={{ mode: '30d' }} {result} />
