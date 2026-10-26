import { createReportClient } from '../rpc/report-client';
import { createSessionClientAdapter, type SessionClientAdapter } from '../rpc/session-client';
import { resolveWorkAttentionClient, type WorkAttentionClient } from '../rpc/work-attention-client';
import type { WebQueryRuntime } from './composition';
import { reportBootstrapQueryOptions } from './options/report';
import { SessionRevisionExpiredError } from './options/session-window';
import { workSessionsOptions } from './options/work';
import {
  WorkAttentionQueryError,
  type WorkContextSearchRead,
  workAttentionQueryOptions,
  workAttentionRequest,
} from './options/work-attention';

export interface WorkLoadFailure {
  readonly kind: 'attention-unavailable' | 'bootstrap-unavailable' | 'revision-expired' | 'session-unavailable';
  readonly message: string;
}

/** Each Work surface fails on its own: a missing dataset never hides the served session roots, nor the reverse. */
export interface WorkPrefetchFailures {
  readonly attention: WorkLoadFailure | null;
  readonly sessions: WorkLoadFailure | null;
}

/**
 * Where each surface reads from. `null` means the runtime's RPC client; a synthetic source never
 * touches a transport. The demo runs both synthetic; the e2e runtime keeps synthetic session roots
 * while the attention dataset comes from the served read model.
 */
export interface WorkPrefetchSources {
  readonly attention: WorkAttentionClient | null;
  readonly sessions: { readonly client: SessionClientAdapter; readonly revision: string } | null;
}

export const LIVE_WORK_SOURCES: WorkPrefetchSources = { attention: null, sessions: null };

const serverContext = { browser: false, enabled: false } as const;

const isAbort = (cause: unknown): boolean => cause instanceof Error && cause.name === 'AbortError';

/** Typed, fixed wording per failure class; no transport or server message reaches the page payload. */
const attentionFailureFor = (cause: unknown): WorkLoadFailure => {
  if (cause instanceof WorkAttentionQueryError) {
    switch (cause.tag) {
      case 'ForbiddenDemo':
        return { kind: 'attention-unavailable', message: 'The demo runtime serves no declared outcomes.' };
      case 'IncompatibleStore':
        return {
          kind: 'attention-unavailable',
          message: 'The local store is older than this build; declared outcomes cannot be read until it is upgraded.',
        };
      case 'MalformedResponse':
        return {
          kind: 'attention-unavailable',
          message: 'The declared outcomes response did not match the shared contract and was not displayed.',
        };
      default:
        break;
    }
  }
  return { kind: 'attention-unavailable', message: 'Declared outcomes could not be read from the local store.' };
};

const prefetchAttention = async (
  runtime: WebQueryRuntime,
  client: WorkAttentionClient,
  context: WorkContextSearchRead,
): Promise<WorkLoadFailure | null> => {
  if (!context.ok) {
    return { kind: 'attention-unavailable', message: context.error.message };
  }
  try {
    await runtime.queryClient.fetchQuery(workAttentionQueryOptions(client, context.input, serverContext));
    return null;
  } catch (cause) {
    if (isAbort(cause)) {
      throw cause;
    }
    return attentionFailureFor(cause);
  }
};

const prefetchSessions = async (
  runtime: WebQueryRuntime,
  synthetic: WorkPrefetchSources['sessions'],
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
    if (isAbort(cause)) {
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

/**
 * One bounded Work page, acquired and hydrated under the existing named Query policies: the
 * attention dataset on the collection cadence, the served session roots on their immutable revision.
 */
export const prefetchWorkQueries = async (
  runtime: WebQueryRuntime,
  sources: WorkPrefetchSources = LIVE_WORK_SOURCES,
  context: WorkContextSearchRead = { ok: true, input: workAttentionRequest() },
): Promise<WorkPrefetchFailures> => {
  const attention = await prefetchAttention(
    runtime,
    sources.attention ?? resolveWorkAttentionClient(runtime.rpc),
    context,
  );
  const sessions = await prefetchSessions(runtime, sources.sessions);
  return { attention, sessions };
};
