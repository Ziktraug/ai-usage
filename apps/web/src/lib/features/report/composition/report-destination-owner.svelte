<script lang="ts">
  import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { DashboardSearch } from '../../../../dashboard-search';
  import type { RuntimeMode } from '../../../../runtime-mode';
  import type { SearchNavigationIntent } from '../../../foundation/navigation/search-intent';
  import {
    createDashboardSearchNavigation,
    parseDashboardSearchUrl,
  } from '../../../foundation/navigation/svelte/dashboard-url';
  import { createSvelteNavigationPort } from '../../../foundation/navigation/svelte/navigation';
  import { createBrowserWebRpcClient } from '../../../rpc/client';
  import { createReportClient } from '../../../rpc/report-client';
  import { createSessionClientAdapter } from '../../../rpc/session-client';
  import { dashboardSearchCodec } from '../../shell/navigation';
  import ReportBootstrapOverview from '../core/report-bootstrap-overview.svelte';
  import type { ReportShellModel } from '../core/report-view-model';
  import ReportWorkspace from '../core/report-workspace.svelte';
  import LiveReportDestination from './live-report-destination.svelte';
  import SyntheticReportDestination from './synthetic-report-destination.svelte';

  let {
    liveResult,
    mode,
    model,
  }: {
    liveResult: ReportRevisionBootstrapResult | undefined;
    mode: RuntimeMode;
    model: ReportShellModel;
  } = $props();

  const queryClient = useQueryClient();
  let navigationFailure = $state<string | null>(null);
  let navigate = $state<SearchNavigationIntent<DashboardSearch>>(() => undefined);
  let runtime = $state<
    | {
        readonly reportClient: ReturnType<typeof createReportClient>;
        readonly sessionClient: ReturnType<typeof createSessionClientAdapter>;
      }
    | undefined
  >();
  const search = $derived(parseDashboardSearchUrl(page.url, dashboardSearchCodec));

  onMount(() => {
    const port = createSvelteNavigationPort({
      getCurrentUrl: () => page.url,
      goto,
      history: window.history,
      onFailure: ({ cause }) => {
        navigationFailure = cause instanceof Error ? cause.message : 'Report navigation failed.';
      },
    });
    navigate = createDashboardSearchNavigation(port, dashboardSearchCodec, ({ cause }) => {
      navigationFailure = cause instanceof Error ? cause.message : 'Report navigation failed.';
    });
    if (mode === 'live') {
      const rpc = createBrowserWebRpcClient('svelte-report-root');
      runtime = {
        reportClient: createReportClient(rpc),
        sessionClient: createSessionClientAdapter(rpc.session),
      };
    }
  });
</script>

{#if navigationFailure}
  <p aria-live="polite" role="status">{navigationFailure}</p>
{/if}

{#if mode === 'live' && liveResult?.ok && runtime}
  <LiveReportDestination
    bootstrapResult={liveResult}
    {navigate}
    {queryClient}
    reportClient={runtime.reportClient}
    runtimeMode={mode}
    {search}
    sessionClient={runtime.sessionClient}
  />
{:else if mode !== 'live'}
  <SyntheticReportDestination {mode} {navigate} {queryClient} {search} />
{:else}
  <ReportWorkspace hasOutput={model.hasReportData} pending={mode === 'live' && liveResult === undefined}>
    {#snippet children()}
      <ReportBootstrapOverview
        items={model.overviewItems}
        publicationLabel={model.publicationLabel}
        revision={model.revision}
      />
    {/snippet}
  </ReportWorkspace>
{/if}
