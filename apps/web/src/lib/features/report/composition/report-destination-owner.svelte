<script lang="ts">
  import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { afterNavigate } from '$app/navigation';
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
  import {
    panelOpenedFromReport,
    type SessionRoute,
    sameSessionRoute,
    sessionListUrl,
    sessionPanelHistoryState,
    sessionRouteFor,
    sessionRouteUrl,
  } from '../../sessions/detail/session-route';
  import { dashboardSearchCodec } from '../../shell/navigation';
  import { useShellNavigationOwner } from '../../shell/navigation-owner-context';
  import ReportBootstrapOverview from '../core/report-bootstrap-overview.svelte';
  import type { ReportShellModel } from '../core/report-view-model';
  import ReportWarnings from '../core/report-warnings.svelte';
  import ReportWorkspace from '../core/report-workspace.svelte';
  import LiveReportDestination from './live-report-destination.svelte';
  import { createReportNavigation } from './report-navigation';
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
  const shellNavigation = useShellNavigationOwner();
  const gotoReport = createReportNavigation({
    currentState: () => page.state,
    currentUrl: () => page.url,
    goto: shellNavigation.goto,
  });
  let navigationFailure = $state<string | null>(null);
  let browserNavigate: SearchNavigationIntent<DashboardSearch> = () => undefined;
  const navigate: SearchNavigationIntent<DashboardSearch> = (update, options) => browserNavigate(update, options);
  const search = $derived(parseDashboardSearchUrl(page.url, dashboardSearchCodec));
  // The detail panel's identity is the pathname: `/sessions/<rowId>` or `/campaigns/<key>` over the
  // same mounted report. Opening pushes one entry marked as opened from the report; browsing with
  // j/k replaces it; closing travels back to the list entry when it exists, or navigates to the list
  // URL after a direct load. History carries identity only, never row data.
  const detailRoute = $derived(sessionRouteFor(page.url.pathname));
  // Closing is a navigation, and SvelteKit resets focus after one. The reader
  // must land back where they opened the panel: the control that had focus
  // when it opened, or the row the panel was showing.
  let panelTrigger: Element | null = null;
  let pendingFocusRestore: { readonly rowId: string | null } | null = null;
  // The row the open panel shows, reported by the destination, so browser Back
  // restores focus the same way an explicit close does.
  let openRowId: string | null = null;
  let previousRoute: SessionRoute | null = null;
  let focusRestoreGeneration = 0;
  onDestroy(() => {
    focusRestoreGeneration += 1;
  });
  const rowTrigger = (rowId: string | null): HTMLElement | null => {
    if (rowId === null) {
      return null;
    }
    for (const candidate of document.querySelectorAll<HTMLElement>('[data-session-row-id]')) {
      if (candidate.dataset.sessionRowId !== rowId || candidate.getClientRects().length === 0) {
        continue;
      }
      if (candidate.matches('[data-session-index]')) {
        return candidate;
      }
      const inner = candidate.querySelector<HTMLElement>('[data-session-index]');
      if (inner && inner.getClientRects().length > 0) {
        return inner;
      }
    }
    return null;
  };
  afterNavigate(() => {
    const generation = ++focusRestoreGeneration;
    const currentRoute = sessionRouteFor(page.url.pathname);
    const closed = previousRoute !== null && currentRoute === null;
    previousRoute = currentRoute;
    const restore = pendingFocusRestore;
    pendingFocusRestore = null;
    if (currentRoute !== null || page.url.pathname !== '/' || !(restore || closed)) {
      return;
    }
    const openingTrigger = panelTrigger;
    const rowId = restore?.rowId ?? openRowId;
    panelTrigger = null;
    tick()
      .then(() => {
        if (generation !== focusRestoreGeneration || sessionRouteFor(page.url.pathname) !== null) {
          return;
        }
        // The virtual window may have replaced its rows while the detail was
        // open. Resolve the target after rendering; the stable viewport is the
        // fallback and focusing it must not move the reader's current anchor.
        const trigger =
          openingTrigger instanceof HTMLElement &&
          openingTrigger.isConnected &&
          openingTrigger.getClientRects().length > 0
            ? openingTrigger
            : (rowTrigger(rowId) ??
              document.querySelector<HTMLElement>('[data-session-surface]') ??
              document.querySelector<HTMLElement>('main h1'));
        if (trigger) {
          if (!trigger.hasAttribute('tabindex')) {
            trigger.setAttribute('tabindex', '-1');
          }
          trigger.focus({ preventScroll: true });
        }
      })
      .catch(reportNavigationFailure);
  });
  const reportNavigationFailure = (cause: unknown): void => {
    navigationFailure = cause instanceof Error ? cause.message : 'Report navigation failed.';
  };
  const changeDetailRoute = (route: SessionRoute | null, rowId: string | null = null): void => {
    if (route === null) {
      if (detailRoute === null) {
        return;
      }
      pendingFocusRestore = { rowId };
      if (panelOpenedFromReport(page.state)) {
        window.history.back();
        return;
      }
      gotoReport(sessionListUrl(page.url), { keepFocus: true, noScroll: true }).catch(reportNavigationFailure);
      return;
    }
    if (detailRoute === null) {
      const active = document.activeElement;
      panelTrigger = active === document.body ? null : active;
    }
    if (sameSessionRoute(route, detailRoute)) {
      return;
    }
    const replacing = detailRoute !== null;
    gotoReport(sessionRouteUrl(page.url, route), {
      keepFocus: true,
      noScroll: true,
      replaceState: replacing,
      state: replacing && !panelOpenedFromReport(page.state) ? page.state : sessionPanelHistoryState(page.state),
    }).catch(reportNavigationFailure);
  };
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
      goto: gotoReport,
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
    {detailRoute}
    {modelsHref}
    {navigate}
    omittedSupportItemCount={model.omittedSupportItemCount}
    onDetailRouteChange={changeDetailRoute}
    onOpenRowChange={(rowId) => (openRowId = rowId)}
    {queryClient}
    reportClient={runtime.reportClient}
    runtimeMode={mode}
    {search}
    sessionClient={runtime.sessionClient}
    warnings={model.warnings}
  />
{:else if mode !== 'live'}
  <ReportWarnings omittedSupportItemCount={model.omittedSupportItemCount} warnings={model.warnings} />
  <SyntheticReportDestination
    {detailRoute}
    {mode}
    {modelsHref}
    {navigate}
    onDetailRouteChange={changeDetailRoute}
    onOpenRowChange={(rowId) => (openRowId = rowId)}
    {queryClient}
    {search}
  />
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
