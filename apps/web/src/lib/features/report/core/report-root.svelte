<script lang="ts">
  import { page, shell } from '@ai-usage/design-system/svelte';
  import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import ReportDestinationOwner from '../composition/report-destination-owner.svelte';
  import type { ReportPageData } from './report-bootstrap';
  import ReportHeader from './report-header.svelte';
  import { provideReportIdentityChannel } from './report-identity-context.svelte';
  import { createHydratedReportBootstrapQuery } from './report-query.svelte';
  import { liveReportShellModel, syntheticReportShellModel } from './report-view-model';

  let { data }: { data: ReportPageData } = $props();
  let hydrated = $state(false);
  let reportElement = $state<HTMLElement>();
  provideReportIdentityChannel((identity) => {
    if (!reportElement) {
      return;
    }
    if (!identity) {
      reportElement.removeAttribute('data-report-revision');
      reportElement.removeAttribute('data-request-fingerprint');
      return;
    }
    reportElement.setAttribute('data-report-revision', identity.revision);
    reportElement.setAttribute('data-request-fingerprint', identity.requestFingerprint);
  });
  onMount(() => {
    hydrated = true;
  });
  const liveQuery = createHydratedReportBootstrapQuery(() => browser && data.mode === 'live');
  const liveResult = $derived(liveQuery.data as ReportRevisionBootstrapResult | undefined);
  const model = $derived(
    data.mode === 'live' ? liveReportShellModel(liveResult) : syntheticReportShellModel(data.mode, data.payload),
  );
</script>

<main class={page} data-hydrated={hydrated ? 'true' : 'false'} data-route-shell="report" bind:this={reportElement}>
  <div class={shell}>
    <ReportHeader generatedAt={model.generatedAt} hasReportData={model.hasReportData} isDemo={model.isDemo} />
    <ReportDestinationOwner {liveResult} mode={data.mode} {model} />
  </div>
</main>
