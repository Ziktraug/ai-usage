import { parseProviderQuotaHistoryRequest } from '@ai-usage/report-core/provider-quota';
import type { ProviderQuotaHistoryRequest } from '@ai-usage/web-contract/report';
import { finiteSwrKey } from '../keys';

const quotaFamily = 'quota';

export type QuotaHistoryRange = '24h' | '30d' | '7d';

export interface QuotaHistoryPolicyIdentity {
  readonly generation?: number | string;
  readonly range: QuotaHistoryRange;
}

export interface QuotaRetentionIdentity {
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

export const quotaRetentionIdentity = (
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

export const isQuotaFromIdentity = (key: readonly unknown[] | undefined, identity: QuotaRetentionIdentity): boolean => {
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
