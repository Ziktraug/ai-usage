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
import { createReportClient } from '../../../rpc/report-client';
import { createSessionClientAdapter, type SessionClientAdapter } from '../../../rpc/session-client';
import { dashboardSearchCodec } from '../../shell/navigation';
import { createAwaitedRouteQueryState } from '../../shell/query-load';
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
    const { focused } = reportDestinationForSearch(
      search,
      bootstrap.bootstrap.support.generatedAt,
      initialReportTimelineFor(search.range, bootstrap.bootstrap.support.generatedAt),
    );
    if (focused === null) {
      return;
    }
    await runtime.queryClient.fetchQuery(
      reportDestinationQueryOptions({ queryClient: runtime.queryClient, reportClient, sessionClient }, focused, {
        browser: false,
      }),
    );
  } catch {
    return;
  }
};
