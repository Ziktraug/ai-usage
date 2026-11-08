import type { RuntimeMode } from '../../../runtime-mode';
import type { WebQueryHydrationState } from '../../query/client';
import { prefetchObservatory } from '../../query/observatory-prefetch';
import { createAwaitedRouteQueryState, type RouteQueryLoadOptions } from '../shell/query-load';

export interface ObservatoryPageData {
  mode: RuntimeMode;
  queryState: WebQueryHydrationState;
}
export const loadObservatoryPage = async (
  options: RouteQueryLoadOptions,
  mode: RuntimeMode,
): Promise<ObservatoryPageData> => ({
  mode,
  queryState: await createAwaitedRouteQueryState(options, (runtime) => prefetchObservatory(runtime, options.url, mode)),
});
