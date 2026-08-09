import { dehydrateWebQueryClient, type WebQueryHydrationState } from '../../query/client';
import { createWebQueryRuntime, type WebQueryRuntime, type WebQueryRuntimeOptions } from '../../query/composition';

export type RoutePrefetch = (runtime: WebQueryRuntime) => Promise<void>;

export const createAwaitedRouteQueryState = async (
  options: WebQueryRuntimeOptions,
  prefetch: RoutePrefetch,
): Promise<WebQueryHydrationState> => {
  const runtime = createWebQueryRuntime(options);
  try {
    await prefetch(runtime);
    return dehydrateWebQueryClient(runtime.queryClient);
  } finally {
    // Request-owned clients must not retain query data or timers after serialization (or failure).
    runtime.queryClient.clear();
  }
};
