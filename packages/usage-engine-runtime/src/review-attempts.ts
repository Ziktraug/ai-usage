import {
  type ClaudeReviewLaunch,
  ClaudeReviewLaunchError,
  type ClaudeReviewLaunchEvents,
  type ClaudeReviewLaunchOptions,
  type ClaudeReviewLaunchSpec,
  launchClaudeReview,
} from '@ai-usage/local-collectors/claude-review-launcher';
import type { LocalHistoryStorage as LocalHistoryStorageService } from '@ai-usage/local-machine/local-history';
import { readLocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import { projectLatestProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  decideReviewLaunch,
  REVIEW_ATTEMPT_ACTION,
  REVIEW_ATTEMPT_LIVE_STATES,
  type ReviewAttempt,
  type ReviewAttemptState,
  type ReviewAttemptTarget,
  type ReviewLaunchDecision,
  resolveReviewCheckoutPath,
  reviewAttemptIdempotencyKey,
  SUPPORTED_REVIEW_EXECUTOR,
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
  requestReviewAttempt,
  transitionReviewAttempt,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import type { UsageEngineReviewAttemptPort } from './runtime';

/**
 * The engine side of a review attempt (ADR 0053). One command, `start-review-attempt`, does in
 * this order: read the facts (declarations and review targets from the home config, executor
 * observations and quota from the store, the target's checkout from the Desktop session or the
 * served Session), decide with the pure policy, record the attempt, spawn the harness, and return.
 * The process then runs in the background of the engine process; its heartbeats and its end are
 * written to the same row. Nothing here is decided by the browser, and nothing is relaunched.
 */
type StartReviewAttemptCommand = Extract<UsageEngineCommand, { readonly command: 'start-review-attempt' }>;

export type ReviewLauncher = (
  spec: ClaudeReviewLaunchSpec,
  events: ClaudeReviewLaunchEvents,
  options: ClaudeReviewLaunchOptions,
) => Promise<ClaudeReviewLaunch>;

export interface ReviewAttemptServiceOptions {
  readonly dbPath: string;
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
   * holds no pipe to any of them. Writes directly, without the gate: it runs inside the gated
   * startup recovery.
   */
  readonly recoverLost: () => Promise<readonly string[]>;
  /** Waits for every tracked process to settle; tests use it. */
  readonly settle: () => Promise<void>;
  /** Terminates tracked processes and marks them lost; called before the store is quiesced. */
  readonly shutdown: () => Promise<void>;
}

interface TrackedRun {
  readonly launch: ClaudeReviewLaunch;
  readonly settled: Promise<void>;
}

const SHUTDOWN_REASON = 'engine stopped while the attempt was running; verify in the harness';

const processAlive = (pid: number | null): boolean => {
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

export const createReviewAttemptService = (options: ReviewAttemptServiceOptions): ReviewAttemptService => {
  const now = options.now ?? (() => new Date());
  const launcher = options.launcher ?? launchClaudeReview;
  const runWithWriter = options.runWithWriter ?? (async <Value>(operation: () => Promise<Value>) => await operation());
  const report = options.report ?? (() => undefined);
  const runs = new Map<string, TrackedRun>();
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

  const track = (attempt: ReviewAttempt, launch: ClaudeReviewLaunch): void => {
    const settled = (async () => {
      try {
        const outcome = await launch.outcome;
        if (stopping) {
          return;
        }
        const endedAt = now().toISOString();
        const applied = await transition(
          attempt.attemptId,
          {
            durationMs: outcome.durationMs,
            endedAt,
            exitCode: outcome.exitCode,
            failureReason: outcome.failureReason,
            nativeSessionId: outcome.nativeSessionId,
            numTurns: outcome.numTurns,
            resultExcerpt: outcome.resultExcerpt,
            resultKind: outcome.resultKind,
            state: outcome.kind,
            // A read-only review runs no verification command; the empty list is the truth, not a default.
            validations: [],
          },
          endedAt,
        );
        report(
          `usage-engine review-attempt=${outcome.kind} attempt=${attempt.attemptId} exit=${outcome.exitCode ?? 'null'} turns=${outcome.numTurns ?? 'null'} applied=${applied}`,
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
    const spec: ClaudeReviewLaunchSpec = {
      checkoutPath: decision.checkout.checkoutPath,
      effort: decision.declaration.effort,
      model: decision.declaration.model,
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

  const start: ReviewAttemptService['start'] = async (command, signal) => {
    if (stopping) {
      throw new Error('The engine is stopping; no review attempt can start.');
    }
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
    const liveForTarget = await Effect.runPromise(
      queryReviewAttempts({
        dbPath: options.dbPath,
        machineId,
        states: REVIEW_ATTEMPT_LIVE_STATES,
        target: { harness: command.target.harness, sourceSessionId: command.target.sourceSessionId },
      }),
    );
    signal?.throwIfAborted();
    const sameIdentity = liveForTarget.attempts.find((attempt) => attempt.idempotencyKey === idempotencyKey);
    if (sameIdentity) {
      return {
        attempt: { attemptId: sameIdentity.attemptId, reused: true, state: sameIdentity.state },
        kind: 'review-attempt',
        refusal: null,
      };
    }
    const otherLiveAttempt = liveForTarget.attempts[0] ?? null;
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
    if (decision.kind === 'refused') {
      const refused = await gated(
        () =>
          Effect.runPromise(
            requestReviewAttempt({
              attempt: {
                candidateId: command.candidateId,
                declaration: null,
                executorHarness: SUPPORTED_REVIEW_EXECUTOR,
                failureReason: `${decision.reason}: ${decision.message}`,
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
      report(`usage-engine review-attempt=refused attempt=${refused.attempt.attemptId} reason=${decision.reason}`);
      return {
        attempt: { attemptId: refused.attempt.attemptId, reused: false, state: 'refused' },
        kind: 'review-attempt',
        refusal: { message: decision.message, reason: decision.reason },
      };
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
      return {
        attempt: { attemptId: requested.attempt.attemptId, reused: true, state: requested.attempt.state },
        kind: 'review-attempt',
        refusal: null,
      };
    }
    const attempt = requested.attempt;
    let launch: ClaudeReviewLaunch;
    try {
      launch = await launchFor(attempt, decision);
    } catch (error) {
      const endedAt = now().toISOString();
      const message =
        error instanceof ClaudeReviewLaunchError
          ? `executor-unavailable: ${error.message}`
          : `executor-unavailable: ${error instanceof Error ? error.message : String(error)}`;
      await transition(
        attempt.attemptId,
        { endedAt, failureReason: message, resultKind: 'error', state: 'failed' },
        endedAt,
      );
      report(`usage-engine review-attempt=failed attempt=${attempt.attemptId} reason=spawn`);
      return {
        attempt: { attemptId: attempt.attemptId, reused: false, state: 'failed' },
        kind: 'review-attempt',
        refusal: null,
      };
    }
    const startedAt = now().toISOString();
    // `starting` is a step out of `requested` only. The harness may already have reported its
    // init (`running`) or ended before this write lands; then the process identity is recorded
    // from whatever live state the row is in, and the state is never stepped back.
    const starting = await transition(attempt.attemptId, { pid: launch.pid, startedAt, state: 'starting' }, startedAt, [
      'requested',
    ]);
    if (!starting) {
      await transition(attempt.attemptId, { pid: launch.pid, startedAt }, startedAt);
    }
    track(attempt, launch);
    const state = starting ? 'starting' : await recordedState(machineId, attempt);
    report(`usage-engine review-attempt=${state} attempt=${attempt.attemptId} pid=${launch.pid}`);
    return {
      attempt: { attemptId: attempt.attemptId, reused: false, state },
      kind: 'review-attempt',
      refusal: null,
    };
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
    const result = await Effect.runPromise(
      markReviewAttemptsLost({
        at,
        dbPath: options.dbPath,
        machineId: options.machine().id,
        reason: ({ pid, state }) =>
          `engine restarted while ${state}${
            processAlive(pid) ? `; a process with pid ${pid} is still alive, verify in the harness` : ''
          }`,
      }),
    );
    if (result.lost.length > 0) {
      report(`usage-engine review-attempt=lost count=${result.lost.length} phase=startup`);
    }
    return result.lost;
  };

  const settle: ReviewAttemptService['settle'] = async () => {
    await Promise.all([...runs.values()].map((run) => run.settled));
  };

  const shutdown: ReviewAttemptService['shutdown'] = async () => {
    stopping = true;
    const tracked = [...runs.values()];
    for (const run of tracked) {
      run.launch.terminate();
    }
    await Promise.all(tracked.map((run) => run.settled));
    if (tracked.length === 0) {
      return;
    }
    const at = now().toISOString();
    await gated(() =>
      Effect.runPromise(
        markReviewAttemptsLost({
          at,
          dbPath: options.dbPath,
          machineId: options.machine().id,
          reason: () => SHUTDOWN_REASON,
        }),
      ),
    );
    report(`usage-engine review-attempt=lost count=${tracked.length} phase=shutdown`);
  };

  return { live: () => [...runs.keys()], recoverLost, settle, shutdown, start };
};
