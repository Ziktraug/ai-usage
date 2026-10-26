import { readLocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import {
  holdsReviewReservation,
  isCheckoutPathAdmitted,
  REVIEW_ATTEMPT_BOUNDS,
  type ReviewAttempt,
  type ReviewTargetDeclaration,
  resolveReviewCheckoutPath,
} from '@ai-usage/report-core/work-attempts';
import { declarationForReviewCandidate } from '@ai-usage/report-core/work-routing';
import {
  parseWebUsageEngineCommand,
  type UsageEngineCommandCompletion,
  type WebUsageEngineCommand,
} from '@ai-usage/usage-engine-control';
import {
  queryReviewAttempts,
  queryReviewTargetResolution,
  querySessionRowsBySourceSessionIds,
  type ReviewTargetResolutionFacts,
  usageStoreErrorReasonFrom,
} from '@ai-usage/usage-store/reader';
import {
  parseWorkAttemptsListOutput,
  parseWorkAttemptsReleaseOutput,
  parseWorkAttemptsStartOutput,
  parseWorkAttemptsStopOutput,
  type WorkAttemptsListInput,
  type WorkAttemptsListOutput,
  type WorkAttemptsReleaseInput,
  type WorkAttemptsReleaseOutput,
  type WorkAttemptsResolvedTarget,
  type WorkAttemptsStartInput,
  type WorkAttemptsStartOutput,
  type WorkAttemptsStopInput,
  type WorkAttemptsStopOutput,
  type WorkAttemptWire,
} from '@ai-usage/web-contract/work-attempts';
import { Effect } from 'effect';
import type { RuntimeMode } from '../runtime-mode';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import { getServerRuntimeMode } from './runtime-mode.server';
import {
  type ExecuteUsageEngineCommandOptions,
  executeUsageEngineCommandToCompletion,
} from './usage-engine-command.server';
import { resolveUsageEngineControlClientForServer } from './usage-engine-control-resolver.server';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

/**
 * The server side of `workAttempts` (ADR 0053). `list` reads the store read-only (ADR 0009) and
 * says what it could resolve about the target; `start` forwards one `start-review-attempt`
 * command to the engine and relays its answer. The Web process decides nothing: whether a review
 * may run is the engine's decision at launch time, and `target.admitted` here is only the reason
 * the page shows before the click. Demo exposes nothing; the synthetic e2e runtime has no engine.
 */
type StartReviewAttemptCommand = Extract<WebUsageEngineCommand, { readonly command: 'start-review-attempt' }>;

export type ExecuteStartReviewAttemptCommand = (
  command: StartReviewAttemptCommand,
  options?: ExecuteUsageEngineCommandOptions,
) => Promise<UsageEngineCommandCompletion>;

type ReleaseReviewReservationCommand = Extract<
  WebUsageEngineCommand,
  { readonly command: 'release-review-reservation' }
>;

export type ExecuteReleaseReviewReservationCommand = (
  command: ReleaseReviewReservationCommand,
  options?: ExecuteUsageEngineCommandOptions,
) => Promise<UsageEngineCommandCompletion>;

export interface WorkAttemptsServerReaders {
  readonly now?: () => Date;
  readonly readAttempts: (input: {
    readonly limit: number;
    readonly machineId: string | null;
    readonly target: { readonly harness: string; readonly sourceSessionId: string } | null;
  }) => Promise<{ readonly attempts: readonly ReviewAttempt[]; readonly skipped: number; readonly truncated: boolean }>;
  readonly readRouting: () => Promise<{
    readonly machineId: string | null;
    readonly reviewTargets: readonly ReviewTargetDeclaration[];
  }>;
  /** Native session ids → served Session row ids at the current revision, for the "Open session detail" link. */
  readonly resolveSessionRows: (input: {
    readonly harnessKey: string;
    readonly machineId: string;
    readonly sourceSessionIds: readonly string[];
  }) => Promise<ReadonlyMap<string, string>>;
  readonly resolveTarget: (input: {
    readonly harness: string;
    readonly machineId: string;
    readonly sourceSessionId: string;
  }) => Promise<ReviewTargetResolutionFacts>;
}

export interface WorkAttemptsServerOptions {
  readonly mode?: RuntimeMode;
  readonly readers?: WorkAttemptsServerReaders;
  readonly signal?: AbortSignal;
}

const DEFAULT_LIST_LIMIT = 20;
const INCOMPATIBLE_STORE_REASONS = new Set(['corrupt', 'schema-too-new', 'schema-too-old']);
/** A store older than this version: the query-only reader cannot upgrade it, the engine does at its start. */
export const STORE_NOT_UPGRADED_MESSAGE =
  'The usage store has not been upgraded for this version yet; the engine upgrades it when it next starts.';
const EMPTY_READ = { attempts: [], skipped: 0, truncated: false } as const;

export const createWorkAttemptsServerReaders = (
  paths: ReturnType<typeof resolveUsageWebRuntimePaths> = resolveUsageWebRuntimePaths(),
): WorkAttemptsServerReaders => ({
  readAttempts: async ({ limit, machineId, target }) => {
    const outcome = await Effect.runPromise(
      Effect.result(
        queryReviewAttempts({
          dbPath: paths.databasePath,
          limit,
          ...(machineId === null ? {} : { machineId }),
          ...(target === null ? {} : { target }),
        }),
      ),
    );
    if (outcome._tag === 'Success') {
      return outcome.success;
    }
    // No store yet means no attempt yet; every other reason stays a failure the caller classifies.
    if (usageStoreErrorReasonFrom(outcome.failure) === 'store-missing') {
      return EMPTY_READ;
    }
    throw outcome.failure;
  },
  readRouting: async () => {
    const routing = await readLocalRoutingDeclarations(paths.homeDirectory);
    return { machineId: routing.machineId, reviewTargets: routing.reviewTargets };
  },
  resolveSessionRows: async (input) => {
    if (input.sourceSessionIds.length === 0) {
      return new Map();
    }
    const outcome = await Effect.runPromise(
      Effect.result(querySessionRowsBySourceSessionIds({ dbPath: paths.databasePath, ...input })),
    );
    if (outcome._tag === 'Success') {
      return new Map(outcome.success.rows.map((row) => [row.sourceSessionId, row.rowId] as const));
    }
    if (usageStoreErrorReasonFrom(outcome.failure) === 'store-missing') {
      return new Map();
    }
    throw outcome.failure;
  },
  resolveTarget: async (input) => {
    const outcome = await Effect.runPromise(
      Effect.result(queryReviewTargetResolution({ dbPath: paths.databasePath, ...input })),
    );
    if (outcome._tag === 'Success') {
      return outcome.success;
    }
    if (usageStoreErrorReasonFrom(outcome.failure) === 'store-missing') {
      return { desktop: null, session: null };
    }
    throw outcome.failure;
  },
});

/** The harness key a launched executor's own session is collected under. */
const nativeHarnessKey = (executorHarness: ReviewAttempt['executorHarness']): string =>
  executorHarness === 'claude-code' ? 'claude' : 'codex';

const guaranteeToWire = (guarantee: ReviewAttempt['guarantee']): WorkAttemptWire['guarantee'] => {
  if (guarantee === null) {
    return null;
  }
  if ('kind' in guarantee) {
    return { ...guarantee };
  }
  return { ...guarantee, settingSources: [...guarantee.settingSources], tools: [...guarantee.tools] };
};

/**
 * The wire shape: no pid, no idempotency key, no launch session id, no declaration snapshot; the
 * declared account and effort and the launched candidate's model stay, with the reviewed scope,
 * the harness guarantee and whether the attempt still holds its identity's reservation.
 */
export const toWorkAttemptWire = (
  attempt: ReviewAttempt,
  nativeSessionRowId: string | null = null,
): WorkAttemptWire => ({
  acceptance: attempt.acceptance,
  attemptId: attempt.attemptId,
  candidateId: attempt.candidateId,
  declared:
    attempt.declaration === null
      ? null
      : {
          accountScope: attempt.declaration.accountScope,
          effort: attempt.declaration.effort,
          // The candidate's model, not the declaration's primary one: an alternate-model candidate
          // (ADR 0057) shares its declaration. A candidate id the snapshot does not produce names none.
          model: declarationForReviewCandidate([attempt.declaration], attempt.candidateId)?.model ?? null,
        },
  durationMs: attempt.durationMs,
  endedAt: attempt.endedAt,
  executorHarness: attempt.executorHarness,
  exitCode: attempt.exitCode,
  failureReason: attempt.failureReason,
  guarantee: guaranteeToWire(attempt.guarantee),
  machineId: attempt.machineId,
  nativeSessionId: attempt.nativeSessionId,
  nativeSessionRowId,
  nativeTurnId: attempt.nativeTurnId,
  stopRequestedAt: attempt.stopRequestedAt,
  stopConfirmedAt: attempt.stopConfirmedAt,
  numTurns: attempt.numTurns,
  requestedAt: attempt.requestedAt,
  reservation: {
    held: holdsReviewReservation(attempt),
    releaseEvidence: attempt.releaseEvidence,
    releasedAt: attempt.releasedAt,
  },
  resultExcerpt: attempt.resultExcerpt,
  resultKind: attempt.resultKind,
  scope: attempt.scope === null ? null : { ...attempt.scope, files: attempt.scope.files.map((file) => ({ ...file })) },
  startedAt: attempt.startedAt,
  state: attempt.state,
  target: attempt.target,
  updatedAt: attempt.updatedAt,
  validations: [...attempt.validations],
});

const listFailure = (
  tag: 'ForbiddenDemo' | 'IncompatibleStore' | 'Unavailable',
  message: string,
): WorkAttemptsListOutput => ({
  error: { message, tag },
  ok: false,
});

const startFailure = (
  tag: 'ForbiddenDemo' | 'Refused' | 'Unavailable',
  message: string,
  reason: Extract<WorkAttemptsStartOutput, { ok: false }>['error']['reason'] = null,
): WorkAttemptsStartOutput => ({ error: { message, reason, tag }, ok: false });

export const listWorkAttemptsForServer = async (
  input: WorkAttemptsListInput,
  options: WorkAttemptsServerOptions = {},
): Promise<WorkAttemptsListOutput> => {
  const mode = options.mode ?? getServerRuntimeMode();
  options.signal?.throwIfAborted();
  if (mode === 'demo') {
    return listFailure('ForbiddenDemo', 'Execution is not available in the demo.');
  }
  const now = (options.readers?.now ?? (() => new Date()))().toISOString();
  if (mode === 'e2e') {
    return { data: { attempts: [], generatedAt: now, skipped: 0, target: null, truncated: false }, ok: true };
  }
  const readers = options.readers ?? createWorkAttemptsServerReaders();
  const target = input.target ?? null;
  try {
    const routing = await readers.readRouting();
    options.signal?.throwIfAborted();
    const read = await readers.readAttempts({
      limit: Math.min(input.limit ?? DEFAULT_LIST_LIMIT, REVIEW_ATTEMPT_BOUNDS.maxListLimit),
      machineId: routing.machineId,
      target,
    });
    options.signal?.throwIfAborted();
    const sessionRows = new Map<string, string>();
    if (routing.machineId !== null) {
      const byHarness = new Map<string, string[]>();
      for (const attempt of read.attempts) {
        if (attempt.nativeSessionId !== null) {
          const key = nativeHarnessKey(attempt.executorHarness);
          byHarness.set(key, [...(byHarness.get(key) ?? []), attempt.nativeSessionId]);
        }
      }
      for (const [harnessKey, sourceSessionIds] of byHarness) {
        const rows = await readers.resolveSessionRows({ harnessKey, machineId: routing.machineId, sourceSessionIds });
        for (const [sourceSessionId, rowId] of rows) {
          sessionRows.set(`${harnessKey}\u0000${sourceSessionId}`, rowId);
        }
      }
      options.signal?.throwIfAborted();
    }
    let resolved: WorkAttemptsResolvedTarget | null = null;
    if (target !== null && routing.machineId !== null) {
      const facts = await readers.resolveTarget({ ...target, machineId: routing.machineId });
      options.signal?.throwIfAborted();
      const checkout = resolveReviewCheckoutPath({
        desktop: facts.desktop === null ? null : { cwd: facts.desktop.cwd, worktreePath: facts.desktop.worktreePath },
        session: facts.session === null ? null : { sourcePath: facts.session.sourcePath },
      });
      resolved = {
        admitted: checkout !== null && isCheckoutPathAdmitted(checkout.checkoutPath, routing.reviewTargets),
        checkoutOrigin: checkout?.origin ?? null,
        checkoutPath: checkout?.checkoutPath ?? null,
        harness: target.harness,
        sourceSessionId: target.sourceSessionId,
      };
    }
    return parseWorkAttemptsListOutput({
      data: {
        attempts: read.attempts.map((attempt) =>
          toWorkAttemptWire(
            attempt,
            attempt.nativeSessionId === null
              ? null
              : (sessionRows.get(`${nativeHarnessKey(attempt.executorHarness)}\u0000${attempt.nativeSessionId}`) ??
                  null),
          ),
        ),
        generatedAt: now,
        skipped: read.skipped,
        target: resolved,
        truncated: read.truncated,
      },
      ok: true,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    const reason = usageStoreErrorReasonFrom(error);
    if (reason === 'schema-too-old') {
      return listFailure('IncompatibleStore', STORE_NOT_UPGRADED_MESSAGE);
    }
    if (reason !== undefined && INCOMPATIBLE_STORE_REASONS.has(reason)) {
      return listFailure(
        'IncompatibleStore',
        'The usage store is not compatible with this version of the application.',
      );
    }
    return listFailure('Unavailable', 'Review attempts could not be read from the usage store.');
  }
};

const executeStartCommand: ExecuteStartReviewAttemptCommand = async (command, options) => {
  const control = await resolveUsageEngineControlClientForServer();
  return await executeUsageEngineCommandToCompletion(control, command, options);
};

export const startWorkAttemptForServer = async (
  input: WorkAttemptsStartInput,
  execute: ExecuteStartReviewAttemptCommand = executeStartCommand,
  options: Omit<WorkAttemptsServerOptions, 'readers'> = {},
): Promise<WorkAttemptsStartOutput> => {
  const mode = options.mode ?? getServerRuntimeMode();
  options.signal?.throwIfAborted();
  if (mode === 'demo') {
    return startFailure('ForbiddenDemo', 'Execution is not available in the demo.');
  }
  if (mode === 'e2e') {
    return startFailure('Unavailable', 'Execution is not available in this runtime.');
  }
  const command = parseWebUsageEngineCommand({
    action: input.action,
    candidateId: input.candidateId,
    command: 'start-review-attempt',
    target: {
      desktopSessionId: input.target.desktopSessionId ?? null,
      harness: input.target.harness,
      sourceSessionId: input.target.sourceSessionId,
    },
  });
  if (command.command !== 'start-review-attempt') {
    throw new Error('Expected a review attempt command.');
  }
  let completion: UsageEngineCommandCompletion;
  try {
    completion = await execute(command, options.signal === undefined ? {} : { signal: options.signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    return startFailure('Unavailable', 'The engine could not start the review; it may be stopped or busy.');
  }
  if (completion.state !== 'succeeded' || completion.command !== 'start-review-attempt') {
    return startFailure('Unavailable', 'The engine did not complete the review command.');
  }
  const { attempt, refusal } = completion.output;
  if (refusal !== null) {
    return parseWorkAttemptsStartOutput(startFailure('Refused', refusal.message, refusal.reason));
  }
  return parseWorkAttemptsStartOutput({
    data: { attemptId: attempt.attemptId, reused: attempt.reused, state: attempt.state },
    ok: true,
  });
};

export const startWorkAttemptFromRequestForServer = async (
  request: Request,
  input: WorkAttemptsStartInput,
  execute?: ExecuteStartReviewAttemptCommand,
  mode?: RuntimeMode,
): Promise<WorkAttemptsStartOutput> => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    throw trustFailure;
  }
  return await startWorkAttemptForServer(input, execute, {
    ...(mode === undefined ? {} : { mode }),
    signal: request.signal,
  });
};

const releaseFailure = (tag: 'ForbiddenDemo' | 'Unavailable', message: string): WorkAttemptsReleaseOutput => ({
  error: { message, tag },
  ok: false,
});

const executeReleaseCommand: ExecuteReleaseReviewReservationCommand = async (command, options) => {
  const control = await resolveUsageEngineControlClientForServer();
  return await executeUsageEngineCommandToCompletion(control, command, options);
};

/**
 * Forwards the operator's declaration that a lost attempt's review no longer runs (ADR 0055) and
 * relays what the engine did: released (with its evidence), kept held because a process still
 * carries the marker, or nothing held. The Web process decides nothing and stops nothing.
 */
export const releaseWorkAttemptReservationForServer = async (
  input: WorkAttemptsReleaseInput,
  execute: ExecuteReleaseReviewReservationCommand = executeReleaseCommand,
  options: Omit<WorkAttemptsServerOptions, 'readers'> = {},
): Promise<WorkAttemptsReleaseOutput> => {
  const mode = options.mode ?? getServerRuntimeMode();
  options.signal?.throwIfAborted();
  if (mode === 'demo') {
    return releaseFailure('ForbiddenDemo', 'Execution is not available in the demo.');
  }
  if (mode === 'e2e') {
    return releaseFailure('Unavailable', 'Execution is not available in this runtime.');
  }
  const command = parseWebUsageEngineCommand({ attemptId: input.attemptId, command: 'release-review-reservation' });
  if (command.command !== 'release-review-reservation') {
    throw new Error('Expected a review reservation release command.');
  }
  let completion: UsageEngineCommandCompletion;
  try {
    completion = await execute(command, options.signal === undefined ? {} : { signal: options.signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    return releaseFailure('Unavailable', 'The engine could not record the release; it may be stopped or busy.');
  }
  if (completion.state !== 'succeeded' || completion.command !== 'release-review-reservation') {
    return releaseFailure('Unavailable', 'The engine did not complete the release command.');
  }
  const { attemptId, evidence, pids, releasedAt, result } = completion.output;
  return parseWorkAttemptsReleaseOutput({
    data: { attemptId, evidence, pids: [...pids], releasedAt, result },
    ok: true,
  });
};

export const releaseWorkAttemptReservationFromRequestForServer = async (
  request: Request,
  input: WorkAttemptsReleaseInput,
  execute?: ExecuteReleaseReviewReservationCommand,
  mode?: RuntimeMode,
): Promise<WorkAttemptsReleaseOutput> => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    throw trustFailure;
  }
  return await releaseWorkAttemptReservationForServer(input, execute, {
    ...(mode === undefined ? {} : { mode }),
    signal: request.signal,
  });
};

type StopReviewAttemptCommand = Extract<WebUsageEngineCommand, { readonly command: 'stop-review-attempt' }>;
export type ExecuteStopReviewAttemptCommand = (
  command: StopReviewAttemptCommand,
  options?: ExecuteUsageEngineCommandOptions,
) => Promise<UsageEngineCommandCompletion>;

const stopFailure = (tag: 'ForbiddenDemo' | 'Unavailable', message: string): WorkAttemptsStopOutput => ({
  error: { message, tag },
  ok: false,
});
const executeStopCommand: ExecuteStopReviewAttemptCommand = async (command, options) => {
  const control = await resolveUsageEngineControlClientForServer();
  return await executeUsageEngineCommandToCompletion(control, command, options);
};

/** Requests interruption only of an attempt the engine owns. Acknowledgement is not confirmed termination. */
export const stopWorkAttemptForServer = async (
  input: WorkAttemptsStopInput,
  execute: ExecuteStopReviewAttemptCommand = executeStopCommand,
  options: Omit<WorkAttemptsServerOptions, 'readers'> = {},
): Promise<WorkAttemptsStopOutput> => {
  const mode = options.mode ?? getServerRuntimeMode();
  options.signal?.throwIfAborted();
  if (mode === 'demo') {
    return stopFailure('ForbiddenDemo', 'Execution is not available in the demo.');
  }
  if (mode === 'e2e') {
    return stopFailure('Unavailable', 'Execution is not available in this runtime.');
  }
  const command = parseWebUsageEngineCommand({ attemptId: input.attemptId, command: 'stop-review-attempt' });
  if (command.command !== 'stop-review-attempt') {
    throw new Error('Expected a review stop command.');
  }
  let completion: UsageEngineCommandCompletion;
  try {
    completion = await execute(command, options.signal === undefined ? {} : { signal: options.signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    return stopFailure('Unavailable', 'The stop request did not complete; check the attempt before trying again.');
  }
  if (completion.state !== 'succeeded' || completion.command !== 'stop-review-attempt') {
    return stopFailure('Unavailable', 'The engine did not complete the stop request.');
  }
  const { attemptId, result } = completion.output;
  return parseWorkAttemptsStopOutput({ data: { attemptId, result }, ok: true });
};

export const stopWorkAttemptFromRequestForServer = async (
  request: Request,
  input: WorkAttemptsStopInput,
  execute?: ExecuteStopReviewAttemptCommand,
  mode?: RuntimeMode,
): Promise<WorkAttemptsStopOutput> => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    throw trustFailure;
  }
  return await stopWorkAttemptForServer(input, execute, {
    ...(mode === undefined ? {} : { mode }),
    signal: request.signal,
  });
};
