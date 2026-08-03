import {
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
} from '@ai-usage/report-core/focused-report-query';
import type {
  FocusedBreakdownRequest,
  FocusedOverviewRequest,
  FocusedRevisionRequest,
} from '@ai-usage/web-contract/report';
import { type QueryClient, queryOptions } from '@tanstack/svelte-query';
import type { ReportClient } from '../../rpc/report-client';
import { currentAliasKey, immutableRevisionKey } from '../keys';
import { webQueryPolicies } from '../policies';

const reportManifestFamily = 'report-manifest';
const reportBootstrapFamily = 'report-bootstrap';
const reportExactFamily = 'report';

export interface ReportQueryExecution {
  readonly browser: boolean;
}

export type ReportQueryClient = Pick<
  ReportClient,
  | 'getFocusedReportBreakdown'
  | 'getFocusedReportOverview'
  | 'getFocusedReportSupport'
  | 'getReportRevisionBootstrap'
  | 'getReportRevisionManifest'
>;

export const reportManifestKey = () => currentAliasKey(reportManifestFamily);
export const reportBootstrapKey = () => currentAliasKey(reportBootstrapFamily);

export const reportSupportKey = (request: FocusedRevisionRequest) =>
  immutableRevisionKey(reportExactFamily, request.revision, focusedRevisionFingerprint('support', request), 'support');

export const reportOverviewKey = (request: FocusedOverviewRequest) =>
  immutableRevisionKey(reportExactFamily, request.query.revision, focusedOverviewFingerprint(request), 'overview');

export const reportBreakdownKey = (request: FocusedBreakdownRequest) =>
  immutableRevisionKey(reportExactFamily, request.query.revision, focusedBreakdownFingerprint(request), 'breakdown');

export const reportManifestQueryOptions = (client: ReportQueryClient, execution: ReportQueryExecution) =>
  queryOptions({
    ...webQueryPolicies.currentAlias,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getReportRevisionManifest({ signal }),
    queryKey: reportManifestKey(),
  });

export const reportBootstrapQueryOptions = (client: ReportQueryClient, execution: ReportQueryExecution) =>
  queryOptions({
    ...webQueryPolicies.currentAlias,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getReportRevisionBootstrap({ signal }),
    queryKey: reportBootstrapKey(),
  });

export const reportSupportQueryOptions = (
  client: ReportQueryClient,
  request: FocusedRevisionRequest,
  execution: ReportQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getFocusedReportSupport(request, { signal }),
    queryKey: reportSupportKey(request),
  });

export const reportOverviewQueryOptions = (
  client: ReportQueryClient,
  request: FocusedOverviewRequest,
  execution: ReportQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getFocusedReportOverview(request, { signal }),
    queryKey: reportOverviewKey(request),
  });

export const reportBreakdownQueryOptions = (
  client: ReportQueryClient,
  request: FocusedBreakdownRequest,
  execution: ReportQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getFocusedReportBreakdown(request, { signal }),
    queryKey: reportBreakdownKey(request),
  });

export const invalidateCurrentReportAliases = async (client: QueryClient): Promise<void> => {
  await Promise.all([
    client.invalidateQueries({ exact: true, queryKey: reportManifestKey() }),
    client.invalidateQueries({ exact: true, queryKey: reportBootstrapKey() }),
  ]);
};
