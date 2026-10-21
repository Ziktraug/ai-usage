import type { RuntimeMode } from '../../../runtime-mode';
import type { WebQueryHydrationState } from '../../query/client';
import type { WebQueryRuntimeOptions } from '../../query/composition';
import { reportBootstrapQueryOptions } from '../../query/options/report';
import { SessionRevisionExpiredError } from '../../query/options/session-window';
import { createReportClient } from '../../rpc/report-client';
import { createSessionClientAdapter } from '../../rpc/session-client';
import { createAwaitedRouteQueryState } from '../shell/query-load';
import { workSessionsOptions } from './work-query';
import { createSyntheticWorkClient, WORK_DEMO_REVISION } from './work-synthetic';

export interface WorkPageData {
  readonly initialFailure: WorkLoadFailure | null;
  readonly mode: RuntimeMode;
  readonly queryState: WebQueryHydrationState;
}

export interface WorkLoadFailure {
  readonly kind: 'bootstrap-unavailable' | 'session-unavailable' | 'revision-expired';
  readonly message: string;
}

export const deferredWorkPageData = (mode: RuntimeMode): WorkPageData => ({
  initialFailure: null,
  mode,
  queryState: { dehydratedState: { mutations: [], queries: [] } },
});

export const loadWorkPageData = async (options: WebQueryRuntimeOptions, mode: RuntimeMode): Promise<WorkPageData> => {
  let initialFailure: WorkLoadFailure | null = null;
  const queryState = await createAwaitedRouteQueryState(options, async (runtime) => {
    if (mode !== 'live') {
      await runtime.queryClient.fetchInfiniteQuery(
        workSessionsOptions(createSyntheticWorkClient(), WORK_DEMO_REVISION),
      );
      return;
    }
    let stage: 'bootstrap' | 'sessions' = 'bootstrap';
    try {
      const bootstrap = await runtime.queryClient.fetchQuery(
        reportBootstrapQueryOptions(createReportClient(runtime.rpc), { browser: false }),
      );
      if (!bootstrap.ok) {
        return;
      }
      stage = 'sessions';
      await runtime.queryClient.fetchInfiniteQuery(
        workSessionsOptions(createSessionClientAdapter(runtime.rpc.session), bootstrap.manifest.revision),
      );
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw cause;
      }
      if (cause instanceof SessionRevisionExpiredError) {
        initialFailure = {
          kind: 'revision-expired',
          message: 'The stored session revision expired before it could be read.',
        };
      } else {
        initialFailure =
          stage === 'bootstrap'
            ? {
                kind: 'bootstrap-unavailable',
                message: 'The report observation could not be read from the local store.',
              }
            : {
                kind: 'session-unavailable',
                message: 'Session observations could not be read from the stored revision.',
              };
      }
    }
  });
  return { mode, queryState, initialFailure };
};
