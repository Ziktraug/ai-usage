<script lang="ts">
  import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { DashboardSearch } from '../../../../dashboard-search';
  import type { RuntimeMode } from '../../../../runtime-mode';
  import type { SearchNavigationIntent } from '../../../foundation/navigation/search-intent';
  import {
    createDashboardSearchNavigation,
    dashboardUrlFor,
    parseDashboardSearchUrl,
  } from '../../../foundation/navigation/svelte/dashboard-url';
  import { createSvelteNavigationPort } from '../../../foundation/navigation/svelte/navigation';
  import { useOptionalWebQueryRpcContext } from '../../../query/rpc-context.svelte';
  import { createReportClient } from '../../../rpc/report-client';
  import { createSessionClientAdapter } from '../../../rpc/session-client';
  import { ssrUnavailableClient } from '../../../rpc/ssr-placeholder';
  import { dashboardSearchCodec } from '../../shell/navigation';
  import ReportBootstrapOverview from '../core/report-bootstrap-overview.svelte';
  import type { ReportShellModel } from '../core/report-view-model';
  import ReportWarnings from '../core/report-warnings.svelte';
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
  let browserNavigate: SearchNavigationIntent<DashboardSearch> = () => undefined;
  const navigate: SearchNavigationIntent<DashboardSearch> = (update, options) => browserNavigate(update, options);
  const search = $derived(parseDashboardSearchUrl(page.url, dashboardSearchCodec));
  const modelsHref = $derived.by((): string => {
    const modelsSearch: DashboardSearch = { ...search, tab: 'models' };
    const url = dashboardUrlFor(page.url, modelsSearch, dashboardSearchCodec);
    return `${url.pathname}${url.search}${url.hash}`;
  });
  const browserRpc = useOptionalWebQueryRpcContext()?.rpc;
  // Built eagerly rather than in onMount so the report renders during SSR too. Report owners only
  // store these clients at construction; every call site sits behind an effect or an event handler,
  // and neither runs on the server — hence the placeholder that rejects loudly if that ever changes.
  const runtime = untrack(() => {
    if (mode !== 'live') {
      return;
    }
    if (typeof globalThis.location === 'undefined') {
      return {
        reportClient: ssrUnavailableClient<ReturnType<typeof createReportClient>>('report'),
        sessionClient: ssrUnavailableClient<ReturnType<typeof createSessionClientAdapter>>('session'),
      };
    }
    if (!browserRpc) {
      throw new Error('The shared browser RPC context is unavailable.');
    }
    return {
      reportClient: createReportClient(browserRpc),
      sessionClient: createSessionClientAdapter(browserRpc.session),
    };
  });

  onMount(() => {
    const port = createSvelteNavigationPort({
      getCurrentUrl: () => page.url,
      goto,
      history: window.history,
      onFailure: ({ cause }) => {
        navigationFailure = cause instanceof Error ? cause.message : 'Report navigation failed.';
      },
    });
    browserNavigate = createDashboardSearchNavigation(port, dashboardSearchCodec, ({ cause }) => {
      navigationFailure = cause instanceof Error ? cause.message : 'Report navigation failed.';
    });
  });
</script>

{#if navigationFailure}
  <p aria-live="polite" role="status">{navigationFailure}</p>
{/if}

{#if mode === 'live' && liveResult?.ok && runtime}
  <LiveReportDestination
    bootstrapResult={liveResult}
    {modelsHref}
    {navigate}
    omittedSupportItemCount={model.omittedSupportItemCount}
    {queryClient}
    reportClient={runtime.reportClient}
    runtimeMode={mode}
    {search}
    sessionClient={runtime.sessionClient}
    warnings={model.warnings}
  />
{:else if mode !== 'live'}
  <ReportWarnings omittedSupportItemCount={model.omittedSupportItemCount} warnings={model.warnings} />
  <SyntheticReportDestination {mode} {modelsHref} {navigate} {queryClient} {search} />
{:else}
  <ReportWarnings omittedSupportItemCount={model.omittedSupportItemCount} warnings={model.warnings} />
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
