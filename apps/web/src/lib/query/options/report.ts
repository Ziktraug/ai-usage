import { type CampaignLabelOverrideMutation, parseCampaignLabelOverrides } from '@ai-usage/report-core/campaign-label';
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
  SaveProjectGroupsInput,
} from '@ai-usage/web-contract/report';
import { mutationOptions, type QueryClient, queryOptions } from '@tanstack/svelte-query';
import type { ReportClient } from '../../rpc/report-client';
import { finiteSwrKey, immutableRevisionKey } from '../keys';
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

export type ReportMutationClient = Pick<
  ReportClient,
  'getCampaignLabelOverrides' | 'saveProjectGroups' | 'setCampaignLabelOverride'
>;

export const reportManifestKey = () => currentReportAliasKeys()[0];
export const reportBootstrapKey = () => currentReportAliasKeys()[1];
export const campaignLabelOverridesKey = () => finiteSwrKey('campaign-label-overrides');

export const reportSupportKey = (request: FocusedRevisionRequest) =>
  immutableRevisionKey(reportExactFamily, request.revision, focusedRevisionFingerprint('support', request), 'support');

export const reportOverviewKey = (request: FocusedOverviewRequest) =>
  immutableRevisionKey(reportExactFamily, request.query.revision, focusedOverviewFingerprint(request), 'overview');

export const reportBreakdownKey = (request: FocusedBreakdownRequest) =>
  immutableRevisionKey(reportExactFamily, request.query.revision, focusedBreakdownFingerprint(request), 'breakdown');

export const campaignLabelOverridesQueryOptions = (
  client: Pick<ReportMutationClient, 'getCampaignLabelOverrides'>,
  execution: ReportQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: execution.browser,
    queryFn: async ({ signal }) =>
      parseCampaignLabelOverrides((await client.getCampaignLabelOverrides({ signal })).campaignLabelOverrides),
    queryKey: campaignLabelOverridesKey(),
  });

export const reportManifestQueryOptions = (client: ReportQueryClient, execution: ReportQueryExecution) =>
  queryOptions({
    ...webQueryPolicies.currentAliasSwr,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.getReportRevisionManifest({ signal }),
    queryKey: reportManifestKey(),
  });

export const reportBootstrapQueryOptions = (client: ReportQueryClient, execution: ReportQueryExecution) =>
  queryOptions({
    ...webQueryPolicies.currentAliasSwr,
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

export const fetchReportBreakdown = async (
  queryClient: QueryClient,
  client: ReportQueryClient,
  request: FocusedBreakdownRequest,
) => await queryClient.fetchQuery(reportBreakdownQueryOptions(client, request, { browser: true }));

export const setCampaignLabelOverrideMutationOptions = (
  client: Pick<ReportMutationClient, 'setCampaignLabelOverride'>,
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: async (input: CampaignLabelOverrideMutation) =>
      parseCampaignLabelOverrides((await client.setCampaignLabelOverride(input)).campaignLabelOverrides),
    mutationKey: ['web', 'mutation', 'campaign-label-override'],
    onSuccess: (overrides) => {
      queryClient.setQueryData(campaignLabelOverridesKey(), overrides);
    },
    retry: false,
  });

export const saveProjectGroupsMutationOptions = (
  client: Pick<ReportMutationClient, 'saveProjectGroups'>,
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: async (input: SaveProjectGroupsInput) => await client.saveProjectGroups(input),
    mutationKey: ['web', 'mutation', 'project-groups'],
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['web', 'current-alias'] });
    },
    retry: false,
  });

export const invalidateCurrentReportAliases = async (client: QueryClient): Promise<void> => {
  await Promise.all(
    currentReportAliasKeys().map(async (queryKey) => {
      await client.invalidateQueries({ exact: true, queryKey });
    }),
  );
};
