<script lang="ts">
  import type { FocusedOverviewResult } from '@ai-usage/report-core/focused-report-query';
  import { metricComparisonStateFor } from '../../../../dashboard-metric-model';
  import type { DashboardDateRangeSearch } from '../../../../dashboard-search';
  import type { ProviderStatusView } from '../../../../provider-status-model';
  import DashboardMetrics from './dashboard-metrics.svelte';
  import ProviderStatus from './provider-status.svelte';
  import { buildOverviewMetrics } from './view-model';

  let {
    onOpenQuotaHistory,
    providers = [],
    range,
    result,
  }: {
    onOpenQuotaHistory?: () => void;
    providers?: readonly ProviderStatusView[];
    range: DashboardDateRangeSearch;
    result: FocusedOverviewResult;
  } = $props();

  const metrics = $derived(buildOverviewMetrics(result.summary, result.view.previousSummary));
  const comparisonState = $derived(metricComparisonStateFor(range.mode, result.view.previousSummary));
</script>

<DashboardMetrics {comparisonState} {metrics} />
<ProviderStatus {...(onOpenQuotaHistory === undefined ? {} : { onOpenHistory: onOpenQuotaHistory })} {providers} />
