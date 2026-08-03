<script lang="ts">
  import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
  import { browser } from '$app/environment';
  import type { ReportPageData } from './report-bootstrap';
  import ReportBootstrapOverview from './report-bootstrap-overview.svelte';
  import ReportHeader from './report-header.svelte';
  import { createHydratedReportBootstrapQuery } from './report-query.svelte';
  import { liveReportShellModel, syntheticReportShellModel } from './report-view-model';
  import ReportWarnings from './report-warnings.svelte';
  import ReportWorkspace from './report-workspace.svelte';

  let { data }: { data: ReportPageData } = $props();
  const liveQuery = createHydratedReportBootstrapQuery(() => browser && data.mode === 'live');
  const liveResult = $derived(liveQuery.data as ReportRevisionBootstrapResult | undefined);
  const model = $derived(
    data.mode === 'live' ? liveReportShellModel(liveResult) : syntheticReportShellModel(data.mode, data.payload),
  );
  const pending = $derived(data.mode === 'live' && liveQuery.isPending);
  const refreshError = $derived(
    data.mode === 'live' && liveQuery.isError && model.hasReportData
      ? 'The report could not be refreshed. Showing the last complete report.'
      : null,
  );
</script>

<ReportHeader generatedAt={model.generatedAt} hasReportData={model.hasReportData} isDemo={model.isDemo} />
<ReportWarnings omittedSupportItemCount={model.omittedSupportItemCount} warnings={model.warnings} />
<ReportWorkspace hasOutput={model.hasReportData} {pending} {refreshError}>
  {#snippet children()}
    <ReportBootstrapOverview
      items={model.overviewItems}
      publicationLabel={model.publicationLabel}
      revision={model.revision}
    />
  {/snippet}
</ReportWorkspace>
