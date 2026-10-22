import { randomUUID } from 'node:crypto';
import {
  type ClaudeReviewLaunch,
  ClaudeReviewLaunchError,
  type ClaudeReviewLaunchEvents,
  type ClaudeReviewLaunchOptions,
  type ClaudeReviewLaunchSpec,
  type ClaudeReviewOutcome,
  launchClaudeReview,
} from '@ai-usage/local-collectors/claude-review-launcher';
import type { LocalHistoryStorage as LocalHistoryStorageService } from '@ai-usage/local-machine/local-history';
import { readLocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import { projectLatestProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  decideReviewLaunch,
  describeUnresolvedReviewReservation,
  isLiveReviewAttemptState,
  REVIEW_ATTEMPT_ACTION,
  REVIEW_ATTEMPT_LIVE_STATES,
  type ReviewAttempt,
  type ReviewAttemptState,
  type ReviewAttemptTarget,
  type ReviewLaunchDecision,
  resolveReviewCheckoutPath,
  reviewAttemptIdempotencyKey,
  SUPPORTED_REVIEW_EXECUTOR,
  type UnresolvedReviewReservation,
} from '@ai-usage/report-core/work-attempts';
import type { ReviewTarget } from '@ai-usage/report-core/work-routing';
import type { UsageEngineCommand } from '@ai-usage/usage-engine-control';
import {
  markReviewAttemptsLost,
  queryLatestExecutorObservations,
  queryLatestProviderQuotaObservations,
  queryReviewAttempts,
  queryReviewTargetResolution,
  type ReviewAttemptPatch,
  type ReviewTargetResolutionFacts,
  releaseReviewAttemptReservation,
  requestReviewAttempt,
  transitionReviewAttempt,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createProcessTableScanner, type FindReviewProcesses } from './review-attempts-process';
import type { UsageEngineReviewAttemptPort } from './runtime';

/**
 * The engine side of a review attempt (ADR 0053, 0055). One command, `start-review-attempt`, does
 * in this order: read the facts (declarations and review targets from the home config, executor
 * observations and quota from the store, the target's checkout from the Desktop session or the
 * served Session), settle any reservation a lost attempt still holds on the target with process
 * evidence, decide with the pure policy, record the attempt, spawn the harness, and return. The
 * process then runs in the background of the engine process; its heartbeats and its end are
 * written to the same row. Nothing here is decided by the browser, nothing is relaunched, and no
 * process this engine did not start is ever adopted or signalled.
 */
type StartReviewAttemptCommand = Extract<UsageEngineCommand, { readonly command: 'start-review-attempt' }>;

export type ReviewLauncher = (
  spec: ClaudeReviewLaunchSpec,
  events: ClaudeReviewLaunchEvents,
  options: ClaudeReviewLaunchOptions,
) => Promise<ClaudeReviewLaunch>;

export interface ReviewAttemptServiceOptions {
  readonly dbPath: string;
  /** Looks for the process a lost attempt started; defaults to the Linux process table. */
  readonly findProcesses?: FindReviewProcesses;
  /** Defaults to the Claude Code launcher; tests inject a fake. */
  readonly launcher?: ReviewLauncher;
  /** Launcher options forwarded as-is (executable override, source environment). */
  readonly launchOptions?: ClaudeReviewLaunchOptions;
  /** Resolved lazily: the engine knows its machine only after `validateConfig`. */
  readonly machine: () => UsageMachine;
  readonly now?: () => Date;
  /** Diagnostics for the operator log; never carries a transcript or a path the operator did not declare. */
  readonly report?: (line: string) => void;
  readonly runLimits?: Partial<
    Pick<ClaudeReviewLaunchSpec, 'heartbeatMs' | 'maxOutputBytes' | 'maxTurns' | 'timeoutMs'>
  >;
  /** The engine's writer gate; short store writes go through it. */
  readonly runWithWriter?: <Value>(operation: () => Promise<Value>, signal?: AbortSignal) => Promise<Value>;
  readonly storage: LocalHistoryStorageService;
}

export interface ReviewAttemptService extends UsageEngineReviewAttemptPort {
  /** Attempt ids whose process is still tracked by this engine. */
  readonly live: () => readonly string[];
  /**
   * Marks every attempt still recorded live for this machine as `lost`: after a restart the engine
   * holds no pipe to any of them. Each keeps its reservation unless the process table shows that no
   * process carries its launch session id. Writes directly, without the gate: it runs inside the
   * gated startup recovery.
   */
  readonly recoverLost: () => Promise<readonly string[]>;
  /** Waits for every tracked process to settle; tests use it. */
  readonly settle: () => Promise<void>;
  /**
   * Terminates the processes this engine started, waits for each exit and records it (a stop at
   * shutdown, partial output kept); rows still live without a tracked process become `lost` and
   * keep their reservation. Called before the store is quiesced.
   */
  readonly shutdown: () => Promise<void>;
}

interface TrackedRun {
  readonly launch: ClaudeReviewLaunch;
  readonly settled: Promise<void>;
}

const SHUTDOWN_LOST_REASON =
  'engine stopped before this attempt had a tracked process; verify in the harness (the target stays reserved)';
const SHUTDOWN_STOP_REASON = 'stopped at engine shutdown: the engine terminated its process and saw it exit';

const reviewTargetFor = (
  machineId: string,
  command: StartReviewAttemptCommand,
  facts: ReviewTargetResolutionFacts,
): ReviewTarget => ({
  harness: command.target.harness,
  kind: 'session',
  machineId,
  projectLabel: facts.session?.projectLabel ?? null,
  sourceSessionId: command.target.sourceSessionId,
});

const bounded = (value: string | null | undefined, maximum: number): string | null =>
  value === null || value === undefined ? null : value.slice(0, maximum);

const outcomeFields = (outcome: ClaudeReviewOutcome, endedAt: string): Omit<ReviewAttemptPatch, 'state'> => ({
  durationMs: outcome.durationMs,
  endedAt,
  exitCode: outcome.exitCode,
  failureReason: outcome.failureReason,
  nativeSessionId: outcome.nativeSessionId,
  numTurns: outcome.numTurns,
  resultExcerpt: outcome.resultExcerpt,
  resultKind: outcome.resultKind,
  // A read-only review runs no verification command; the empty list is the truth, not a default.
  validations: [],
});

const launchFailureReason = (error: unknown): string => {
  if (error instanceof ClaudeReviewLaunchError) {
    return error.kind === 'scope-unavailable'
      ? `scope-unavailable: ${error.message}`
      : `executor-unavailable: ${error.message}`;
  }
  return `executor-unavailable: ${error instanceof Error ? error.message : String(error)}`;
};

export const createReviewAttemptService = (options: ReviewAttemptServiceOptions): ReviewAttemptService => {
  const now = options.now ?? (() => new Date());
  const launcher = options.launcher ?? launchClaudeReview;
  const findProcesses = options.findProcesses ?? createProcessTableScanner();
  const runWithWriter = options.runWithWriter ?? (async <Value>(operation: () => Promise<Value>) => await operation());
  const report = options.report ?? (() => undefined);
  const runs = new Map<string, TrackedRun>();
  const starts = new Set<Promise<unknown>>();
  let stopping = false;

  const gated = <Value>(operation: () => Promise<Value>, signal?: AbortSignal): Promise<Value> =>
    runWithWriter(operation, signal);

  /** Applies a patch from the live states, or from `fromStates` only when given; `false` when the row was elsewhere. */
  const transition = async (
    attemptId: string,
    patch: ReviewAttemptPatch,
    at: string = now().toISOString(),
    fromStates?: readonly ReviewAttemptState[],
  ): Promise<boolean> =>
    (
      await gated(() =>
        Effect.runPromise(
          transitionReviewAttempt({
            at,
            attemptId,
            dbPath: options.dbPath,
            patch,
            ...(fromStates === undefined ? {} : { fromStates }),
          }),
        ),
      )
    ).applied;

  const readFacts = async (machineId: string, command: StartReviewAttemptCommand, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const [routing, observations, quotas, facts] = await Promise.all([
      readLocalRoutingDeclarations(options.storage.home),
      Effect.runPromise(queryLatestExecutorObservations({ dbPath: options.dbPath, machineId })),
      Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath: options.dbPath, machineId })),
      Effect.runPromise(
        queryReviewTargetResolution({
          dbPath: options.dbPath,
          desktopSessionId: command.target.desktopSessionId,
          harness: command.target.harness,
          machineId,
          sourceSessionId: command.target.sourceSessionId,
        }),
      ),
    ]);
    signal?.throwIfAborted();
    return {
      declarations: routing.declarations,
      executorObservations: observations.observations,
      facts,
      providers: quotas.observations.map(projectLatestProviderQuotaObservation),
      reviewTargets: routing.reviewTargets,
    };
  };

  /**
   * Looks for the process a lost attempt started. `null` once the reservation is released (no
   * process carries the launch session id); otherwise what keeps it held, for the refusal.
   */
  const settleLostReservation = async (
    attempt: ReviewAttempt,
    write: <Value>(operation: () => Promise<Value>) => Promise<Value>,
  ): Promise<UnresolvedReviewReservation | null> => {
    const unresolved = (
      evidence: UnresolvedReviewReservation['evidence'],
      pids: readonly number[] = [],
    ): UnresolvedReviewReservation => ({
      attemptId: attempt.attemptId,
      evidence,
      launchSessionId: attempt.launchSessionId,
      lostAt: attempt.endedAt,
      pids,
    });
    if (runs.has(attempt.attemptId)) {
      // This engine still holds the pipe; the process is its own and alive.
      return unresolved('process-running', [runs.get(attempt.attemptId)?.launch.pid ?? 0]);
    }
    if (attempt.launchSessionId === null) {
      return unresolved('process-evidence-unavailable');
    }
    const scan = await findProcesses(attempt.launchSessionId);
    if (scan.kind === 'found') {
      return unresolved('process-running', scan.pids);
    }
    if (scan.kind === 'unavailable') {
      return unresolved('process-evidence-unavailable');
    }
    await write(() =>
      Effect.runPromise(
        releaseReviewAttemptReservation({
          at: now().toISOString(),
          attemptId: attempt.attemptId,
          dbPath: options.dbPath,
          evidence: 'process-absent',
        }),
      ),
    );
    report(`usage-engine review-attempt=released attempt=${attempt.attemptId} evidence=process-absent`);
    return null;
  };

  const track = (attempt: ReviewAttempt, launch: ClaudeReviewLaunch): void => {
    const settled = (async () => {
      try {
        const outcome = await launch.outcome;
        const endedAt = now().toISOString();
        const fields = outcomeFields(outcome, endedAt);
        // A process that finished before the stop took effect keeps its result; one the stop ended
        // says so, with whatever it produced until then.
        const stoppedAtShutdown = stopping && outcome.kind === 'failed';
        const applied = await transition(
          attempt.attemptId,
          stoppedAtShutdown
            ? {
                ...fields,
                failureReason: `${SHUTDOWN_STOP_REASON} (${outcome.failureReason ?? 'no reason'})`,
                resultKind: 'error',
                state: 'failed',
              }
            : { ...fields, state: outcome.kind },
          endedAt,
        );
        let late = false;
        if (!applied) {
          // The row left the live states without this engine: contact was recorded lost while the
          // process ran. Its end is now known, so the outcome is recorded and the reservation released.
          late = (
            await gated(() =>
              Effect.runPromise(
                releaseReviewAttemptReservation({
                  at: endedAt,
                  attemptId: attempt.attemptId,
                  dbPath: options.dbPath,
                  evidence: 'outcome-recorded-late',
                  outcome: fields,
                }),
              ),
            )
          ).applied;
        }
        report(
          `usage-engine review-attempt=${stoppedAtShutdown ? 'stopped' : outcome.kind} attempt=${attempt.attemptId} exit=${outcome.exitCode ?? 'null'} turns=${outcome.numTurns ?? 'null'} applied=${applied} late=${late}`,
        );
      } catch (error) {
        report(
          `usage-engine review-attempt=write-failed attempt=${attempt.attemptId} reason=${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        runs.delete(attempt.attemptId);
      }
    })();
    runs.set(attempt.attemptId, { launch, settled });
  };

  const launchFor = async (attempt: ReviewAttempt, decision: Extract<ReviewLaunchDecision, { kind: 'allowed' }>) => {
    if (attempt.launchSessionId === null) {
      throw new Error(`review attempt ${attempt.attemptId} has no launch session id`);
    }
    const spec: ClaudeReviewLaunchSpec = {
      checkoutPath: decision.checkout.checkoutPath,
      effort: decision.declaration.effort,
      launchSessionId: attempt.launchSessionId,
      // The launched model is the candidate's: an alternate-model candidate (ADR 0057) shares its
      // declaration but not its primary model. The launcher records it in the guarantee beside the
      // scope, so the result names the model that produced it.
      model: decision.candidate.model,
      sessionTitle: attempt.target.sessionTitle,
      ...options.runLimits,
    };
    const events: ClaudeReviewLaunchEvents = {
      onHeartbeat: async () => {
        if (!stopping) {
          await transition(attempt.attemptId, {});
        }
      },
      onInit: async (nativeSessionId) => {
        if (!stopping) {
          await transition(attempt.attemptId, { nativeSessionId, state: 'running' });
        }
      },
    };
    return await launcher(spec, events, options.launchOptions ?? {});
  };

  const startAttempt: ReviewAttemptService['start'] = async (command, signal) => {
    const machineId = options.machine().id;
    const requestedAt = now().toISOString();
    const read = await readFacts(machineId, command, signal);
    const checkout = resolveReviewCheckoutPath({
      desktop:
        read.facts.desktop === null
          ? null
          : { cwd: read.facts.desktop.cwd, worktreePath: read.facts.desktop.worktreePath },
      session: read.facts.session === null ? null : { sourcePath: read.facts.session.sourcePath },
    });
    const idempotencyKey = await reviewAttemptIdempotencyKey({
      action: REVIEW_ATTEMPT_ACTION,
      checkoutPath: checkout?.checkoutPath ?? null,
      harness: command.target.harness,
      machineId,
      sourceSessionId: command.target.sourceSessionId,
    });
    const reservingForTarget = await Effect.runPromise(
      queryReviewAttempts({
        dbPath: options.dbPath,
        machineId,
        reserving: true,
        target: { harness: command.target.harness, sourceSessionId: command.target.sourceSessionId },
      }),
    );
    signal?.throwIfAborted();
    const sameIdentity = reservingForTarget.attempts.find(
      (attempt) => attempt.idempotencyKey === idempotencyKey && isLiveReviewAttemptState(attempt.state),
    );
    if (sameIdentity) {
      return {
        attempt: { attemptId: sameIdentity.attemptId, reused: true, state: sameIdentity.state },
        kind: 'review-attempt',
        refusal: null,
      };
    }
    // A lost attempt on this target keeps its reservation until the process it started is shown
    // gone; the first one still held is the refusal's subject.
    let unresolvedAttempt: UnresolvedReviewReservation | null = null;
    for (const lost of reservingForTarget.attempts.filter((attempt) => attempt.state === 'lost')) {
      const held = await settleLostReservation(lost, (operation) => gated(operation, signal));
      unresolvedAttempt ??= held;
    }
    const otherLiveAttempt =
      reservingForTarget.attempts.find((attempt) => isLiveReviewAttemptState(attempt.state)) ?? null;
    const decision = decideReviewLaunch({
      candidateId: command.candidateId,
      checkout,
      declarations: read.declarations,
      executorObservations: read.executorObservations,
      now: requestedAt,
      otherLiveAttempt,
      providers: read.providers,
      reviewTargets: read.reviewTargets,
      target: reviewTargetFor(machineId, command, read.facts),
      unresolvedAttempt,
    });
    const target: ReviewAttemptTarget = {
      checkoutOrigin: checkout?.origin ?? null,
      checkoutPath: checkout?.checkoutPath ?? null,
      // The resolved row's id only: a named id that matched no row of this transcript is not recorded.
      desktopSessionId: read.facts.desktop?.desktopSessionId ?? null,
      harness: command.target.harness,
      projectLabel: bounded(read.facts.session?.projectLabel, 256),
      sessionTitle: bounded(read.facts.desktop?.title ?? read.facts.session?.name, 256),
      sourceSessionId: command.target.sourceSessionId,
    };
    const refuse = async (reason: Extract<ReviewLaunchDecision, { kind: 'refused' }>) => {
      const refused = await gated(
        () =>
          Effect.runPromise(
            requestReviewAttempt({
              attempt: {
                candidateId: command.candidateId,
                declaration: null,
                executorHarness: SUPPORTED_REVIEW_EXECUTOR,
                failureReason: `${reason.reason}: ${reason.message}`,
                idempotencyKey,
                machineId,
                requestedAt,
                state: 'refused',
                target,
              },
              dbPath: options.dbPath,
            }),
          ),
        signal,
      );
      report(`usage-engine review-attempt=refused attempt=${refused.attempt.attemptId} reason=${reason.reason}`);
      return {
        attempt: { attemptId: refused.attempt.attemptId, reused: false, state: 'refused' as const },
        kind: 'review-attempt' as const,
        refusal: { message: reason.message, reason: reason.reason },
      };
    };
    if (decision.kind === 'refused') {
      return await refuse(decision);
    }
    const requested = await gated(
      () =>
        Effect.runPromise(
          requestReviewAttempt({
            attempt: {
              candidateId: command.candidateId,
              declaration: decision.declaration,
              executorHarness: decision.candidate.harness,
              idempotencyKey,
              launchSessionId: randomUUID(),
              machineId,
              requestedAt,
              state: 'requested',
              target,
            },
            dbPath: options.dbPath,
          }),
        ),
      signal,
    );
    if (requested.reused) {
      if (requested.attempt.state === 'lost') {
        // Recorded lost between the read above and this write: still held, never twinned.
        const held = await settleLostReservation(requested.attempt, (operation) => gated(operation, signal));
        if (held !== null) {
          return await refuse({
            kind: 'refused',
            message: describeUnresolvedReviewReservation(held),
            missing: [],
            reason: 'attempt-unresolved',
          });
        }
      }
      return {
        attempt: { attemptId: requested.attempt.attemptId, reused: true, state: requested.attempt.state },
        kind: 'review-attempt',
        refusal: null,
      };
    }
    const attempt = requested.attempt;
    let launch: ClaudeReviewLaunch;
    try {
      if (stopping) {
        throw new Error('the engine is stopping; the review was not launched');
      }
      launch = await launchFor(attempt, decision);
    } catch (error) {
      const endedAt = now().toISOString();
      const message = launchFailureReason(error);
      await transition(
        attempt.attemptId,
        { endedAt, failureReason: message, resultKind: 'error', state: 'failed' },
        endedAt,
      );
      report(`usage-engine review-attempt=failed attempt=${attempt.attemptId} reason=${message.split(':')[0]}`);
      return {
        attempt: { attemptId: attempt.attemptId, reused: false, state: 'failed' },
        kind: 'review-attempt',
        refusal: null,
      };
    }
    const startedAt = now().toISOString();
    // `starting` is a step out of `requested` only. The harness may already have reported its
    // init (`running`) or ended before this write lands; then the process identity, the reviewed
    // scope and the harness guarantee are recorded from whatever live state the row is in, and
    // the state is never stepped back.
    const identity = { guarantee: launch.guarantee, pid: launch.pid, scope: launch.scope, startedAt };
    let starting = false;
    try {
      starting = await transition(attempt.attemptId, { ...identity, state: 'starting' }, startedAt, ['requested']);
      if (!starting) {
        await transition(attempt.attemptId, identity, startedAt);
      }
    } finally {
      // Tracked whatever the writes did: a process this engine started is always one it can stop.
      track(attempt, launch);
    }
    const state = starting ? 'starting' : await recordedState(machineId, attempt);
    report(`usage-engine review-attempt=${state} attempt=${attempt.attemptId} pid=${launch.pid}`);
    return {
      attempt: { attemptId: attempt.attemptId, reused: false, state },
      kind: 'review-attempt',
      refusal: null,
    };
  };

  const start: ReviewAttemptService['start'] = async (command, signal) => {
    if (stopping) {
      throw new Error('The engine is stopping; no review attempt can start.');
    }
    const pending = startAttempt(command, signal);
    starts.add(pending);
    try {
      return await pending;
    } finally {
      starts.delete(pending);
    }
  };

  /** The state the store holds for an attempt this command inserted; read when a write did not apply. */
  const recordedState = async (machineId: string, attempt: ReviewAttempt): Promise<ReviewAttemptState> => {
    const listed = await Effect.runPromise(
      queryReviewAttempts({
        dbPath: options.dbPath,
        machineId,
        target: { harness: attempt.target.harness, sourceSessionId: attempt.target.sourceSessionId },
      }),
    );
    const row = listed.attempts.find((candidate) => candidate.attemptId === attempt.attemptId);
    if (row === undefined) {
      throw new Error(`review attempt ${attempt.attemptId} is no longer readable after its launch`);
    }
    return row.state;
  };

  const recoverLost: ReviewAttemptService['recoverLost'] = async () => {
    const at = now().toISOString();
    const machineId = options.machine().id;
    const live = await Effect.runPromise(
      queryReviewAttempts({ dbPath: options.dbPath, machineId, states: REVIEW_ATTEMPT_LIVE_STATES }),
    );
    // Look for each process before recording the loss, so the reason says what was found.
    const scans = new Map<string, Awaited<ReturnType<FindReviewProcesses>>>();
    for (const attempt of live.attempts) {
      if (attempt.launchSessionId !== null) {
        scans.set(attempt.attemptId, await findProcesses(attempt.launchSessionId));
      }
    }
    const describe = (attemptId: string): string => {
      const scan = scans.get(attemptId);
      if (scan === undefined) {
        return 'no launch marker was recorded, so the process cannot be looked for; the target stays reserved';
      }
      if (scan.kind === 'found') {
        return `a process carrying its launch marker still runs (pid ${scan.pids.slice(0, 4).join(', ')}); it is not adopted or stopped, and the target stays reserved`;
      }
      if (scan.kind === 'unavailable') {
        return `the process table is not readable (${scan.reason}); the target stays reserved`;
      }
      return 'no process carries its launch marker, so the reservation is released';
    };
    const result = await Effect.runPromise(
      markReviewAttemptsLost({
        at,
        dbPath: options.dbPath,
        machineId,
        reason: ({ attemptId, state }) => `engine restarted while ${state}; ${describe(attemptId)}`,
      }),
    );
    for (const attemptId of result.lost) {
      if (scans.get(attemptId)?.kind === 'absent') {
        await Effect.runPromise(
          releaseReviewAttemptReservation({ at, attemptId, dbPath: options.dbPath, evidence: 'process-absent' }),
        );
      }
    }
    if (result.lost.length > 0) {
      const held = result.lost.filter((attemptId) => scans.get(attemptId)?.kind !== 'absent').length;
      report(`usage-engine review-attempt=lost count=${result.lost.length} held=${held} phase=startup`);
    }
    return result.lost;
  };

  const settle: ReviewAttemptService['settle'] = async () => {
    await Promise.all([...runs.values()].map((run) => run.settled));
  };

  const shutdown: ReviewAttemptService['shutdown'] = async () => {
    stopping = true;
    // A start in flight either launched (and is tracked once it returns) or recorded its failure.
    await Promise.allSettled([...starts]);
    const tracked = [...runs.values()];
    for (const run of tracked) {
      run.launch.terminate();
    }
    await Promise.all(tracked.map((run) => run.settled));
    const remaining = await Effect.runPromise(
      queryReviewAttempts({
        dbPath: options.dbPath,
        machineId: options.machine().id,
        states: REVIEW_ATTEMPT_LIVE_STATES,
      }),
    );
    if (remaining.attempts.length === 0) {
      if (tracked.length > 0) {
        report(`usage-engine review-attempt=stopped count=${tracked.length} phase=shutdown`);
      }
      return;
    }
    const at = now().toISOString();
    await gated(() =>
      Effect.runPromise(
        markReviewAttemptsLost({
          at,
          dbPath: options.dbPath,
          machineId: options.machine().id,
          reason: () => SHUTDOWN_LOST_REASON,
        }),
      ),
    );
    report(
      `usage-engine review-attempt=lost count=${remaining.attempts.length} stopped=${tracked.length} phase=shutdown`,
    );
  };

  return { live: () => [...runs.keys()], recoverLost, settle, shutdown, start };
};
