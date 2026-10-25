import { tmpdir } from 'node:os';
import { normalizeClaudeAgentSdkQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type {
  Options as ClaudeAgentSdkQueryOptions,
  SDKControlInitializeResponse,
  SDKStartupFailureReason,
} from '@anthropic-ai/claude-agent-sdk';
import { Data, Effect } from 'effect';
import type { ProviderQuotaBatch, ProviderQuotaBatchSource, ProviderQuotaCollectRequest } from './provider-quota';

/**
 * A control-plane read that answers in well under a second in practice. The budget only has to cover
 * spawning the process, so it is kept tight: a provider that cannot answer quickly should degrade to
 * a warning rather than hold the whole collection cycle open behind it.
 */
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TEARDOWN_TIMEOUT_MS = 1000;

/**
 * `auth-required` and `unsupported` are the outcomes the quota refresh already words for the operator;
 * `startup-failure` is a CLI that refused to start or exited before answering, for any other reason.
 */
export type ClaudeQuotaCollectionErrorReason =
  | 'aborted'
  | 'auth-required'
  | 'protocol'
  | 'startup-failure'
  | 'timeout'
  | 'unsupported';

export class ClaudeQuotaCollectionError extends Data.TaggedError('ClaudeQuotaCollectionError')<{
  readonly message: string;
  readonly reason: ClaudeQuotaCollectionErrorReason;
  /** The CLI's own typed reason, when it refused to start with one this build knows. */
  readonly startupFailureReason?: SDKStartupFailureReason;
}> {}

const collectionError = (reason: ClaudeQuotaCollectionErrorReason, message: string): ClaudeQuotaCollectionError =>
  new ClaudeQuotaCollectionError({ message, reason });

/**
 * Every startup refusal SDK 0.3.308 names, by what fixes it: signing in again or an administrator's
 * change (`auth-required`), a newer Claude Code (`unsupported`), or anything else (`startup-failure`).
 */
const STARTUP_FAILURE_OUTCOMES = {
  bypass_root: 'startup-failure',
  cli_version_too_old: 'unsupported',
  cwd_unavailable: 'startup-failure',
  gateway_access_denied: 'auth-required',
  gateway_signin_required: 'auth-required',
  managed_settings_invalid: 'startup-failure',
  org_config_refused: 'auth-required',
  org_config_required_unavailable: 'startup-failure',
  org_pin_api_key_conflict: 'auth-required',
  org_pin_mismatch: 'auth-required',
  org_verify_failed: 'auth-required',
  provider_not_allowed: 'auth-required',
  proxy_invalid: 'startup-failure',
  remote_settings_required_unavailable: 'startup-failure',
  session_held_by_background: 'startup-failure',
  shell_tool_missing: 'startup-failure',
  temp_dir_unusable: 'startup-failure',
  worktree_resume_refused: 'startup-failure',
  worktree_unverified: 'startup-failure',
} as const satisfies Record<SDKStartupFailureReason, ClaudeQuotaCollectionErrorReason>;

const isKnownStartupFailureReason = (value: unknown): value is SDKStartupFailureReason =>
  typeof value === 'string' && Object.hasOwn(STARTUP_FAILURE_OUTCOMES, value);

/**
 * The zeroed `result` message the CLI writes before exiting on a startup failure carries
 * `startup_failure_reason` (SDK 0.3.308); a reason a newer CLI adds is still a startup failure.
 */
const startupFailureOf = (message: unknown): ClaudeQuotaCollectionError | undefined => {
  if (typeof message !== 'object' || message === null) {
    return;
  }
  const { startup_failure_reason: reason, type } = message as { startup_failure_reason?: unknown; type?: unknown };
  if (type !== 'result' || reason === undefined) {
    return;
  }
  if (!isKnownStartupFailureReason(reason)) {
    return collectionError('startup-failure', 'Claude Code refused to start for a reason this build does not know.');
  }
  return new ClaudeQuotaCollectionError({
    message: `Claude Code refused to start: ${reason}.`,
    reason: STARTUP_FAILURE_OUTCOMES[reason],
    startupFailureReason: reason,
  });
};

/** The options this source passes to the SDK usage read. */
export interface ClaudeUsageReadOptions {
  /**
   * Since SDK 0.3.308 the usage read also scans every local transcript touched in the last seven days
   * to fill a `behaviors` section unless told not to. The quota path wants the plan rate limits only and
   * must never pay for, or depend on, that scan.
   */
  readonly skipBehaviors?: boolean;
}

/**
 * The surface this source needs from the SDK, named so the unstable parts are visible here. `Query`
 * is an `AsyncGenerator`, and the two teardown calls are not interchangeable: `interrupt` ends the
 * current turn, while `return` — the generator protocol's disposal — ends the *session* and tears
 * down the transport. Interrupting alone leaves handles open that keep the host process alive.
 * `next` reads the session's message stream, where a CLI that refuses to start writes its typed
 * reason before exiting; `initializationResult` is the handshake answer that names the CLI version.
 */
export interface ClaudeUsageQuery {
  initializationResult?: () => Promise<Pick<SDKControlInitializeResponse, 'claude_code_version'>>;
  interrupt?: () => Promise<unknown>;
  next?: () => Promise<IteratorResult<unknown, unknown>>;
  return?: (value?: unknown) => Promise<unknown>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (options?: ClaudeUsageReadOptions) => Promise<unknown>;
}

/** Fields for the wide event this read runs under. */
export type ClaudeQuotaAnnotations = Readonly<Record<string, string>>;

export interface ClaudeAgentSdkSourceOptions {
  /**
   * Records `claudeCodeVersion` (a successful read) or `claudeStartupFailureReason` (a typed refusal)
   * on the caller's wide event. Collectors do not own observability, so the runtime injects it.
   */
  annotate?: (fields: ClaudeQuotaAnnotations) => Effect.Effect<void>;
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

/**
 * Keep the control-only quota session isolated from whichever repository happens to host the engine.
 * Authentication remains available through the SDK's normal credential store and inherited environment;
 * filesystem settings, tools, plugins, hooks, skills, agents, and MCP servers do not. The SDK's `env`
 * replaces the inherited environment, so it is passed whole with `CLAUDE_CODE_STARTUP_FAILURE_RESULTS`
 * added: without it, startup failures that predate the typed result end with stderr alone.
 */
export const createClaudeQuotaQueryOptions = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ClaudeAgentSdkQueryOptions => ({
  additionalDirectories: [],
  agents: {},
  allowedTools: [],
  cwd: tmpdir(),
  env: { ...environment, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' },
  hooks: {},
  mcpServers: {},
  permissionMode: 'dontAsk',
  persistSession: false,
  plugins: [],
  settings: { disableAllHooks: true },
  settingSources: [],
  skills: [],
  strictMcpConfig: true,
  tools: [],
});

const openPublishedQuery = async (): Promise<ClaudeUsageQuery> => {
  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query?: (input: { options?: ClaudeAgentSdkQueryOptions; prompt: AsyncIterable<never> }) => unknown;
  };
  if (typeof sdk.query !== 'function') {
    throw collectionError('unsupported', 'The Claude Agent SDK does not expose query().');
  }
  const session = sdk.query({ options: createClaudeQuotaQueryOptions(), prompt: silentPrompt() });
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

/**
 * Read the session's message stream until the CLI says why it refused to start, or the stream ends
 * (or fails) before the usage read answered; either rejects at once instead of leaving the read to its
 * timeout. A stream that stays open never settles, so the usage read, the timeout or an abort decides
 * the race. Once the race is decided, disposal ends the stream and this rejection is ignored.
 */
const watchStartupFailure = async (session: ClaudeUsageQuery): Promise<never> => {
  if (!session.next) {
    return await new Promise<never>(() => undefined);
  }
  for (;;) {
    let step: IteratorResult<unknown, unknown>;
    try {
      step = await session.next();
    } catch (cause) {
      const detail = cause instanceof Error ? `: ${cause.message}` : '.';
      throw collectionError('startup-failure', `The Claude process failed before it answered the quota read${detail}`);
    }
    if (step.done) {
      throw collectionError('startup-failure', 'The Claude process ended before it answered the quota read.');
    }
    const failure = startupFailureOf(step.value);
    if (failure) {
      throw failure;
    }
  }
};

interface ClaudeUsageReading {
  readonly batch: ProviderQuotaBatch;
  /** Absent when the CLI predates `initializationResult().claude_code_version`. */
  readonly claudeCodeVersion: string | undefined;
}

const readUsage = async (
  request: ProviderQuotaCollectRequest,
  options: Required<Pick<ClaudeAgentSdkSourceOptions, 'openQuery' | 'timeoutMs'>>,
): Promise<ClaudeUsageReading> => {
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
    const usage = await Promise.race([
      // Plan limits only: the default read also scans a week of local transcripts for `behaviors`.
      openedSession.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      watchStartupFailure(openedSession),
    ]);
    // The handshake has completed once the usage read answers, so this resolves at once.
    const initialization = await openedSession.initializationResult?.();
    return { claudeCodeVersion: initialization?.claude_code_version, usage };
  })();
  let reading: { readonly claudeCodeVersion: string | undefined; readonly usage: unknown };
  try {
    reading = await withCollectionBoundary(read, options.timeoutMs, request.signal);
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
    result: reading.usage,
  });
  if (!observation) {
    throw collectionError('protocol', 'The Claude quota request could not be normalised.');
  }
  // A session with no plan limits — API key, Bedrock, Vertex — is a normal outcome, not a failure.
  // It still records an observation so the UI can say "no windows" rather than "never read".
  return {
    batch: { checkpoints: [], hasMore: false, observations: [observation], sourceEvents: [] },
    claudeCodeVersion: reading.claudeCodeVersion,
  };
};

export const createClaudeAgentSdkBatchSource = (
  options: ClaudeAgentSdkSourceOptions = {},
): ProviderQuotaBatchSource<ClaudeQuotaCollectionError> => {
  const resolved = {
    openQuery: options.openQuery ?? openPublishedQuery,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const annotate = options.annotate ?? (() => Effect.void);
  return {
    collect: (request) =>
      Effect.tryPromise({
        catch: (cause) =>
          cause instanceof ClaudeQuotaCollectionError
            ? cause
            : collectionError('protocol', 'The Claude Agent SDK quota read failed.'),
        try: () => readUsage(request, resolved),
      }).pipe(
        Effect.tap(({ claudeCodeVersion }) =>
          claudeCodeVersion === undefined ? Effect.void : annotate({ claudeCodeVersion }),
        ),
        Effect.tapError(({ startupFailureReason }) =>
          startupFailureReason === undefined
            ? Effect.void
            : annotate({ claudeStartupFailureReason: startupFailureReason }),
        ),
        Effect.map(({ batch }) => batch),
      ),
  };
};
