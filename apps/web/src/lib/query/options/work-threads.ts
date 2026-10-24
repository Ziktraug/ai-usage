import type { WorkThreadsListInput } from '@ai-usage/web-contract/work-threads';
import { type QueryClient, queryOptions } from '@tanstack/svelte-query';
import type { WorkThreadsClient } from '../../rpc/work-threads-client';
import { collectionSwrKey } from '../keys';
import { webQueryPolicies } from '../policies';

export interface WorkThreadsQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}
export const workThreadListKey = (query: WorkThreadsListInput) =>
  collectionSwrKey(
    'work-threads',
    'list',
    JSON.stringify([query.tab, query.project, query.search, query.limit, query.cursor]),
  );
export const workThreadDetailKey = (threadId: string) => collectionSwrKey('work-threads', 'detail', threadId);
export const workThreadListQueryOptions = (
  client: Pick<WorkThreadsClient, 'list'>,
  input: WorkThreadsListInput,
  context: WorkThreadsQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.collectionFactsSwr,
    enabled: context.browser && context.enabled,
    queryKey: workThreadListKey(input),
    queryFn: ({ signal }) => client.list(input, { signal }),
  });
export const workThreadDetailQueryOptions = (
  client: Pick<WorkThreadsClient, 'detail'>,
  threadId: string,
  context: WorkThreadsQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.collectionFactsSwr,
    enabled: context.browser && context.enabled,
    queryKey: workThreadDetailKey(threadId),
    queryFn: ({ signal }) => client.detail({ threadId }, { signal }),
  });
/** Also use on revision conflict: the operator must decide against the refreshed revision. */
export const invalidateWorkThreadQueries = async (
  client: Pick<QueryClient, 'invalidateQueries'>,
  threadId: string,
): Promise<void> => {
  await Promise.all([
    client.invalidateQueries({ queryKey: collectionSwrKey('work-threads', 'list') }),
    client.invalidateQueries({ queryKey: workThreadDetailKey(threadId) }),
  ]);
};
