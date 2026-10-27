import type { RuntimeMode } from '../../../runtime-mode';
import type { WebQueryHydrationState } from '../../query/client';
import { workAttentionRequestFromSearch } from '../../query/options/work-attention';
import {
  LIVE_WORK_SOURCES,
  prefetchWorkQueries,
  type WorkLoadFailure,
  type WorkPrefetchFailures,
  type WorkPrefetchSources,
} from '../../query/work-prefetch';
import { createAwaitedRouteQueryState, type RouteQueryLoadOptions } from '../shell/query-load';
import { createSyntheticWorkAttentionClient } from './work-attention-synthetic';
import { createSyntheticWorkClient, WORK_DEMO_REVISION } from './work-synthetic';

export interface WorkPageData {
  /** The declared-outcome dataset could not be prefetched; the page renders the typed reason and a retry. */
  readonly attentionFailure: WorkLoadFailure | null;
  /** The served session roots could not be prefetched; the bottom list renders the typed reason and a retry. */
  readonly initialFailure: WorkLoadFailure | null;
  readonly mode: RuntimeMode;
  readonly queryState: WebQueryHydrationState;
}

export const deferredWorkPageData = (mode: RuntimeMode): WorkPageData => ({
  attentionFailure: null,
  initialFailure: null,
  mode,
  queryState: { dehydratedState: { mutations: [], queries: [] } },
});

/**
 * Demo reads nothing real. The e2e runtime keeps the synthetic session roots but reads the
 * attention dataset through the served read model, which is what its browser suites exercise.
 */
export const workPrefetchSourcesFor = (mode: RuntimeMode): WorkPrefetchSources => {
  if (mode === 'live') {
    return LIVE_WORK_SOURCES;
  }
  const sessions = { client: createSyntheticWorkClient(), revision: WORK_DEMO_REVISION };
  return { attention: mode === 'demo' ? createSyntheticWorkAttentionClient() : null, sessions };
};

export const loadWorkPageData = async (options: RouteQueryLoadOptions, mode: RuntimeMode): Promise<WorkPageData> => {
  let failures: WorkPrefetchFailures = { attention: null, sessions: null };
  const queryState = await createAwaitedRouteQueryState(options, async (runtime) => {
    failures = await prefetchWorkQueries(
      runtime,
      workPrefetchSourcesFor(mode),
      workAttentionRequestFromSearch(options.url.searchParams),
    );
  });
  return { attentionFailure: failures.attention, initialFailure: failures.sessions, mode, queryState };
};
