import { isWorkThreadId } from '@ai-usage/report-core/work-thread';
import type { RuntimeMode } from '../../../runtime-mode';
import type { WebQueryHydrationState } from '../../query/client';
import type { WebQueryRuntime } from '../../query/composition';
import { prefetchWorkThreadRoute } from '../../query/options/work-threads';
import { createWorkThreadsClient } from '../../rpc/work-threads-client';
import { createAwaitedRouteQueryState, type RouteQueryLoadOptions } from '../shell/query-load';
import { threadListQuery, threadPageCursors } from './work-thread-model';

export interface ThreadPageData {
  readonly mode: RuntimeMode;
  readonly queryState: WebQueryHydrationState;
}

export const deferredThreadPageData = (mode: RuntimeMode): ThreadPageData => ({
  mode,
  queryState: { dehydratedState: { queries: [], mutations: [] } },
});

export const loadThreadPageData = async (
  options: RouteQueryLoadOptions,
  mode: RuntimeMode,
): Promise<ThreadPageData> => {
  const queryState = await createAwaitedRouteQueryState(options, (runtime) =>
    prefetchThreadsRoute(runtime, options.url),
  );
  return { mode, queryState };
};

export const prefetchThreadsRoute = async (runtime: WebQueryRuntime, url: URL): Promise<void> => {
  const client = createWorkThreadsClient(runtime.rpc.workThreads);
  const task = url.searchParams.get('task');
  await prefetchWorkThreadRoute(runtime.queryClient, client, {
    cursors: threadPageCursors(url.searchParams),
    query: threadListQuery(url.searchParams),
    threadId: isWorkThreadId(task) ? task : null,
  });
};
