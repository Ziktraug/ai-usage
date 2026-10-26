import { isWorkThreadId } from '@ai-usage/report-core/work-thread';
import type { RuntimeMode } from '../../../runtime-mode';
import type { WebQueryHydrationState } from '../../query/client';
import type { WebQueryRuntimeOptions } from '../../query/composition';
import { prefetchWorkThreadRoute } from '../../query/options/work-threads';
import { createWorkThreadsClient } from '../../rpc/work-threads-client';
import { createAwaitedRouteQueryState } from '../shell/query-load';
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
  options: WebQueryRuntimeOptions,
  mode: RuntimeMode,
): Promise<ThreadPageData> => {
  const queryState = await createAwaitedRouteQueryState(options, async (runtime) => {
    const client = createWorkThreadsClient(runtime.rpc.workThreads);
    const task = options.url.searchParams.get('task');
    await prefetchWorkThreadRoute(runtime.queryClient, client, {
      cursors: threadPageCursors(options.url.searchParams),
      query: threadListQuery(options.url.searchParams),
      threadId: isWorkThreadId(task) ? task : null,
    });
  });
  return { mode, queryState };
};
