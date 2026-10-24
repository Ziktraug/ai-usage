import { isWorkThreadId } from '@ai-usage/report-core/work-thread';
import type { RuntimeMode } from '../../../runtime-mode';
import type { WebQueryHydrationState } from '../../query/client';
import type { WebQueryRuntimeOptions } from '../../query/composition';
import { workThreadDetailQueryOptions, workThreadListQueryOptions } from '../../query/options/work-threads';
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
    const query = threadListQuery(options.url.searchParams);
    const cursors = threadPageCursors(options.url.searchParams);
    const reads: Promise<unknown>[] = cursors.map((cursor) =>
      runtime.queryClient.fetchQuery(
        workThreadListQueryOptions(client, { ...query, cursor }, { browser: true, enabled: true }),
      ),
    );
    const task = options.url.searchParams.get('task');
    if (isWorkThreadId(task)) {
      reads.push(
        runtime.queryClient.fetchQuery(workThreadDetailQueryOptions(client, task, { browser: true, enabled: true })),
      );
    }
    await Promise.all(reads);
  });
  return { mode, queryState };
};
