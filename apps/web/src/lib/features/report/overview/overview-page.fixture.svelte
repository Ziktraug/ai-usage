<script lang="ts">
  import type {
    FocusedOverviewResult,
    FocusedOverviewSessionItem,
    FocusedTimelineSeries,
  } from '@ai-usage/report-core/focused-report-query';
  import type { ProviderStatusView } from '../../../../provider-status-model';
  import OverviewPage from './overview-page.svelte';
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

<OverviewPage
  {activeSeriesKeys}
  {machineFreshnessStatus}
  {...(presentCampaignSeries ? { presentCampaignSeries } : {})}
  {...(presentMachineSeries ? { presentMachineSeries } : {})}
  {...(presentSessionItem ? { presentSessionItem } : {})}
  {providers}
  range={{ mode: '30d' }}
  {result}
/>
