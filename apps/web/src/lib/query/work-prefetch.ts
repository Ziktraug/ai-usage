import { createReportClient } from '../rpc/report-client';
import { createSessionClientAdapter, type SessionClientAdapter } from '../rpc/session-client';
import type { WebQueryRuntime } from './composition';
import { reportBootstrapQueryOptions } from './options/report';
import { SessionRevisionExpiredError } from './options/session-window';
import { workSessionsOptions } from './options/work';

export interface WorkLoadFailure {
  readonly kind: 'bootstrap-unavailable' | 'session-unavailable' | 'revision-expired';
  readonly message: string;
}

/** One bounded Work page, acquired and hydrated under the existing named Query policies. */
export const prefetchWorkQueries = async (
  runtime: WebQueryRuntime,
  synthetic?: { readonly client: SessionClientAdapter; readonly revision: string },
): Promise<WorkLoadFailure | null> => {
  if (synthetic) {
    await runtime.queryClient.fetchInfiniteQuery(workSessionsOptions(synthetic.client, synthetic.revision));
    return null;
  }
  let stage: 'bootstrap' | 'sessions' = 'bootstrap';
  try {
    const bootstrap = await runtime.queryClient.fetchQuery(
      reportBootstrapQueryOptions(createReportClient(runtime.rpc), { browser: false }),
    );
    if (!bootstrap.ok) {
      return null;
    }
    stage = 'sessions';
    await runtime.queryClient.fetchInfiniteQuery(
      workSessionsOptions(createSessionClientAdapter(runtime.rpc.session), bootstrap.manifest.revision),
    );
    return null;
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw cause;
    }
    if (cause instanceof SessionRevisionExpiredError) {
      return {
        kind: 'revision-expired',
        message: 'The stored session revision expired before it could be read.',
      };
    }
    return stage === 'bootstrap'
      ? {
          kind: 'bootstrap-unavailable',
          message: 'The report observation could not be read from the local store.',
        }
      : {
          kind: 'session-unavailable',
          message: 'Session observations could not be read from the stored revision.',
        };
  }
};
