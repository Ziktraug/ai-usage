<script lang="ts">
  import { page, shell } from '@ai-usage/design-system/svelte';
  import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
  import { browser } from '$app/environment';
  import ReportDestinationOwner from '../composition/report-destination-owner.svelte';
  import type { ReportPageData } from './report-bootstrap';
  import ReportHeader from './report-header.svelte';
  import { createHydratedReportBootstrapQuery } from './report-query.svelte';
  import { liveReportShellModel, syntheticReportShellModel } from './report-view-model';
  import ReportWarnings from './report-warnings.svelte';

  let { data }: { data: ReportPageData } = $props();
  const liveQuery = createHydratedReportBootstrapQuery(() => browser && data.mode === 'live');
  const liveResult = $derived(liveQuery.data as ReportRevisionBootstrapResult | undefined);
  const model = $derived(
    data.mode === 'live' ? liveReportShellModel(liveResult) : syntheticReportShellModel(data.mode, data.payload),
  );
</script>

<main class={page} data-route-shell="report">
  <div class={shell}>
    <ReportHeader generatedAt={model.generatedAt} hasReportData={model.hasReportData} isDemo={model.isDemo} />
    <ReportWarnings omittedSupportItemCount={model.omittedSupportItemCount} warnings={model.warnings} />
    <ReportDestinationOwner {liveResult} mode={data.mode} {model} />
  </div>
</main>
