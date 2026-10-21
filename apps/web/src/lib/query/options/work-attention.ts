import { queryOptions } from '@tanstack/svelte-query';
import type { WorkAttentionClient } from '../../rpc/work-attention-client';
import { unwrapWorkAttentionResult, type WorkAttentionIdentity, workAttentionKey } from '../identities/work-attention';
import { webQueryPolicies } from '../policies';

export { WorkAttentionQueryError, workAttentionKey } from '../identities/work-attention';

export interface WorkAttentionQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}

/** One bounded page of ranked roots; the dataset says itself when the ranking is a selection. */
export const WORK_ATTENTION_LIMIT = 100;

export const workAttentionRequest = (machineId: string | null = null): WorkAttentionIdentity => ({
  limit: WORK_ATTENTION_LIMIT,
  machineId,
});

/**
 * The one query for the Work attention identity. Its only producer is the collection cycle, so it
 * follows the collection policy: revalidated on an interval, on focus and always on mount, which is
 * what a reader returning after hours needs without any browser-side freshness guess.
 */
export const workAttentionQueryOptions = (
  client: WorkAttentionClient,
  identity: WorkAttentionIdentity,
  context: WorkAttentionQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.collectionSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) =>
      unwrapWorkAttentionResult(
        await client.attention({ limit: identity.limit, machineId: identity.machineId }, { signal }),
      ),
    queryKey: workAttentionKey(identity),
  });
