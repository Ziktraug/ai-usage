import { dehydrateWebQueryClient, type WebQueryHydrationState } from '../../query/client';
import { createWebQueryRuntime, type WebQueryRuntime, type WebQueryRuntimeOptions } from '../../query/composition';

export type RoutePrefetch = (runtime: WebQueryRuntime) => Promise<void>;

export const createAwaitedRouteQueryState = async (
  options: WebQueryRuntimeOptions,
  prefetch: RoutePrefetch,
): Promise<WebQueryHydrationState> => {
  const runtime = createWebQueryRuntime(options);
  await prefetch(runtime);
  return dehydrateWebQueryClient(runtime.queryClient);
};
