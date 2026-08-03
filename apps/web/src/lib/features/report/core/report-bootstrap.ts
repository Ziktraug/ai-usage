import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { demoReportPayload } from '../../../../report-data';
import type { RuntimeMode } from '../../../../runtime-mode';
import { toWebReportPayload, type WebReportPayload } from '../../../../web-report-payload';
import type { WebQueryHydrationState } from '../../../query/client';
import { createWebQueryLoadState, type WebQueryRuntimeOptions } from '../../../query/composition';
import type { ReportQueryClient } from '../../../query/options/report';
import { reportBootstrapQueryOptions } from '../../../query/options/report';
import { createReportClient } from '../../../rpc/report-client';
import { createAwaitedRouteQueryState } from '../../shell/query-load';

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
 * Creates request-owned report page data. Synthetic modes branch before any
 * report RPC adapter is constructed, while live mode awaits the current alias
 * under the same query options used by the hydrated component.
 */
export const loadReportPageData = async (
  options: WebQueryRuntimeOptions & { readonly mode: RuntimeMode },
  dependencies: { readonly createClient?: (rpc: Parameters<typeof createReportClient>[0]) => ReportQueryClient } = {},
): Promise<ReportPageData> => {
  const { mode, ...runtimeOptions } = options;
  if (mode !== 'live') {
    return {
      mode,
      payload: syntheticPayload,
      queryState: createWebQueryLoadState(runtimeOptions),
    };
  }

  const queryState = await createAwaitedRouteQueryState(runtimeOptions, async (runtime) => {
    const reportClient = dependencies.createClient?.(runtime.rpc) ?? createReportClient(runtime.rpc);
    const result = await runtime.queryClient.fetchQuery(reportBootstrapQueryOptions(reportClient, { browser: false }));
    requireAvailableReportBootstrap(result);
  });

  return { mode, queryState };
};
