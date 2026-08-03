import { parseProviderQuotaHistoryRequest } from '@ai-usage/report-core/provider-quota';
import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/web-contract/report';
import { keepPreviousData, type QueryClient, queryOptions } from '@tanstack/svelte-query';
import type { ReportClient } from '../../rpc/report-client';
import {
  isQuotaFromIdentity,
  type QuotaHistoryPolicyIdentity,
  quotaHistoryKey,
  quotaRetentionIdentity,
} from '../identities/quota';
import { webQueryPolicies } from '../policies';

export { type QuotaHistoryPolicyIdentity, type QuotaHistoryRange, quotaHistoryKey } from '../identities/quota';

export interface QuotaQueryExecution {
  readonly browser: boolean;
  readonly enabled: boolean;
}

export type QuotaQueryClient = Pick<ReportClient, 'getProviderQuotaHistory'>;

export const quotaHistoryQueryOptions = (
  client: QuotaQueryClient,
  request: ProviderQuotaHistoryRequest,
  policyIdentity: QuotaHistoryPolicyIdentity,
  execution: QuotaQueryExecution,
) => {
  const parsed = parseProviderQuotaHistoryRequest(request);
  const retentionIdentity = quotaRetentionIdentity(parsed, policyIdentity);
  return queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: execution.browser && execution.enabled,
    placeholderData: (previousData, previousQuery) =>
      isQuotaFromIdentity(previousQuery?.queryKey, retentionIdentity) ? keepPreviousData(previousData) : undefined,
    queryFn: async ({ signal }) => await client.getProviderQuotaHistory(parsed, { signal }),
    queryKey: quotaHistoryKey(parsed, policyIdentity),
  });
};

export const invalidateQuotaHistory = async (
  client: QueryClient,
  request: ProviderQuotaHistoryRequest,
  policyIdentity: QuotaHistoryPolicyIdentity,
): Promise<void> => {
  await client.invalidateQueries({ exact: true, queryKey: quotaHistoryKey(request, policyIdentity) });
};

export const updateQuotaHistory = (
  client: QueryClient,
  request: ProviderQuotaHistoryRequest,
  policyIdentity: QuotaHistoryPolicyIdentity,
  value: ProviderQuotaHistoryResult,
): ProviderQuotaHistoryResult | undefined =>
  client.setQueryData<ProviderQuotaHistoryResult>(quotaHistoryKey(request, policyIdentity), value);
