<script lang="ts">
  import type {
    FocusedOverviewResult,
    FocusedOverviewSessionItem,
    FocusedTimelineSeries,
  } from '@ai-usage/report-core/focused-report-query';
  import type { ProviderStatusView } from '../../../../provider-status-model';
  import ReportPeriodControl from '../range/report-period-control.svelte';
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

<ReportPeriodControl dateDomain={result.dateDomain} generatedAt={result.metadata.generatedAt} range={{ mode: '30d' }} />
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
    range: { mode: '30d' },
    revision: result.revision,
    timeline: result.timeline,
    value: 'cost',
  }}
  {...(presentSessionItem ? { presentSessionItem } : {})}
  range={{ mode: '30d' }}
  {result}
/>
<OverviewStatus {providers} range={{ mode: '30d' }} {result} />
