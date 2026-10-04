import { parseSessionQueryRequest } from '@ai-usage/report-core/session-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { demoReportPayload } from '../../../../report-data';
import type { RuntimeMode } from '../../../../runtime-mode';
import { toWebReportPayload, type WebReportPayload } from '../../../../web-report-payload';
import { parseDashboardSearchUrl } from '../../../foundation/navigation/svelte/dashboard-url';
import type { WebQueryHydrationState } from '../../../query/client';
import { createWebQueryLoadState, type WebQueryRuntime, type WebQueryRuntimeOptions } from '../../../query/composition';
import type { ReportQueryClient } from '../../../query/options/report';
import { reportBootstrapQueryOptions } from '../../../query/options/report';
import { reportDestinationQueryOptions } from '../../../query/options/report-destination';
import { sessionLookupQueryOptions, sessionPageQueryOptions } from '../../../query/options/session';
import { initialSessionWindowIntent, sessionWindowView } from '../../../query/options/session-window';
import { createReportClient } from '../../../rpc/report-client';
import { createSessionClientAdapter, type SessionClientAdapter } from '../../../rpc/session-client';
import { resolveDetailSelection } from '../../sessions/detail/detail-selection';
import { sessionRouteFor } from '../../sessions/detail/session-route';
import { dashboardSearchCodec } from '../../shell/navigation';
import { createAwaitedRouteQueryState } from '../../shell/query-load';
import { campaignSessionSelectionQuery } from '../actions/campaign-session-controls-binding';
import { initialReportTimelineFor, reportDestinationForSearch } from '../composition/report-search';

export interface LiveReportPageData {
  readonly mode: 'live';
  readonly queryState: WebQueryHydrationState;
}

export interface SyntheticReportPageData {
  readonly mode: 'demo' | 'e2e';
  readonly payload: WebReportPayload;
  readonly queryState: WebQueryHydrationState;
}

export type ReportPageData = LiveReportPageData | SyntheticReportPageData;

export const deferredLiveReportQueryState = (): WebQueryHydrationState => ({
  dehydratedState: { mutations: [], queries: [] },
});

export class ReportBootstrapUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super('Report data is temporarily unavailable.');
    this.name = 'ReportBootstrapUnavailableError';
  }
}

const syntheticPayload = toWebReportPayload(demoReportPayload);

export const requireAvailableReportBootstrap = (
  result: ReportRevisionBootstrapResult,
): Extract<ReportRevisionBootstrapResult, { readonly ok: true }> => {
  if (!result.ok) {
    throw new ReportBootstrapUnavailableError();
  }
  return result;
};

/**
 * Acquires the report cache for one live request: the current-alias bootstrap plus every exact query
 * needed by the requested destination. Server-only by design — the returned state is serialised into
 * the document so hydration and the destination chunk reuse it without another data round trip.
 */
export const acquireLiveReportQueryState = async (
  options: WebQueryRuntimeOptions & { readonly pageUrl: URL },
  dependencies: {
    readonly createClient?: (rpc: Parameters<typeof createReportClient>[0]) => ReportQueryClient;
    readonly createSessionClient?: (rpc: WebQueryRuntime['rpc']) => SessionClientAdapter;
  } = {},
): Promise<WebQueryHydrationState> => {
  const { pageUrl, ...runtimeOptions } = options;
  return await createAwaitedRouteQueryState(runtimeOptions, async (runtime) => {
    const reportClient = dependencies.createClient?.(runtime.rpc) ?? createReportClient(runtime.rpc);
    const sessionClient =
      dependencies.createSessionClient?.(runtime.rpc) ?? createSessionClientAdapter(runtime.rpc.session);
    const result = await runtime.queryClient.fetchQuery(reportBootstrapQueryOptions(reportClient, { browser: false }));
    await prefetchInitialDestination(
      runtime,
      reportClient,
      sessionClient,
      requireAvailableReportBootstrap(result),
      pageUrl,
    );
  });
};

/**
 * Assembles the page data the report component tree consumes. Live mode adopts the state the server
 * `load` already acquired; synthetic modes keep their payload client-owned so demo and e2e runs are
 * served from the bundle rather than inlined into every document.
 */
export const reportPageDataFor = (
  mode: RuntimeMode,
  runtimeOptions: WebQueryRuntimeOptions,
  serverQueryState: WebQueryHydrationState | undefined,
): ReportPageData => {
  if (mode !== 'live') {
    return { mode, payload: syntheticPayload, queryState: createWebQueryLoadState(runtimeOptions) };
  }
  if (serverQueryState === undefined) {
    throw new ReportBootstrapUnavailableError();
  }
  return { mode, queryState: serverQueryState };
};

const prefetchInitialDestination = async (
  runtime: WebQueryRuntime,
  reportClient: ReportQueryClient,
  sessionClient: SessionClientAdapter,
  bootstrap: Extract<ReportRevisionBootstrapResult, { readonly ok: true }>,
  pageUrl: URL,
): Promise<void> => {
  try {
    const search = parseDashboardSearchUrl(pageUrl, dashboardSearchCodec);
    const destination = reportDestinationForSearch(
      search,
      bootstrap.bootstrap.support.generatedAt,
      initialReportTimelineFor(search.range, bootstrap.bootstrap.support.generatedAt),
    );
    const { focused } = destination;
    if (focused === null) {
      return;
    }
    const commit = await runtime.queryClient.fetchQuery(
      reportDestinationQueryOptions({ queryClient: runtime.queryClient, reportClient, sessionClient }, focused, {
        browser: false,
      }),
    );
    const route = sessionRouteFor(pageUrl.pathname);
    if (route === null) {
      return;
    }
    const selection = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: commit.overview.view.topSessions.map((item) => item.row),
      lookupRow: undefined,
      revision: commit.descriptor.revision,
      route,
      window: commit.sessions ? sessionWindowView(commit.sessions, initialSessionWindowIntent(), false) : undefined,
    });
    if (selection.kind !== 'loading') {
      return;
    }
    if (route.kind === 'session') {
      // Hydrate only the missing presentation row at the successfully acquired revision.
      // Native prompts and detail stay behind the browser's dependent detail query.
      await runtime.queryClient.fetchQuery(
        sessionLookupQueryOptions(
          sessionClient,
          { revision: commit.descriptor.revision, rowId: route.rowId },
          { browser: false },
        ),
      );
    } else {
      const query =
        commit.sessions?.query ??
        parseSessionQueryRequest({
          ...destination.sessions,
          cursor: null,
          revision: commit.descriptor.revision,
        });
      await runtime.queryClient.fetchQuery(
        sessionPageQueryOptions(
          sessionClient,
          { ...campaignSessionSelectionQuery(query, route.campaignKey), pageSize: 1 },
          { browser: false },
        ),
      );
    }
  } catch {
    return;
  }
};
