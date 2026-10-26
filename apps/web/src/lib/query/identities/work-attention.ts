import type { WorkAttentionInput } from '@ai-usage/web-contract/work';
import type { WorkAttentionClientResult, WorkAttentionErrorTag } from '../../rpc/work-attention-client';
import { type CollectionSwrQueryKey, collectionSwrKey } from '../keys';

export interface WorkAttentionIdentity {
  readonly limit: number;
  readonly machineId: string | null;
  readonly scope?: WorkAttentionInput['scope'];
  readonly sinceDays?: number;
}

export class WorkAttentionQueryError extends Error {
  readonly tag: WorkAttentionErrorTag;

  constructor(error: { readonly message: string; readonly tag: WorkAttentionErrorTag }) {
    super(error.message);
    this.name = 'WorkAttentionQueryError';
    this.tag = error.tag;
  }
}

export const unwrapWorkAttentionResult = (result: WorkAttentionClientResult) => {
  if (!result.ok) {
    throw new WorkAttentionQueryError(result.error);
  }
  return result.data;
};

/**
 * The Work attention dataset is produced by the engine's collection cycle (desktop metadata,
 * pull-request and checkout observations), never by a browser navigation, so it lives on the
 * collection cadence prefix. Query keys only carry scalar identity parts: the request's `limit`
 * and `machineId` are spelled out rather than nested in an object.
 */
export const workAttentionKey = ({
  limit,
  machineId,
  scope,
  sinceDays,
}: WorkAttentionIdentity): CollectionSwrQueryKey =>
  collectionSwrKey(
    'work-attention',
    'limit',
    limit,
    'machine',
    machineId ?? 'all',
    ...(scope
      ? ['scope', scope.kind, ...(scope.kind === 'checkouts' ? [...scope.checkoutPaths].sort() : [scope.projectLabel])]
      : []),
    ...(sinceDays === undefined ? [] : ['since-days', sinceDays]),
  );
