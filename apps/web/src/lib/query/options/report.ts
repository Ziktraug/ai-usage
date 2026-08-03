import {
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
  parseFocusedBreakdownRequest,
  parseFocusedOverviewRequest,
  parseFocusedRevisionRequest,
} from '@ai-usage/report-core/focused-report-query';
import type {
  FocusedBreakdownRequest,
  FocusedOverviewRequest,
  FocusedRevisionRequest,
} from '@ai-usage/web-contract/report';
import { type QueryClient, queryOptions } from '@tanstack/svelte-query';
import type { ReportClient } from '../../rpc/report-client';
import { immutableRevisionKey } from '../keys';
import { webQueryPolicies } from '../policies';
import { currentReportAliasKeys } from '../publication';

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

export const reportManifestKey = () => currentReportAliasKeys()[0];
export const reportBootstrapKey = () => currentReportAliasKeys()[1];

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
) => {
  const parsed = parseFocusedRevisionRequest(request);
  return queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getFocusedReportSupport(parsed, { signal }),
    queryKey: reportSupportKey(parsed),
  });
};

export const reportOverviewQueryOptions = (
  client: ReportQueryClient,
  request: FocusedOverviewRequest,
  execution: ReportQueryExecution,
) => {
  const parsed = parseFocusedOverviewRequest(request);
  return queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getFocusedReportOverview(parsed, { signal }),
    queryKey: reportOverviewKey(parsed),
  });
};

export const reportBreakdownQueryOptions = (
  client: ReportQueryClient,
  request: FocusedBreakdownRequest,
  execution: ReportQueryExecution,
) => {
  const parsed = parseFocusedBreakdownRequest(request);
  return queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getFocusedReportBreakdown(parsed, { signal }),
    queryKey: reportBreakdownKey(parsed),
  });
};

export const invalidateCurrentReportAliases = async (client: QueryClient): Promise<void> => {
  await Promise.all(
    currentReportAliasKeys().map(async (queryKey) => {
      await client.invalidateQueries({ exact: true, queryKey });
    }),
  );
};
