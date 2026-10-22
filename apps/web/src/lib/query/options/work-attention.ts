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
 * The one query for the Work attention identity. Its only producer is the collection cycle and it
 * carries no proof with a lifetime, so it follows the collection-facts policy: revalidated on an
 * interval and on focus, and on mount only when stale. The server-rendered answer is the page
 * load's one read; a reader returning after the stale time gets a new one.
 */
export const workAttentionQueryOptions = (
  client: WorkAttentionClient,
  identity: WorkAttentionIdentity,
  context: WorkAttentionQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.collectionFactsSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) =>
      unwrapWorkAttentionResult(
        await client.attention({ limit: identity.limit, machineId: identity.machineId }, { signal }),
      ),
    queryKey: workAttentionKey(identity),
  });
