import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/web-contract/report';
import { keepPreviousData, type QueryClient, queryOptions } from '@tanstack/svelte-query';
import type { ReportClient } from '../../rpc/report-client';
import { finiteSwrKey } from '../keys';
import { webQueryPolicies } from '../policies';

const quotaFamily = 'quota';

export type QuotaHistoryRange = '24h' | '30d' | '7d';

export interface QuotaHistoryIdentity {
  readonly generation?: number | string;
  readonly provider: string;
  readonly range: QuotaHistoryRange;
}

export interface QuotaQueryExecution {
  readonly browser: boolean;
  readonly enabled: boolean;
}

const isQuotaFromIdentity = (key: readonly unknown[] | undefined, identity: QuotaHistoryIdentity): boolean =>
  key?.[0] === 'web' &&
  key[1] === 'finite-swr' &&
  key[2] === quotaFamily &&
  key[3] === identity.provider &&
  key[5] === identity.generation;

export const quotaHistoryKey = ({ generation, provider, range }: QuotaHistoryIdentity) =>
  generation === undefined
    ? finiteSwrKey(quotaFamily, provider, range)
    : finiteSwrKey(quotaFamily, provider, range, generation);

export const quotaHistoryQueryOptions = (
  client: ReportClient,
  request: ProviderQuotaHistoryRequest,
  identity: QuotaHistoryIdentity,
  execution: QuotaQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: execution.browser && execution.enabled,
    placeholderData: (previousData, previousQuery) =>
      isQuotaFromIdentity(previousQuery?.queryKey, identity) ? keepPreviousData(previousData) : undefined,
    queryFn: async ({ signal }) => await client.getProviderQuotaHistory(request, { signal }),
    queryKey: quotaHistoryKey(identity),
  });

export const invalidateQuotaHistory = async (client: QueryClient, identity: QuotaHistoryIdentity): Promise<void> => {
  await client.invalidateQueries({ exact: true, queryKey: quotaHistoryKey(identity) });
};

export const updateQuotaHistory = (
  client: QueryClient,
  identity: QuotaHistoryIdentity,
  value: ProviderQuotaHistoryResult,
): ProviderQuotaHistoryResult | undefined =>
  client.setQueryData<ProviderQuotaHistoryResult>(quotaHistoryKey(identity), value);
