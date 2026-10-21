import type { RuntimeMode } from '../../../runtime-mode';
import type { WebQueryHydrationState } from '../../query/client';
import type { WebQueryRuntimeOptions } from '../../query/composition';
import { prefetchWorkQueries, type WorkLoadFailure } from '../../query/work-prefetch';
import { createAwaitedRouteQueryState } from '../shell/query-load';
import { createSyntheticWorkClient, WORK_DEMO_REVISION } from './work-synthetic';

export interface WorkPageData {
  readonly initialFailure: WorkLoadFailure | null;
  readonly mode: RuntimeMode;
  readonly queryState: WebQueryHydrationState;
}

export const deferredWorkPageData = (mode: RuntimeMode): WorkPageData => ({
  initialFailure: null,
  mode,
  queryState: { dehydratedState: { mutations: [], queries: [] } },
});

export const loadWorkPageData = async (options: WebQueryRuntimeOptions, mode: RuntimeMode): Promise<WorkPageData> => {
  let initialFailure: WorkLoadFailure | null = null;
  const queryState = await createAwaitedRouteQueryState(options, async (runtime) => {
    initialFailure = await prefetchWorkQueries(
      runtime,
      mode === 'live' ? undefined : { client: createSyntheticWorkClient(), revision: WORK_DEMO_REVISION },
    );
  });
  return { mode, queryState, initialFailure };
};
