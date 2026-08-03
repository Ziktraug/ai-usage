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

export interface ExactReportQueryIdentity {
  readonly fingerprint: string;
  readonly revision: string;
}

export const reportManifestKey = () => currentAliasKey(reportManifestFamily);
export const reportBootstrapKey = () => currentAliasKey(reportBootstrapFamily);

export const reportSupportKey = ({ fingerprint, revision }: ExactReportQueryIdentity) =>
  immutableRevisionKey(reportExactFamily, revision, fingerprint, 'support');

export const reportOverviewKey = ({ fingerprint, revision }: ExactReportQueryIdentity) =>
  immutableRevisionKey(reportExactFamily, revision, fingerprint, 'overview');

export const reportBreakdownKey = ({ fingerprint, revision }: ExactReportQueryIdentity) =>
  immutableRevisionKey(reportExactFamily, revision, fingerprint, 'breakdown');

export const reportManifestQueryOptions = (client: ReportClient, execution: ReportQueryExecution) =>
  queryOptions({
    ...webQueryPolicies.currentAlias,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getReportRevisionManifest({ signal }),
    queryKey: reportManifestKey(),
  });

export const reportBootstrapQueryOptions = (client: ReportClient, execution: ReportQueryExecution) =>
  queryOptions({
    ...webQueryPolicies.currentAlias,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getReportRevisionBootstrap({ signal }),
    queryKey: reportBootstrapKey(),
  });

export const reportSupportQueryOptions = (
  client: ReportClient,
  request: FocusedRevisionRequest,
  identity: ExactReportQueryIdentity,
  execution: ReportQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getFocusedReportSupport(request, { signal }),
    queryKey: reportSupportKey(identity),
  });

export const reportOverviewQueryOptions = (
  client: ReportClient,
  request: FocusedOverviewRequest,
  identity: ExactReportQueryIdentity,
  execution: ReportQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getFocusedReportOverview(request, { signal }),
    queryKey: reportOverviewKey(identity),
  });

export const reportBreakdownQueryOptions = (
  client: ReportClient,
  request: FocusedBreakdownRequest,
  identity: ExactReportQueryIdentity,
  execution: ReportQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getFocusedReportBreakdown(request, { signal }),
    queryKey: reportBreakdownKey(identity),
  });

export const invalidateCurrentReportAliases = async (client: QueryClient): Promise<void> => {
  await Promise.all([
    client.invalidateQueries({ exact: true, queryKey: reportManifestKey() }),
    client.invalidateQueries({ exact: true, queryKey: reportBootstrapKey() }),
  ]);
};
