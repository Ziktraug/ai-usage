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
/** An intake decision changes no task: only the list, which carries the intake, is stale. */
export const invalidateWorkThreadListQueries = async (
  client: Pick<QueryClient, 'invalidateQueries'>,
): Promise<void> => {
  await client.invalidateQueries({ queryKey: collectionSwrKey('work-threads', 'list') });
};

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

/**
 * The task route's SSR read: every list page the URL's cursors name (so a returning operator sees
 * the same window) and the open task's detail, awaited before the page renders.
 */
export const prefetchWorkThreadRoute = async (
  queryClient: Pick<QueryClient, 'fetchQuery'>,
  client: Pick<WorkThreadsClient, 'detail' | 'list'>,
  input: {
    readonly cursors: readonly (string | null)[];
    readonly query: WorkThreadsListInput;
    readonly threadId: string | null;
  },
): Promise<void> => {
  const context = { browser: true, enabled: true };
  await Promise.all([
    ...input.cursors.map((cursor) =>
      queryClient.fetchQuery(workThreadListQueryOptions(client, { ...input.query, cursor }, context)),
    ),
    ...(input.threadId === null
      ? []
      : [queryClient.fetchQuery(workThreadDetailQueryOptions(client, input.threadId, context))]),
  ]);
};

/** Query exposes acquisition errors to the picker's own message; event handlers need no rejected promise. */
export const loadNextLinkableSessionPage = async (query: {
  readonly fetchNextPage: (options: { cancelRefetch: false; throwOnError: false }) => Promise<unknown>;
}): Promise<void> => {
  await query.fetchNextPage({ cancelRefetch: false, throwOnError: false });
};
