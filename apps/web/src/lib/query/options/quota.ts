import { parseProviderQuotaHistoryRequest } from '@ai-usage/report-core/provider-quota';
import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/web-contract/report';
import { keepPreviousData, type QueryClient, queryOptions } from '@tanstack/svelte-query';
import type { ReportClient } from '../../rpc/report-client';
import { finiteSwrKey } from '../keys';
import { webQueryPolicies } from '../policies';

const quotaFamily = 'quota';

export type QuotaHistoryRange = '24h' | '30d' | '7d';

export interface QuotaHistoryPolicyIdentity {
  readonly generation?: number | string;
  readonly range: QuotaHistoryRange;
}

export interface QuotaQueryExecution {
  readonly browser: boolean;
  readonly enabled: boolean;
}

export type QuotaQueryClient = Pick<ReportClient, 'getProviderQuotaHistory'>;

interface QuotaRetentionIdentity {
  readonly generation?: number | string;
  readonly machineId?: string;
  readonly maximumPoints: number;
  readonly providerKey?: string;
}

const normalizedMaximumPoints = (request: ProviderQuotaHistoryRequest): number => {
  if (request.maximumPoints === undefined) {
    throw new Error('Parsed quota history request is missing maximumPoints');
  }
  return request.maximumPoints;
};

const quotaRetentionIdentity = (
  request: ProviderQuotaHistoryRequest,
  policyIdentity: QuotaHistoryPolicyIdentity,
): QuotaRetentionIdentity => ({
  ...(policyIdentity.generation === undefined ? {} : { generation: policyIdentity.generation }),
  ...(request.machineId === undefined ? {} : { machineId: request.machineId }),
  maximumPoints: normalizedMaximumPoints(request),
  ...(request.providerKey === undefined ? {} : { providerKey: request.providerKey }),
});

const quotaRetentionScope = (identity: QuotaRetentionIdentity) =>
  [
    'provider-present',
    identity.providerKey !== undefined,
    identity.providerKey ?? '',
    'machine-present',
    identity.machineId !== undefined,
    identity.machineId ?? '',
    'maximum-points',
    identity.maximumPoints,
    'generation-present',
    identity.generation !== undefined,
    identity.generation ?? '',
  ] as const;

const isSameIdentityParts = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const isQuotaFromIdentity = (key: readonly unknown[] | undefined, identity: QuotaRetentionIdentity): boolean => {
  if (!(key?.[0] === 'web' && key[1] === 'finite-swr' && key[2] === quotaFamily)) {
    return false;
  }
  const expectedScope = quotaRetentionScope(identity);
  const previousScope = key.slice(3, 3 + expectedScope.length);
  return isSameIdentityParts(previousScope, expectedScope);
};

export const quotaHistoryKey = (request: ProviderQuotaHistoryRequest, policyIdentity: QuotaHistoryPolicyIdentity) => {
  const parsed = parseProviderQuotaHistoryRequest(request);
  const retentionIdentity = quotaRetentionIdentity(parsed, policyIdentity);
  return finiteSwrKey(
    quotaFamily,
    ...quotaRetentionScope(retentionIdentity),
    'from',
    parsed.from,
    'to',
    parsed.to,
    'range',
    policyIdentity.range,
  );
};

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
