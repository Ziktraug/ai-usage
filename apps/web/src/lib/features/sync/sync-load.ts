import type { WebQueryHydrationState } from '../../query/client';
import type { WebQueryRuntime, WebQueryRuntimeOptions } from '../../query/composition';
import type { SyncFleetClient } from '../../query/options/sync';
import { syncFleetQueryOptions } from '../../query/options/sync';
import { createSyncBrowserAdapter } from '../../rpc/sync-client';
import { createAwaitedRouteQueryState } from '../shell/query-load';

export const SYNC_COMPATIBLE_GENERATION = 'sync-fleet:v1';

export interface SyncPageData {
  readonly compatibleGeneration: string;
  readonly queryState: WebQueryHydrationState;
  readonly renderedAt: number;
}

export interface SyncPageLoadDependencies {
  readonly createClient?: (runtime: WebQueryRuntime) => SyncFleetClient;
  readonly now?: () => number;
}

export const deferredSyncPageData = (now: () => number = Date.now): SyncPageData => ({
  compatibleGeneration: SYNC_COMPATIBLE_GENERATION,
  queryState: { dehydratedState: { mutations: [], queries: [] } },
  renderedAt: now(),
});

/** Awaits the bounded fleet under the exact finite-SWR key used by the component. */
export const loadSyncPageData = async (
  options: WebQueryRuntimeOptions,
  dependencies: SyncPageLoadDependencies = {},
): Promise<SyncPageData> => {
  const queryState = await createAwaitedRouteQueryState(options, async (runtime) => {
    const client = dependencies.createClient?.(runtime) ?? createSyncBrowserAdapter(runtime.rpc.sync);
    await runtime.queryClient.fetchQuery(
      syncFleetQueryOptions(client, {
        browser: false,
        compatibleGeneration: SYNC_COMPATIBLE_GENERATION,
        enabled: true,
      }),
    );
  });
  return {
    compatibleGeneration: SYNC_COMPATIBLE_GENERATION,
    queryState,
    renderedAt: dependencies.now?.() ?? Date.now(),
  };
};
