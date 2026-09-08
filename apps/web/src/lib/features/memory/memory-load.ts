import type { WebQueryHydrationState } from '../../query/client';
import type { WebQueryRuntime, WebQueryRuntimeOptions } from '../../query/composition';
import { memoryProposalReviewsQueryOptions } from '../../query/options/memory';
import { createMemoryBrowserAdapter, type MemoryBrowserAdapter } from '../../rpc/memory-client';
import { createAwaitedRouteQueryState } from '../shell/query-load';

export interface MemoryPageData {
  readonly queryState: WebQueryHydrationState;
}

export interface MemoryPageLoadDependencies {
  readonly createClient?: (runtime: WebQueryRuntime) => MemoryBrowserAdapter;
}

export const deferredMemoryPageData = (): MemoryPageData => ({
  queryState: { dehydratedState: { mutations: [], queries: [] } },
});

export const loadMemoryPageData = async (
  options: WebQueryRuntimeOptions,
  dependencies: MemoryPageLoadDependencies = {},
): Promise<MemoryPageData> => ({
  queryState: await createAwaitedRouteQueryState(options, async (runtime) => {
    const client = dependencies.createClient?.(runtime) ?? createMemoryBrowserAdapter(runtime.rpc.memory);
    await runtime.queryClient.fetchQuery(memoryProposalReviewsQueryOptions(client, { browser: false, enabled: true }));
  }),
});
