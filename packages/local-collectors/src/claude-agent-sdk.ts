import { normalizeClaudeAgentSdkQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { Data, Effect } from 'effect';
import type { ProviderQuotaBatch, ProviderQuotaBatchSource, ProviderQuotaCollectRequest } from './provider-quota';

/**
 * A control-plane read that answers in well under a second in practice. The budget only has to cover
 * spawning the process, so it is kept tight: a provider that cannot answer quickly should degrade to
 * a warning rather than hold the whole collection cycle open behind it.
 */
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TEARDOWN_TIMEOUT_MS = 1000;

export type ClaudeQuotaCollectionErrorReason = 'unsupported' | 'timeout' | 'protocol' | 'aborted';

export class ClaudeQuotaCollectionError extends Data.TaggedError('ClaudeQuotaCollectionError')<{
  readonly message: string;
  readonly reason: ClaudeQuotaCollectionErrorReason;
}> {}

const collectionError = (reason: ClaudeQuotaCollectionErrorReason, message: string): ClaudeQuotaCollectionError =>
  new ClaudeQuotaCollectionError({ message, reason });

/**
 * The surface this source needs from the SDK, named so the unstable parts are visible here. `Query`
 * is an `AsyncGenerator`, and the two teardown calls are not interchangeable: `interrupt` ends the
 * current turn, while `return` — the generator protocol's disposal — ends the *session* and tears
 * down the transport. Interrupting alone leaves handles open that keep the host process alive.
 */
export interface ClaudeUsageQuery {
  interrupt?: () => Promise<unknown>;
  return?: (value?: unknown) => Promise<unknown>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise<unknown>;
}

export interface ClaudeAgentSdkSourceOptions {
  /** Injected in tests. Production resolves the published SDK lazily. */
  openQuery?: () => Promise<ClaudeUsageQuery>;
  timeoutMs?: number;
}

/**
 * A streaming prompt that never yields. The session opens so the control channel exists, but no user
 * message is ever sent, so the quota read costs no model turn.
 */
const silentPrompt = async function* (): AsyncGenerator<never> {
  await new Promise(() => {
    /* never resolves; the query is interrupted instead */
  });
};

const openPublishedQuery = async (): Promise<ClaudeUsageQuery> => {
  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query?: (input: { options?: Record<string, unknown>; prompt: AsyncIterable<never> }) => unknown;
  };
  if (typeof sdk.query !== 'function') {
    throw collectionError('unsupported', 'The Claude Agent SDK does not expose query().');
  }
  const session = sdk.query({ options: {}, prompt: silentPrompt() });
  if (
    typeof session !== 'object' ||
    session === null ||
    typeof (session as ClaudeUsageQuery).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function'
  ) {
    throw collectionError('unsupported', 'The installed Claude Agent SDK exposes no usage method.');
  }
  return session as ClaudeUsageQuery;
};

const withCollectionBoundary = async <Value>(
  work: Promise<Value>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(collectionError('timeout', 'The Claude quota read timed out.')), timeoutMs);
  });
  const contenders: Promise<Value>[] = [work, timeout];
  if (signal) {
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(collectionError('aborted', 'The Claude quota read was aborted.'));
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) {
        abortListener();
      }
    });
    contenders.push(aborted);
  }
  try {
    return await Promise.race(contenders);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
};

const settleTeardown = async (work: () => Promise<unknown> | undefined, timeoutMs: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settledWork = Promise.resolve()
    .then(work)
    .then(() => undefined)
    .catch(() => undefined);
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([settledWork, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const disposeSession = async (session: ClaudeUsageQuery, timeoutMs: number): Promise<void> => {
  const teardownTimeoutMs = Math.max(1, Math.min(timeoutMs, MAX_TEARDOWN_TIMEOUT_MS));
  await settleTeardown(() => session.interrupt?.(), teardownTimeoutMs);
  await settleTeardown(() => session.return?.(), teardownTimeoutMs);
};

const readUsage = async (
  request: ProviderQuotaCollectRequest,
  options: Required<Pick<ClaudeAgentSdkSourceOptions, 'openQuery' | 'timeoutMs'>>,
): Promise<ProviderQuotaBatch> => {
  if (request.signal?.aborted) {
    throw collectionError('aborted', 'The Claude quota read was aborted.');
  }
  // Opening and reading share one boundary. Opening the session spawns a Claude process and performs a
  // handshake; on a machine without usable credentials that can stall indefinitely, and a timeout that
  // starts only once the session exists would never fire.
  let session: ClaudeUsageQuery | undefined;
  let acceptOpenedSession = true;
  const read = (async () => {
    const openedSession = await options.openQuery();
    if (!acceptOpenedSession) {
      await disposeSession(openedSession, options.timeoutMs);
      const reason = request.signal?.aborted ? 'aborted' : 'timeout';
      throw collectionError(reason, `The Claude quota read ${reason === 'aborted' ? 'was aborted' : 'timed out'}.`);
    }
    session = openedSession;
    return await openedSession.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  })();
  let result: unknown;
  try {
    result = await withCollectionBoundary(read, options.timeoutMs, request.signal);
  } finally {
    acceptOpenedSession = false;
    if (session) {
      // `interrupt` stops the turn; only closing the generator disposes the session and transport.
      // Each teardown call has its own small deadline so one unstable SDK method cannot block the next.
      await disposeSession(session, options.timeoutMs);
    }
  }
  if (request.signal?.aborted) {
    throw collectionError('aborted', 'The Claude quota read was aborted.');
  }
  const observation = normalizeClaudeAgentSdkQuotaObservation({
    ...(request.accountScope === undefined ? {} : { accountScope: request.accountScope }),
    machineId: request.machineId,
    ...(request.machineLabel === undefined ? {} : { machineLabel: request.machineLabel }),
    observedAt: request.observedAt ?? new Date(),
    result,
  });
  if (!observation) {
    throw collectionError('protocol', 'The Claude quota request could not be normalised.');
  }
  // A session with no plan limits — API key, Bedrock, Vertex — is a normal outcome, not a failure.
  // It still records an observation so the UI can say "no windows" rather than "never read".
  return { checkpoints: [], hasMore: false, observations: [observation], sourceEvents: [] };
};

export const createClaudeAgentSdkBatchSource = (
  options: ClaudeAgentSdkSourceOptions = {},
): ProviderQuotaBatchSource<ClaudeQuotaCollectionError> => {
  const resolved = {
    openQuery: options.openQuery ?? openPublishedQuery,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  return {
    collect: (request) =>
      Effect.tryPromise({
        catch: (cause) =>
          cause instanceof ClaudeQuotaCollectionError
            ? cause
            : collectionError('protocol', 'The Claude Agent SDK quota read failed.'),
        try: () => readUsage(request, resolved),
      }),
  };
};
