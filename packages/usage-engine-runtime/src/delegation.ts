import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareReviewScope, ReviewScopeError } from '@ai-usage/local-collectors/claude-review-scope';
import { claudeReviewWorkerAdapter } from '@ai-usage/local-collectors/claude-review-worker';
import { codexReviewWorkerAdapter } from '@ai-usage/local-collectors/codex-review-worker';
import {
  freezeDelegationScope,
  readDelegationCheckoutFacts,
  resolveDelegationCheckout,
} from '@ai-usage/local-collectors/delegation-checkout';
import {
  type ClaudeAccountProbe,
  type CodexAuthProbe,
  probeClaudeAccount,
  probeCodexAuth,
} from '@ai-usage/local-collectors/executor-observations';
import {
  DELEGATION_HARNESS_CONTROLS,
  type ReviewWorkerAdapter,
  type ReviewWorkerEvents,
  type ReviewWorkerLaunch,
  ReviewWorkerLaunchError,
  type ReviewWorkerLaunchOptions,
  type ReviewWorkerOutcome,
  type ReviewWorkerSpec,
} from '@ai-usage/local-collectors/review-worker';
import type { LocalHistoryStorage as LocalHistoryStorageService } from '@ai-usage/local-machine/local-history';
import { LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { updateAiUsageConfig } from '@ai-usage/local-machine/machine-config';
import { ensurePrivateDirectory } from '@ai-usage/local-machine/private-storage';
import { readLocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import type {
  DelegationCheckoutFacts,
  DelegationExecutedScope,
  DelegationFact,
  DelegationJob,
  DelegationJobResult,
  DelegationQualification,
  DelegationRequest,
  DelegationRoute,
  FrozenDelegationScope,
  ResolvedDelegationCheckout,
} from '@ai-usage/report-core/delegation-contracts';
import { DELEGATION_JOB_BOUNDS, parseDelegationEvaluationInput } from '@ai-usage/report-core/delegation-job';
import { delegationPolicyRevision, parseDelegationConfig } from '@ai-usage/report-core/delegation-policy';
import {
  DELEGATION_QUALIFICATION_BOUNDS,
  type DelegationCheckoutInput,
  type DelegationReservations,
  type DelegationScopeInput,
  decideDelegationLaunch,
  parseDelegationQualification,
  qualifyDelegation,
} from '@ai-usage/report-core/delegation-qualification';
import {
  canonicalJson,
  delegationRequestDigest,
  delegationSelectionDigest,
  parseDelegationRequest,
  parseDelegationSelection,
  sha256Hex,
} from '@ai-usage/report-core/delegation-request';
import {
  boundDelegationExcerpt,
  buildDelegationPrompt,
  DELEGATION_OUTPUT_JSON_SCHEMA,
  parseDelegationWorkerOutput,
} from '@ai-usage/report-core/delegation-result';
import {
  DELEGATION_LIVE_STATES,
  DELEGATION_QUALIFIER_VERSION,
  DELEGATION_SCHEMA_VERSION,
  DELEGATION_SELECTION_CONTRACT,
  type DelegationJobState,
  type DelegationQualificationPurpose,
  type DelegationRefusalReason,
  type DelegationVerificationVerdict,
  isLiveDelegationState,
} from '@ai-usage/report-core/delegation-vocabulary';
import { projectLatestProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  parseReviewTargetDeclarations,
  REVIEW_ATTEMPT_RUN_LIMITS,
  type ReviewAttemptScope,
} from '@ai-usage/report-core/work-attempts';
import type { ReviewLaunchRefusalReason } from '@ai-usage/report-core/work-attempts-vocabulary';
import {
  type ExecutorDeclaration,
  executorAuthMethodIndicatesApiKey,
  executorDeclarationKey,
  parseExecutorDeclarations,
} from '@ai-usage/report-core/work-executors';
import { declarationForReviewCandidate } from '@ai-usage/report-core/work-routing';
import {
  boundUsageEngineReviewMessage,
  type UsageEngineCommand,
  type UsageEngineDelegationCancelOutput,
  type UsageEngineDelegationConfigOutput,
  type UsageEngineDelegationEvaluationOutput,
  type UsageEngineDelegationStartOutput,
} from '@ai-usage/usage-engine-control';
import {
  checkReviewReservations,
  countDelegationRetryChain,
  countReviewReservationsByPool,
  DELEGATION_STORE_BOUNDS,
  type DelegationJobPatch,
  describeReviewReservation,
  markDelegationJobsLost,
  type NewDelegationJob,
  queryDelegationJobs,
  queryExecutorAccountChanges,
  queryExecutorObservationHistory,
  queryLatestProviderQuotaObservations,
  queryReviewReservations,
  type ReviewReservationHolder,
  readDelegationQualification,
  recordDelegationEvaluation,
  recordDelegationQualification,
  releaseDelegationJobReservation,
  requestDelegationCancel,
  requestDelegationJob,
  reviewTargetReservationHolder,
  transitionDelegationJob,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createProcessTableScanner, type FindReviewProcesses } from './review-attempts-process';
import type { UsageEngineDelegationPort } from './runtime';

/**
 * The engine side of a delegation (ADR 0077), modelled on the review attempt service (ADR 0053,
 * 0055). Five commands, one FIFO: `qualify-delegation` reads the policy and the facts and records a
 * dated qualification; `start-delegation` re-qualifies with the same function, decides against the
 * cited qualification, records the decision as a row (refused, abstained or requested) and spawns
 * the chosen harness adapter, returning as soon as the process exists; `cancel-delegation`
 * terminates only a process this engine tracks; `record-delegation-evaluation` appends a judgment
 * under the author the edge names; `update-delegation-config` writes the home sections under an
 * expected policy revision. Heartbeats, the outcome and the engine's own output-contract check are
 * written to the same row in the background. Nothing here is decided by a caller's name, nothing is
 * relaunched, and no process this engine did not start is ever adopted or signalled.
 */
type StartCommand = Extract<UsageEngineCommand, { readonly command: 'start-delegation' }>;

export interface DelegationServiceOptions {
  /** Adapter options forwarded as-is (executable override, source environment); git reads share the environment. */
  readonly adapterOptions?: ReviewWorkerLaunchOptions;
  /** One adapter per executable harness; defaults to the Claude Code and Codex adapters. Tests inject fakes. */
  readonly adapters?: readonly ReviewWorkerAdapter[];
  readonly dbPath: string;
  /** Looks for the process a lost job started; defaults to the process table scanner. */
  readonly findProcesses?: FindReviewProcesses;
  /** Resolved lazily: the engine knows its machine only after `validateConfig`. */
  readonly machine: () => UsageMachine;
  /** Job, qualification and launch marker ids; defaults to `randomUUID`, injectable for tests. */
  readonly newId?: () => string;
  readonly now?: () => Date;
  /** Engine-owned directory (created 0700) holding one private subdirectory per job while it runs. */
  readonly privateRoot: string;
  /**
   * Reads the signed-in Claude Code account now, with the launch's own executable and environment; a
   * pinned route is re-checked with it at start (ADR 0057). Defaults to `claude auth status`.
   */
  readonly probeClaudeAccount?: () => Promise<ClaudeAccountProbe>;
  /**
   * Reads the Codex sign-in now, with the launch's own executable and `CODEX_HOME`; a Codex route is
   * re-checked with it at start: signed out refuses the executor, an API-key sign-in refuses the route
   * (subscription-only). Defaults to `codex login status`.
   */
  readonly probeCodexAuth?: () => Promise<CodexAuthProbe>;
  /** Diagnostics for the operator log; never a prompt, a transcript or a path the operator did not declare. */
  readonly report?: (line: string) => void;
  readonly runLimits?: Partial<Pick<ReviewWorkerSpec, 'heartbeatMs' | 'maxOutputBytes' | 'maxTurns' | 'timeoutMs'>>;
  /** The engine's writer gate; short store writes go through it. */
  readonly runWithWriter?: <Value>(operation: () => Promise<Value>, signal?: AbortSignal) => Promise<Value>;
  readonly storage: LocalHistoryStorageService;
}

export interface ReviewAdmissionInput {
  /** The checkout the legacy review would run in (the session's); resolved canonically here. */
  readonly checkoutPath: string;
  /** The legacy candidate id, which is the delegation route id (`declared:<key>[:model:…]`). */
  readonly routeId: string;
  readonly signal?: AbortSignal | undefined;
}

export type ReviewAdmissionRefusalReason = Extract<
  ReviewLaunchRefusalReason,
  | 'executor-unavailable'
  | 'identity-changed'
  | 'policy-refused'
  | 'pool-busy'
  | 'scope-unavailable'
  | 'target-not-allowed'
  | 'target-reserved'
>;

/**
 * The common review policy's answer for a launch that did not come in as a delegation request
 * (the Work view's legacy `start-review-attempt`): the route is present in a fresh qualification
 * and admissible, with the canonical checkout and the frozen revision the launch must use, or a
 * typed refusal carrying the route's exclusions. Session-independent: the port takes a checkout
 * path, never a session.
 */
export type ReviewAdmission =
  | {
      readonly checkout: ResolvedDelegationCheckout;
      readonly kind: 'admitted';
      readonly route: DelegationRoute;
      readonly scope: FrozenDelegationScope;
    }
  | { readonly kind: 'refused'; readonly message: string; readonly reason: ReviewAdmissionRefusalReason };

export type ReviewAdmissionPort = (input: ReviewAdmissionInput) => Promise<ReviewAdmission>;

export interface DelegationService extends UsageEngineDelegationPort {
  /**
   * Runs the same assessment a `start-delegation` runs (canonical checkout admission, frozen
   * scope, the home `delegation` rules, identity evidence, reserve, the reservations of both
   * review families) for a review that enters through another command; records nothing.
   */
  readonly admitReview: ReviewAdmissionPort;
  /** Job ids whose process is still tracked by this engine. */
  readonly live: () => readonly string[];
  /**
   * Marks every job still recorded live for this machine as `lost`: after a restart the engine holds
   * no pipe to any of them. Each keeps its reservation unless the process table shows that no process
   * carries its launch marker. Writes directly, without the gate: it runs inside the gated startup.
   */
  readonly recoverLost: () => Promise<readonly string[]>;
  /** Waits for every tracked process to settle; tests use it. */
  readonly settle: () => Promise<void>;
  /**
   * Terminates the processes this engine started, waits for each exit and records it (a stop at
   * shutdown, partial output kept); rows still live without a tracked process become `lost` and keep
   * their reservation. Called before the store is quiesced.
   */
  readonly shutdown: () => Promise<void>;
}

interface TrackedRun {
  readonly launch: ReviewWorkerLaunch;
  readonly settled: Promise<void>;
}

/** What the engine read and decided for one request, shared by a qualification and a launch. */
interface Assessment {
  readonly checkout: ResolvedDelegationCheckout | null;
  readonly declarations: readonly ExecutorDeclaration[];
  readonly qualification: DelegationQualification;
  /** The reserving rows of both families the qualification counted; a `pool-busy` refusal names them. */
  readonly reservationHolders: readonly ReviewReservationHolder[];
  readonly scope: FrozenDelegationScope | null;
}

interface Conclusion {
  readonly check: { readonly note: string; readonly verdict: DelegationVerificationVerdict } | null;
  readonly failureReason: string | null;
  readonly result: DelegationJobResult;
  readonly state: 'cancelled' | 'failed' | 'finished';
}

/** A typed launch failure; its message never quotes the prompt or a path the operator did not declare. */
class DelegationLaunchFailure extends Error {
  readonly family: 'executor-unavailable' | 'scope-unavailable';

  constructor(family: DelegationLaunchFailure['family'], message: string) {
    super(message);
    this.name = 'DelegationLaunchFailure';
    this.family = family;
  }
}

/** Raised inside the config updater to leave the file untouched; the answer travels beside it. */
class DelegationConfigRejected extends Error {
  constructor() {
    super('delegation config write rejected');
    this.name = 'DelegationConfigRejected';
  }
}

/** The objective recorded for a review adapted from the Work view's legacy command; it names its origin. */
const ADAPTED_REVIEW_OBJECTIVE =
  'Read-only review of the checkout HEAD commit, adapted from a Work review attempt (start-review-attempt); the common delegation policy decides its admission.';

/** The legacy refusal reason a qualification-level refusal maps to. */
const legacyReasonForQualificationRefusal = (reason: DelegationRefusalReason): ReviewAdmissionRefusalReason => {
  switch (reason) {
    case 'checkout-unavailable':
    case 'checkout-not-admitted':
      return 'target-not-allowed';
    case 'scope-unavailable':
    case 'scope-unsupported':
      return 'scope-unavailable';
    case 'target-reserved':
      return 'target-reserved';
    default:
      return 'policy-refused';
  }
};

/** The legacy refusal reason a route's blockers map to; the policy families stay `policy-refused`. */
const legacyReasonForRouteBlockers = (route: DelegationRoute): ReviewAdmissionRefusalReason => {
  if (route.blockers.includes('pool-busy')) {
    return 'pool-busy';
  }
  if (route.blockers.includes('identity-changed')) {
    return 'identity-changed';
  }
  if (route.blockers.includes('availability')) {
    return 'executor-unavailable';
  }
  return 'policy-refused';
};

const SHUTDOWN_LOST_REASON =
  'engine stopped before this job had a tracked process; verify in the harness (the target stays reserved)';
const SHUTDOWN_STOP_REASON = 'stopped at engine shutdown: the engine terminated its worker and saw it exit';
const OUTPUT_CHECK_LABEL = 'engine output-contract check';
const OUTPUT_CHECK_LINE = 'parsed the final message against the review output contract (structure only)';
/** Reserving jobs read per decision; the store's own transaction is the authority beyond this bound. */
const RESERVATION_READ_LIMIT = DELEGATION_STORE_BOUNDS.maxListLimit;
const SHORT_TEXT = DELEGATION_QUALIFICATION_BOUNDS.maxText;

const unknownFact = <Value>(source: string): DelegationFact<Value> => ({ provenance: 'unknown', source, value: null });

/** The facts when the checkout itself could not be resolved: nothing was read, nothing is guessed. */
const UNRESOLVED_FACTS: DelegationCheckoutFacts = {
  gitAuthorEmail: unknownFact('not read: the checkout could not be resolved'),
  githubAccount: unknownFact('not read: the checkout could not be resolved'),
  githubOwners: unknownFact('not read: the checkout could not be resolved'),
  repositories: unknownFact('not read: the checkout could not be resolved'),
};

const bounded = (value: string, maximum: number): string => (value.length <= maximum ? value : value.slice(0, maximum));

const describeIssues = (
  subject: string,
  issues: readonly { readonly path: string; readonly reason: string }[],
): string =>
  bounded(
    `The ${subject} is invalid: ${issues
      .slice(0, 8)
      .map((issue) => (issue.path.length === 0 ? issue.reason : `${issue.path} ${issue.reason}`))
      .join('; ')}.`,
    1024,
  );

const shortText = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 ? bounded(value, SHORT_TEXT) : 'unknown';

/** The scope as the worker received it, in the delegation contract's terms (coverage and truncation). */
const executedScopeOf = (scope: ReviewAttemptScope): DelegationExecutedScope => ({
  fileCount: scope.fileCount,
  files: scope.files
    .filter((file) => file.path.length <= DELEGATION_JOB_BOUNDS.maxScopePathCharacters)
    .slice(0, DELEGATION_JOB_BOUNDS.maxScopeFiles)
    .map((file) => ({ coverage: file.coverage, path: file.path })),
  includedBytes: scope.includedBytes,
  patchBytes: scope.patchBytes,
  patchSha256: scope.patchSha256,
  truncated: scope.truncated || scope.includedBytes < scope.patchBytes,
  workingTreeDirty: scope.workingTreeDirty,
});

const launchFailure = (error: unknown): DelegationLaunchFailure => {
  if (error instanceof DelegationLaunchFailure) {
    return error;
  }
  if (error instanceof ReviewScopeError) {
    return new DelegationLaunchFailure('scope-unavailable', `${error.kind}: ${error.message}`);
  }
  if (error instanceof ReviewWorkerLaunchError) {
    return new DelegationLaunchFailure('executor-unavailable', `${error.harness} ${error.kind}: ${error.message}`);
  }
  // An unexpected error is named by its class only: its message may quote the prompt.
  return new DelegationLaunchFailure('executor-unavailable', error instanceof Error ? error.name : 'unknown error');
};

/** How a worker's end is recorded: the state, the result (parsed against the contract) and the engine's check. */
const conclude = (outcome: ReviewWorkerOutcome, stoppedAtShutdown: boolean): Conclusion => {
  if (outcome.kind === 'finished') {
    const parsed = parseDelegationWorkerOutput(outcome.finalText);
    if (parsed.kind === 'structured') {
      return {
        check: {
          note: 'The final message satisfied the structured review contract. A structural check only: the findings themselves were not verified.',
          verdict: 'confirmed',
        },
        failureReason: null,
        result: { excerpt: null, kind: 'review', review: parsed.review },
        state: 'finished',
      };
    }
    return {
      check: {
        note: `The final message did not satisfy the structured review contract: ${parsed.reason}. A structural check only; the excerpt is kept on the job.`,
        verdict: 'refuted',
      },
      failureReason: `unstructured output: ${parsed.reason}`,
      result: { excerpt: parsed.excerpt, kind: 'unstructured', review: null },
      state: 'finished',
    };
  }
  const excerpt = boundDelegationExcerpt(outcome.finalText);
  // Nothing finished, so the contract was neither met nor failed: the check is inconclusive, as a
  // structural fact about the run, not a verdict on any review.
  if (outcome.resultKind === 'cancelled') {
    return {
      check: {
        note: 'The run was cancelled before a final message; the output contract could not be checked. A structural check only.',
        verdict: 'inconclusive',
      },
      failureReason: outcome.failureReason,
      result: { excerpt, kind: 'cancelled', review: null },
      state: 'cancelled',
    };
  }
  const failureReason = stoppedAtShutdown
    ? `${SHUTDOWN_STOP_REASON} (${outcome.failureReason ?? 'no reason'})`
    : outcome.failureReason;
  return {
    check: {
      note: `The run failed (${failureReason ?? 'no reason given'}); the output contract could not be checked. A structural check only.`,
      verdict: 'inconclusive',
    },
    failureReason,
    result: { excerpt, kind: outcome.resultKind === 'timeout' ? 'timeout' : 'error', review: null },
    state: 'failed',
  };
};

export const createDelegationService = (options: DelegationServiceOptions): DelegationService => {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const adapters = new Map(
    (options.adapters ?? [claudeReviewWorkerAdapter, codexReviewWorkerAdapter]).map(
      (adapter) => [adapter.harness, adapter] as const,
    ),
  );
  const adapterOptions = options.adapterOptions ?? {};
  const gitOptions = adapterOptions.env === undefined ? {} : { env: adapterOptions.env };
  const findProcesses = options.findProcesses ?? createProcessTableScanner();
  // Both probes read with the adapter's own environment and executable override: the sign-in they
  // see is the one the worker would launch with.
  const probeOptions = {
    ...(adapterOptions.env === undefined ? {} : { env: adapterOptions.env }),
    ...(adapterOptions.executable === undefined ? {} : { executable: adapterOptions.executable }),
  };
  const probeAccount = options.probeClaudeAccount ?? (async () => await probeClaudeAccount(probeOptions));
  const probeCodex = options.probeCodexAuth ?? (async () => await probeCodexAuth(probeOptions));
  const runWithWriter = options.runWithWriter ?? (async <Value>(operation: () => Promise<Value>) => await operation());
  const report = options.report ?? (() => undefined);
  const runLimits = { ...REVIEW_ATTEMPT_RUN_LIMITS, ...options.runLimits };
  const runs = new Map<string, TrackedRun>();
  const starts = new Set<Promise<unknown>>();
  let stopping = false;

  const gated = <Value>(operation: () => Promise<Value>, signal?: AbortSignal): Promise<Value> =>
    runWithWriter(operation, signal);
  const runWithStorage = <Value, Error>(effect: Effect.Effect<Value, Error, LocalHistoryStorage>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, options.storage)));

  const privateDirectoryFor = (jobId: string): string => path.join(options.privateRoot, jobId);
  const removePrivateDirectory = async (jobId: string): Promise<void> => {
    await rm(privateDirectoryFor(jobId), { force: true, recursive: true }).catch(() => undefined);
  };

  /** Applies a patch from the live states, or from `fromStates` only when given; `false` when the row was elsewhere. */
  const transition = async (
    jobId: string,
    patch: DelegationJobPatch,
    at: string = now().toISOString(),
    fromStates?: readonly DelegationJobState[],
  ): Promise<boolean> =>
    (
      await gated(() =>
        Effect.runPromise(
          transitionDelegationJob({
            at,
            dbPath: options.dbPath,
            jobId,
            patch,
            ...(fromStates === undefined ? {} : { fromStates }),
          }),
        ),
      )
    ).applied;

  const readJob = async (jobId: string): Promise<DelegationJob | null> =>
    (await Effect.runPromise(queryDelegationJobs({ dbPath: options.dbPath, jobId, limit: 1 }))).jobs[0] ?? null;

  const readPolicy = () => readLocalRoutingDeclarations(options.storage.home);

  // -------------------------------------------------------------------------------------------
  // Qualification
  // -------------------------------------------------------------------------------------------

  /**
   * One qualification from fresh facts: the home policy, the checkout resolved on disk, its facts
   * and frozen scope, the retained executor observations, the latest quota and the reservations the
   * store holds. The same function serves `qualify` and the re-qualification at `start`.
   */
  const assess = async (input: {
    readonly machineId: string;
    readonly now: string;
    readonly purpose: DelegationQualificationPurpose;
    readonly qualificationId: string;
    readonly request: DelegationRequest;
    readonly requestDigest: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<Assessment> => {
    const { machineId, request, signal } = input;
    const [policy, history, accountChanges, quotas, reserving, chain] = await Promise.all([
      readPolicy(),
      Effect.runPromise(queryExecutorObservationHistory({ dbPath: options.dbPath, machineId })),
      // The persisted barrier: an account change the retained history may no longer show.
      Effect.runPromise(queryExecutorAccountChanges({ dbPath: options.dbPath, machineId })),
      Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath: options.dbPath, machineId })),
      // Both review families: delegation jobs and the Work view's legacy attempts hold the same
      // targets and pools (`review-reservations.ts`); the store's transaction is the authority.
      Effect.runPromise(queryReviewReservations({ dbPath: options.dbPath, machineId })),
      // The chain is counted by the store with the rule its insert transaction applies.
      request.retryOf === undefined
        ? Promise.resolve(null)
        : Effect.runPromise(countDelegationRetryChain({ dbPath: options.dbPath, retryOf: request.retryOf })),
    ]);
    signal?.throwIfAborted();
    const checkout: DelegationCheckoutInput = await resolveDelegationCheckout(
      request.checkout.path,
      policy.reviewTargets,
      gitOptions,
    );
    let facts: DelegationCheckoutFacts = UNRESOLVED_FACTS;
    let scope: DelegationScopeInput = {
      failure: 'scope-unavailable',
      message: 'the scope was not frozen because the checkout could not be resolved',
    };
    if (!('failure' in checkout)) {
      [facts, scope] = await Promise.all([
        readDelegationCheckoutFacts(checkout.path, policy.githubAccounts, gitOptions),
        freezeDelegationScope(checkout.path, request.scope, gitOptions),
      ]);
    }
    signal?.throwIfAborted();
    const frozen = 'failure' in scope ? null : scope;
    // The pools the policy knows on this machine; a holder whose pool cannot be read counts
    // against every pool of its harness among them.
    const pools = policy.declarations
      .filter((declaration) => declaration.machineId === machineId)
      .map((declaration) => ({
        harness: declaration.harness,
        poolId: `declared:${executorDeclarationKey(declaration)}`,
      }));
    const liveJobsByPool = countReviewReservationsByPool(reserving.holders, pools);
    const reservedBy =
      frozen === null || 'failure' in checkout
        ? null
        : reviewTargetReservationHolder(reserving.holders, {
            action: request.action,
            baseSha: frozen.baseSha,
            checkoutPath: checkout.path,
            headSha: frozen.headSha,
          });
    const reservations: DelegationReservations = {
      attemptsInChain: chain?.attempts ?? 0,
      liveJobsByPool,
      targetReservedBy: reservedBy?.id ?? null,
      ...(reservedBy === null
        ? {}
        : { targetReservation: { family: reservedBy.family, message: describeReviewReservation(reservedBy) } }),
    };
    const qualification = qualifyDelegation({
      accountChanges: accountChanges.changes,
      checkout,
      checkoutFacts: facts,
      config: policy.delegation.config,
      declarations: policy.declarations,
      executorObservations: history.observations,
      harnessControls: DELEGATION_HARNESS_CONTROLS,
      machineId,
      now: input.now,
      providers: quotas.observations.map(projectLatestProviderQuotaObservation),
      purpose: input.purpose,
      qualificationId: input.qualificationId,
      request,
      requestDigest: input.requestDigest,
      reservations,
      scope,
      versions: policy.revisions,
    });
    return {
      checkout: 'failure' in checkout ? null : checkout,
      declarations: policy.declarations,
      qualification,
      reservationHolders: reserving.holders,
      scope: frozen,
    };
  };

  /**
   * The `pool-busy` sentence the store's transaction would give for this route, from the holders the
   * assessment counted: it names each reserving job or attempt of either family and says when one
   * counts against the pool only because its own pool could not be read. `null` when the holders no
   * longer fill the pool (the qualification's own exclusion then stands).
   */
  const poolBusyDetail = (assessed: Assessment, route: DelegationRoute): string | null => {
    if (assessed.scope === null || assessed.checkout === null) {
      return null;
    }
    const check = checkReviewReservations({
      holders: assessed.reservationHolders,
      maxConcurrent: route.requirements.maxConcurrent,
      pool: { harness: route.harness, poolId: route.poolId },
      target: {
        action: assessed.qualification.request.action,
        baseSha: assessed.scope.baseSha,
        checkoutPath: assessed.checkout.path,
        headSha: assessed.scope.headSha,
      },
    });
    return check.kind === 'pool-busy' ? check.message : null;
  };

  /** A refused qualification for a request the parser did not accept; nothing was read for it and nothing is stored. */
  const refusedForRequest = async (
    raw: unknown,
    purpose: DelegationQualificationPurpose,
    reason: DelegationRefusalReason,
    message: string,
  ): Promise<DelegationQualification> => {
    const [policy, digest] = await Promise.all([readPolicy(), sha256Hex(canonicalJson(raw))]);
    const at = now().toISOString();
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      admissibleRouteIds: [],
      appliedRules: [],
      assumptions: [],
      checkout: null,
      checkoutFacts: null,
      omittedRoutes: 0,
      outcome: 'refused',
      purpose,
      qualificationId: newId(),
      qualifiedAt: at,
      refusal: { message: bounded(message, SHORT_TEXT), reason },
      request: { action: shortText(record.action), digest, taskCategory: shortText(record.taskCategory) },
      routes: [],
      schemaVersion: DELEGATION_SCHEMA_VERSION,
      scope: null,
      validUntil: at,
      versions: {
        catalogRevision: policy.revisions.catalogRevision,
        policyRevision: policy.revisions.policyRevision,
        qualifier: DELEGATION_QUALIFIER_VERSION,
        selectorContract: DELEGATION_SELECTION_CONTRACT,
      },
    };
  };

  const qualify: DelegationService['qualify'] = async (command, executorRun, signal) => {
    signal?.throwIfAborted();
    const parsed = parseDelegationRequest(command.request);
    if (parsed.kind === 'invalid') {
      return {
        kind: 'delegation-qualification',
        qualification: await refusedForRequest(
          command.request,
          command.purpose,
          'invalid-request',
          describeIssues('request', parsed.issues),
        ),
      };
    }
    if (parsed.kind === 'unsupported') {
      return {
        kind: 'delegation-qualification',
        qualification: await refusedForRequest(command.request, command.purpose, parsed.reason, parsed.message),
      };
    }
    const machineId = options.machine().id;
    const requestDigest = await delegationRequestDigest(parsed.request);
    const assessed = await assess({
      machineId,
      now: now().toISOString(),
      purpose: command.purpose,
      qualificationId: newId(),
      request: parsed.request,
      requestDigest,
      signal,
    });
    const recorded = await gated(
      () =>
        Effect.runPromise(
          recordDelegationQualification({
            dbPath: options.dbPath,
            machineId,
            purpose: command.purpose,
            qualification: assessed.qualification,
            requestDigest,
          }),
        ),
      signal,
    );
    report(
      `usage-engine delegation=qualified id=${assessed.qualification.qualificationId} purpose=${command.purpose} outcome=${assessed.qualification.outcome} routes=${assessed.qualification.admissibleRouteIds.length}/${assessed.qualification.routes.length} executors=${executorRun.source?.lastOutcome ?? 'not-run'} inserted=${recorded.inserted} pruned=${recorded.pruned}`,
    );
    return { kind: 'delegation-qualification', qualification: assessed.qualification };
  };

  // -------------------------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------------------------

  const recordOutputCheck = async (
    jobId: string,
    check: NonNullable<Conclusion['check']>,
    at: string,
  ): Promise<void> => {
    const recorded = await gated(() =>
      Effect.runPromise(
        recordDelegationEvaluation({
          dbPath: options.dbPath,
          evaluation: {
            author: 'automated-check',
            authorLabel: OUTPUT_CHECK_LABEL,
            checks: [OUTPUT_CHECK_LINE],
            jobId,
            kind: 'verification',
            note: check.note,
            recordedAt: at,
            verdict: check.verdict,
          },
        }),
      ),
    );
    report(`usage-engine delegation=output-check job=${jobId} verdict=${check.verdict} recorded=${recorded.kind}`);
  };

  const track = (job: DelegationJob, launch: ReviewWorkerLaunch): void => {
    const settled = (async () => {
      try {
        const outcome = await launch.outcome;
        const endedAt = now().toISOString();
        // A process that finished before the stop took effect keeps its result; one the stop ended
        // says so, with whatever it produced until then. A cancel stays a cancel.
        const stoppedAtShutdown = stopping && outcome.kind === 'failed' && outcome.resultKind !== 'cancelled';
        const conclusion = conclude(outcome, stoppedAtShutdown);
        const fields: Omit<DelegationJobPatch, 'state'> = {
          endedAt,
          exitCode: outcome.exitCode,
          failureReason: conclusion.failureReason,
          ...(outcome.resolvedModel === null ? {} : { modelResolved: outcome.resolvedModel }),
          ...(outcome.nativeSessionId === null ? {} : { nativeSessionId: outcome.nativeSessionId }),
          result: conclusion.result,
          usage: outcome.usage,
        };
        const applied = await transition(job.jobId, { ...fields, state: conclusion.state }, endedAt);
        let late = false;
        if (applied) {
          if (conclusion.check !== null) {
            await recordOutputCheck(job.jobId, conclusion.check, endedAt);
          }
        } else {
          // The row left the live states without this engine: contact was recorded lost while the
          // process ran. Its end is now known, so the outcome is recorded and the reservation released.
          late = (
            await gated(() =>
              Effect.runPromise(
                releaseDelegationJobReservation({
                  at: endedAt,
                  dbPath: options.dbPath,
                  evidence: 'outcome-recorded-late',
                  jobId: job.jobId,
                  outcome: fields,
                }),
              ),
            )
          ).applied;
        }
        report(
          `usage-engine delegation=${stoppedAtShutdown ? 'stopped' : conclusion.state} job=${job.jobId} result=${conclusion.result.kind} exit=${outcome.exitCode ?? 'null'} turns=${outcome.numTurns ?? 'null'} applied=${applied} late=${late}`,
        );
      } catch (error) {
        report(
          `usage-engine delegation=write-failed job=${job.jobId} reason=${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        runs.delete(job.jobId);
        await removePrivateDirectory(job.jobId);
      }
    })();
    runs.set(job.jobId, { launch, settled });
  };

  const launchFor = async (
    job: DelegationJob,
    route: DelegationRoute,
    request: DelegationRequest,
    checkout: ResolvedDelegationCheckout,
    scope: FrozenDelegationScope,
  ): Promise<{ readonly executedScope: DelegationExecutedScope; readonly launch: ReviewWorkerLaunch }> => {
    if (job.launchMarker === null) {
      throw new DelegationLaunchFailure('executor-unavailable', 'the job has no launch marker');
    }
    const adapter = adapters.get(route.harness);
    if (adapter === undefined) {
      throw new DelegationLaunchFailure(
        'executor-unavailable',
        `no executor adapter is available for ${route.harness} in this engine`,
      );
    }
    const prepared = await prepareReviewScope(checkout.path, {
      ...gitOptions,
      revision: { baseSha: scope.baseSha, headSha: scope.headSha, kind: scope.kind },
    });
    const executedScope = executedScopeOf(prepared.scope);
    const prompt = buildDelegationPrompt({
      executed: executedScope,
      patch: prepared.patch,
      request,
      scope,
      subject: prepared.scope.subject,
    });
    ensurePrivateDirectory(options.privateRoot);
    const privateDirectory = privateDirectoryFor(job.jobId);
    ensurePrivateDirectory(privateDirectory);
    const spec: ReviewWorkerSpec = {
      checkoutPath: checkout.path,
      effort: route.effort,
      heartbeatMs: runLimits.heartbeatMs,
      launchMarker: job.launchMarker,
      maxOutputBytes: runLimits.maxOutputBytes,
      maxTurns: runLimits.maxTurns,
      model: route.model,
      outputSchema: route.harness === 'codex' ? DELEGATION_OUTPUT_JSON_SCHEMA : null,
      privateDirectory,
      prompt,
      timeoutMs: runLimits.timeoutMs,
    };
    const events: ReviewWorkerEvents = {
      onHeartbeat: async () => {
        if (!stopping) {
          await transition(job.jobId, {});
        }
      },
      onInit: async (nativeSessionId, resolvedModel) => {
        if (!stopping) {
          await transition(job.jobId, {
            nativeSessionId,
            ...(resolvedModel === null ? {} : { modelResolved: resolvedModel }),
            state: 'running',
          });
        }
      },
    };
    return { executedScope, launch: await adapter.launch(spec, events, adapterOptions) };
  };

  // -------------------------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------------------------

  const refusalAnswer = (
    reason: DelegationRefusalReason,
    message: string,
    job: UsageEngineDelegationStartOutput['job'] = null,
  ): UsageEngineDelegationStartOutput => ({
    job,
    kind: 'delegation-start',
    refusal: { message: boundUsageEngineReviewMessage(message), reason },
  });

  const jobAnswer = (job: DelegationJob, reused: boolean): UsageEngineDelegationStartOutput => ({
    job: { jobId: job.jobId, reused, state: job.state },
    kind: 'delegation-start',
    refusal:
      job.state === 'refused' && job.refusalReason !== null
        ? { message: boundUsageEngineReviewMessage(job.failureReason ?? job.refusalReason), reason: job.refusalReason }
        : null,
  });

  const startJob = async (command: StartCommand, signal?: AbortSignal): Promise<UsageEngineDelegationStartOutput> => {
    const machineId = options.machine().id;
    const requestedAt = now().toISOString();
    const parsedRequest = parseDelegationRequest(command.request);
    if (parsedRequest.kind === 'invalid') {
      return refusalAnswer('invalid-request', describeIssues('request', parsedRequest.issues));
    }
    if (parsedRequest.kind === 'unsupported') {
      return refusalAnswer(parsedRequest.reason, parsedRequest.message);
    }
    const parsedSelection = parseDelegationSelection(command.selection);
    if (parsedSelection.kind === 'invalid') {
      return refusalAnswer('invalid-request', describeIssues('selection', parsedSelection.issues));
    }
    const { request } = parsedRequest;
    const { selection } = parsedSelection;
    const [requestDigest, selectionDigest] = await Promise.all([
      delegationRequestDigest(request),
      delegationSelectionDigest(selection),
    ]);
    // The same key answers the same: the existing row is read (through the unique key index) before
    // any fact is, so a retry after a timeout costs no re-qualification and launches nothing twice.
    const existing = (
      await Effect.runPromise(
        queryDelegationJobs({ dbPath: options.dbPath, idempotencyKey: command.idempotencyKey, limit: 1, machineId }),
      )
    ).jobs[0];
    if (existing !== undefined) {
      const sameSelection =
        existing.selection !== null && (await delegationSelectionDigest(existing.selection)) === selectionDigest;
      if (existing.requestDigest === requestDigest && sameSelection) {
        return jobAnswer(existing, true);
      }
      return refusalAnswer(
        'idempotency-conflict',
        `Idempotency key ${command.idempotencyKey} already names job ${existing.jobId} for another request or selection; use a new key for new work.`,
      );
    }
    if (request.retryOf !== undefined && (await readJob(request.retryOf)) === null) {
      return refusalAnswer(
        'invalid-request',
        `retryOf names job ${request.retryOf}, which this machine does not hold.`,
      );
    }
    signal?.throwIfAborted();
    const assessed = await assess({
      machineId,
      now: requestedAt,
      purpose: 'delegation',
      qualificationId: newId(),
      request,
      requestDigest,
      signal,
    });
    const citedRead = await Effect.runPromise(
      readDelegationQualification({ dbPath: options.dbPath, machineId, qualificationId: selection.qualificationId }),
    );
    const cited = citedRead.record === null ? null : parseDelegationQualification(citedRead.record.qualification);
    const decision = decideDelegationLaunch({
      cited,
      fresh: assessed.qualification,
      now: requestedAt,
      requestDigest,
      selection,
    });
    signal?.throwIfAborted();

    const base = {
      accountScope: null,
      action: request.action,
      checkoutPath: assessed.checkout?.path ?? null,
      context: null,
      effort: null,
      executorHarness: null,
      idempotencyKey: command.idempotencyKey,
      machineId,
      modelRequested: null,
      poolId: null,
      qualification: assessed.qualification,
      qualificationId: selection.qualificationId,
      request,
      requestDigest,
      requestedAt,
      retryOf: request.retryOf ?? null,
      routeId: null,
      scope: assessed.scope,
      selection,
      selectionDigest,
      taskCategory: request.taskCategory,
    } satisfies Omit<NewDelegationJob, 'state'>;

    /** Records a decision that launches nothing; the store's key check still applies. */
    const recordDecision = async (
      row: NewDelegationJob,
      refusal: { readonly message: string; readonly reason: DelegationRefusalReason } | null,
    ): Promise<UsageEngineDelegationStartOutput> => {
      const result = await gated(
        () =>
          Effect.runPromise(
            requestDelegationJob({ dbPath: options.dbPath, job: row, limits: { maxAttempts: 1, maxConcurrent: 1 } }),
          ),
        signal,
      );
      switch (result.kind) {
        case 'inserted':
          report(
            `usage-engine delegation=${row.state} job=${result.job.jobId}${refusal === null ? '' : ` reason=${refusal.reason}`}`,
          );
          // The row keeps the whole reason under the store's bound; the answer is cut to the control plane's.
          return {
            job: { jobId: result.job.jobId, reused: false, state: result.job.state },
            kind: 'delegation-start',
            refusal:
              refusal === null
                ? null
                : { message: boundUsageEngineReviewMessage(refusal.message), reason: refusal.reason },
          };
        case 'reused':
          return jobAnswer(result.job, true);
        case 'idempotency-conflict':
          return refusalAnswer(
            'idempotency-conflict',
            `Idempotency key ${command.idempotencyKey} already names job ${result.existing.jobId} for another request or selection.`,
          );
        default:
          // A decision row reserves nothing, so the store never answers with a reservation refusal.
          throw new Error(`unexpected store answer ${result.kind} for a ${row.state} delegation row`);
      }
    };
    const refuse = (reason: DelegationRefusalReason, message: string) =>
      recordDecision({ ...base, failureReason: message, refusalReason: reason, state: 'refused' }, { message, reason });

    if (decision.kind === 'abstained') {
      return await recordDecision({ ...base, state: 'abstained' }, null);
    }
    if (decision.kind === 'refused') {
      // A busy pool is named by its holders of both families, as the insert transaction would name them.
      const freshRoute =
        decision.reason === 'pool-busy' && selection.kind === 'choice'
          ? assessed.qualification.routes.find((entry) => entry.routeId === selection.routeId)
          : undefined;
      const detail = freshRoute === undefined ? null : poolBusyDetail(assessed, freshRoute);
      return await refuse(decision.reason, detail ?? decision.message);
    }
    const { route } = decision;
    if (assessed.checkout === null || assessed.scope === null) {
      throw new Error('an allowed delegation decision without a resolved checkout and frozen scope');
    }
    // The stored observation can be up to two cadences old; a pinned Claude route is confirmed again
    // now, with the launch's own CLI and configuration directory (ADR 0057).
    const declared = declarationForReviewCandidate(assessed.declarations, route.routeId);
    const pin = route.harness === 'claude-code' ? declared?.declaration.accountFingerprint : undefined;
    if (pin !== undefined) {
      const current = await probeAccount();
      signal?.throwIfAborted();
      if (current.accountFingerprint !== pin) {
        return await refuse(
          'identity-changed',
          current.accountFingerprint === null
            ? `The signed-in Claude Code account could not be confirmed against the pin ${pin} at start (${current.evidence}); qualify again.`
            : `Claude Code is now signed in to another account (fingerprint ${current.accountFingerprint}) than the pin ${pin}: sign back in to that account, or re-declare accountFingerprint and declaredAt.`,
        );
      }
    }
    // Codex names no account, so the launch profile's sign-in itself is re-read now: the retained
    // observation admitted the route, the profile that would bill this run must still be a signed-in
    // subscription. Anything short of a confirmed sign-in refuses rather than guesses.
    if (route.harness === 'codex') {
      const codexAuth = await probeCodex();
      signal?.throwIfAborted();
      if (codexAuth.authState !== 'logged-in') {
        return await refuse(
          'executor-unavailable',
          codexAuth.authState === 'logged-out'
            ? `Codex is not signed in for the launch profile (${codexAuth.evidence}); sign in with codex login under that profile, then qualify again.`
            : `The Codex sign-in for the launch profile could not be confirmed at start (${codexAuth.evidence}); qualify again.`,
        );
      }
      if (executorAuthMethodIndicatesApiKey(codexAuth.authMethod)) {
        return await refuse(
          'route-not-admissible',
          `The Codex launch profile is signed in with an API key (${codexAuth.authMethod}), which bills the API; delegation routes are subscription-only. Sign that profile in with a ChatGPT subscription, then qualify again.`,
        );
      }
    }
    const requested = await gated(
      () =>
        Effect.runPromise(
          requestDelegationJob({
            dbPath: options.dbPath,
            job: {
              ...base,
              accountScope: route.accountScope,
              context: route.context,
              effort: route.effort,
              executorHarness: route.harness,
              launchMarker: newId(),
              modelRequested: route.model,
              poolId: route.poolId,
              routeId: route.routeId,
              state: 'requested',
            },
            limits: { maxAttempts: route.requirements.maxAttempts, maxConcurrent: route.requirements.maxConcurrent },
          }),
        ),
      signal,
    );
    switch (requested.kind) {
      case 'reused':
        return jobAnswer(requested.job, true);
      case 'idempotency-conflict':
        return refusalAnswer(
          'idempotency-conflict',
          `Idempotency key ${command.idempotencyKey} already names job ${requested.existing.jobId} for another request or selection.`,
        );
      case 'target-reserved':
      case 'pool-busy':
        // The store's sentence names the holder of either family and any uncertainty in its scope or pool.
        return await refuse(requested.kind, requested.message);
      case 'attempts-exhausted':
        return await refuse(
          'attempts-exhausted',
          `The retry chain of ${request.retryOf ?? 'this request'} already counts ${requested.count} attempt(s); the limit is ${route.requirements.maxAttempts}.`,
        );
      default:
        break;
    }
    const job = requested.job;
    let launched: Awaited<ReturnType<typeof launchFor>>;
    try {
      if (stopping) {
        throw new DelegationLaunchFailure(
          'executor-unavailable',
          'the engine is stopping; the worker was not launched',
        );
      }
      launched = await launchFor(job, route, request, assessed.checkout, assessed.scope);
    } catch (error) {
      const failure = launchFailure(error);
      const endedAt = now().toISOString();
      const message = bounded(
        `${failure.family}: ${failure.message}`,
        DELEGATION_JOB_BOUNDS.maxFailureReasonCharacters,
      );
      await transition(
        job.jobId,
        { endedAt, failureReason: message, result: { excerpt: null, kind: 'error', review: null }, state: 'failed' },
        endedAt,
      );
      await removePrivateDirectory(job.jobId);
      report(`usage-engine delegation=failed job=${job.jobId} reason=${failure.family}`);
      return { job: { jobId: job.jobId, reused: false, state: 'failed' }, kind: 'delegation-start', refusal: null };
    }
    const { executedScope, launch } = launched;
    const startedAt = now().toISOString();
    // `starting` is a step out of `requested` only. The harness may already have reported its init
    // (`running`) before this write lands; then the process identity, the executed scope and the
    // guarantee are recorded from whatever live state the row is in, and the state is never stepped back.
    const identity: DelegationJobPatch = {
      executedScope,
      guarantee: launch.guarantee,
      harnessVersion: launch.guarantee.cliVersion,
      pid: launch.pid,
      startedAt,
    };
    let starting = false;
    try {
      starting = await transition(job.jobId, { ...identity, state: 'starting' }, startedAt, ['requested']);
      if (!starting) {
        await transition(job.jobId, identity, startedAt);
      }
    } finally {
      // Tracked whatever the writes did: a process this engine started is always one it can stop.
      track(job, launch);
    }
    const state = starting ? 'starting' : ((await readJob(job.jobId))?.state ?? 'starting');
    report(`usage-engine delegation=${state} job=${job.jobId} harness=${route.harness} pid=${launch.pid}`);
    return { job: { jobId: job.jobId, reused: false, state }, kind: 'delegation-start', refusal: null };
  };

  const start: DelegationService['start'] = async (command, signal) => {
    if (stopping) {
      return refusalAnswer('engine-stopping', 'The engine is stopping; no delegation can start.');
    }
    const pending = startJob(command, signal);
    starts.add(pending);
    try {
      return await pending;
    } finally {
      starts.delete(pending);
    }
  };

  // -------------------------------------------------------------------------------------------
  // Admission of a review that enters through another command (the Work view's legacy launch)
  // -------------------------------------------------------------------------------------------

  const admitReview: ReviewAdmissionPort = async (input) => {
    input.signal?.throwIfAborted();
    // The legacy launch reviews the checkout's HEAD against its first parent: that is the request
    // it would have been, in the delegation contract's own terms, parsed by the same parser.
    const parsed = parseDelegationRequest({
      action: 'read-only-review',
      checkout: { path: input.checkoutPath },
      constraints: [],
      criteria: [],
      objective: ADAPTED_REVIEW_OBJECTIVE,
      schemaVersion: 1,
      scope: { commit: 'HEAD', kind: 'commit' },
      taskCategory: 'general-review',
    } satisfies DelegationRequest);
    if (parsed.kind !== 'ok') {
      throw new Error(
        `the review adapted from the Work command does not satisfy the delegation request contract (${parsed.kind})`,
      );
    }
    const { request } = parsed;
    const requestDigest = await delegationRequestDigest(request);
    const assessed = await assess({
      machineId: options.machine().id,
      now: now().toISOString(),
      purpose: 'delegation',
      qualificationId: newId(),
      request,
      requestDigest,
      signal: input.signal,
    });
    const { qualification } = assessed;
    if (qualification.refusal !== null) {
      return {
        kind: 'refused',
        message: qualification.refusal.message,
        reason: legacyReasonForQualificationRefusal(qualification.refusal.reason),
      };
    }
    const route = qualification.routes.find((candidate) => candidate.routeId === input.routeId);
    if (route === undefined) {
      return {
        kind: 'refused',
        message: `Route ${input.routeId} is not a delegation route on this machine: only a declared Claude Code or Codex executor of routing.executors[] is one, and the delegation policy admits no other launch.`,
        reason: 'policy-refused',
      };
    }
    if (!route.admissible) {
      const reason = legacyReasonForRouteBlockers(route);
      const detail =
        (reason === 'pool-busy' ? poolBusyDetail(assessed, route) : null) ??
        (route.exclusions.length === 0 ? 'the route is not eligible' : route.exclusions.join(' '));
      return {
        kind: 'refused',
        message: boundUsageEngineReviewMessage(
          `The delegation policy does not admit route ${route.routeId} for ${assessed.checkout?.path ?? input.checkoutPath}: ${detail}`,
        ),
        reason,
      };
    }
    if (assessed.checkout === null || assessed.scope === null) {
      throw new Error('an admissible delegation route without a resolved checkout and frozen scope');
    }
    report(
      `usage-engine delegation=admitted-review route=${route.routeId} pool=${route.poolId} head=${assessed.scope.headSha}`,
    );
    return { checkout: assessed.checkout, kind: 'admitted', route, scope: assessed.scope };
  };

  // -------------------------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------------------------

  const cancel: DelegationService['cancel'] = async (command, signal) => {
    const answer = (
      result: UsageEngineDelegationCancelOutput['result'],
      state: DelegationJobState | null,
    ): UsageEngineDelegationCancelOutput => ({ jobId: command.jobId, kind: 'delegation-cancel', result, state });
    const tracked = runs.get(command.jobId);
    if (tracked !== undefined) {
      const marked = await gated(
        () =>
          Effect.runPromise(
            requestDelegationCancel({ at: now().toISOString(), dbPath: options.dbPath, jobId: command.jobId }),
          ),
        signal,
      );
      tracked.launch.terminate('cancel');
      report(`usage-engine delegation=cancelling job=${command.jobId} applied=${marked.applied}`);
      return answer('cancelling', marked.state ?? 'running');
    }
    const job = await readJob(command.jobId);
    if (job === null) {
      return answer('not-found', null);
    }
    if (job.state === 'lost') {
      if (job.releasedAt !== null) {
        return answer('already-ended', job.state);
      }
      // The engine looks for the process it once started; a listing that shows it absent releases
      // the reservation. A process found, or a listing that cannot prove an absence, keeps it held:
      // nothing this engine does not track is ever signalled.
      const scan = job.launchMarker === null ? null : await findProcesses(job.launchMarker);
      if (scan?.kind === 'absent') {
        await gated(
          () =>
            Effect.runPromise(
              releaseDelegationJobReservation({
                at: now().toISOString(),
                dbPath: options.dbPath,
                evidence: 'process-absent',
                jobId: job.jobId,
              }),
            ),
          signal,
        );
        report(`usage-engine delegation=released job=${job.jobId} evidence=process-absent`);
        return answer('already-ended', job.state);
      }
      return answer('not-cancellable-lost', job.state);
    }
    if (isLiveDelegationState(job.state)) {
      // Live on the row but not tracked here: no pipe to terminate through; the row is the restart's to settle.
      return answer('not-cancellable-lost', job.state);
    }
    return answer('already-ended', job.state);
  };

  // -------------------------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------------------------

  const recordEvaluation: DelegationService['recordEvaluation'] = async (command, signal) => {
    const refusal = (
      reason: NonNullable<UsageEngineDelegationEvaluationOutput['refusal']>['reason'],
      message: string,
    ): UsageEngineDelegationEvaluationOutput => ({
      evaluationId: null,
      kind: 'delegation-evaluation',
      refusal: { message: boundUsageEngineReviewMessage(message), reason },
    });
    const parsed = parseDelegationEvaluationInput(command.evaluation, {
      author: command.author,
      authorLabel: command.authorLabel,
    });
    if (parsed.kind === 'invalid') {
      return refusal('invalid', `The evaluation is invalid: ${parsed.issues.join('; ')}.`);
    }
    if (parsed.evaluation.kind === 'acceptance' && command.author !== 'operator') {
      return refusal('invalid', 'An acceptance is recorded by the operator only; a model records a verification.');
    }
    const recorded = await gated(
      () =>
        Effect.runPromise(
          recordDelegationEvaluation({
            dbPath: options.dbPath,
            evaluation: { ...parsed.evaluation, jobId: command.jobId, recordedAt: now().toISOString() },
          }),
        ),
      signal,
    );
    switch (recorded.kind) {
      case 'recorded':
        report(
          `usage-engine delegation=evaluated job=${command.jobId} kind=${parsed.evaluation.kind} verdict=${parsed.evaluation.verdict} author=${command.author}`,
        );
        return { evaluationId: recorded.evaluationId, kind: 'delegation-evaluation', refusal: null };
      case 'job-not-found':
        return refusal('not-found', `No delegation job ${command.jobId} is known on this machine.`);
      case 'job-not-ended':
        return refusal('not-ended', `Job ${command.jobId} is ${recorded.state}; an acceptance needs an ended job.`);
      case 'job-not-finished':
        return refusal('not-ended', `Job ${command.jobId} is ${recorded.state}; a verification needs a finished job.`);
      default:
        return refusal(
          'invalid',
          `Job ${command.jobId} already holds ${recorded.limit} ${recorded.evaluationKind}(s) by ${recorded.author === 'operator' ? 'the operator' : 'the calling model'}, the most the store keeps per job; this ${parsed.evaluation.kind} was not recorded.`,
        );
    }
  };

  // -------------------------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------------------------

  const updateConfig: DelegationService['updateConfig'] = async (command, signal) => {
    const machineId = options.machine().id;
    // The updater runs inside the locked config update; its decision is carried out through this holder.
    const decided: { answer: UsageEngineDelegationConfigOutput | null } = { answer: null };
    const rejected = new DelegationConfigRejected();
    try {
      await gated(async () => {
        signal?.throwIfAborted();
        await runWithStorage(
          updateAiUsageConfig(async (config) => {
            const current = await delegationPolicyRevision({
              delegation: config.delegation,
              github: config.github,
              routing: config.routing,
            });
            if (current !== command.expectedRevision) {
              decided.answer = {
                issues: [],
                kind: 'delegation-config',
                result: 'revision-conflict',
                revision: current,
              };
              throw rejected;
            }
            const issues: { readonly path: string; readonly reason: string }[] = [];
            if (command.executors !== undefined) {
              issues.push(
                ...parseExecutorDeclarations(
                  { executors: command.executors },
                  { defaultMachineId: machineId, path: 'routing' },
                ).issues,
              );
            }
            if (command.reviewTargets !== undefined) {
              issues.push(
                ...parseReviewTargetDeclarations(command.reviewTargets, { path: 'routing.reviewTargets' }).issues,
              );
            }
            if (command.delegation !== undefined) {
              issues.push(
                ...parseDelegationConfig(command.delegation, { defaultMachineId: machineId, path: 'delegation' })
                  .issues,
              );
            }
            if (issues.length > 0) {
              decided.answer = {
                issues: issues.slice(0, 64).map((issue) => ({
                  path: boundUsageEngineReviewMessage(issue.path),
                  reason: boundUsageEngineReviewMessage(issue.reason),
                })),
                kind: 'delegation-config',
                result: 'invalid',
                revision: current,
              };
              throw rejected;
            }
            const routing =
              command.executors === undefined && command.reviewTargets === undefined
                ? config.routing
                : {
                    ...(config.routing ?? { executors: [] }),
                    ...(command.executors === undefined ? {} : { executors: [...command.executors] }),
                    ...(command.reviewTargets === undefined ? {} : { reviewTargets: [...command.reviewTargets] }),
                  };
            const next = {
              ...config,
              ...(routing === undefined ? {} : { routing }),
              ...(command.delegation === undefined ? {} : { delegation: command.delegation }),
            };
            decided.answer = {
              issues: [],
              kind: 'delegation-config',
              result: 'written',
              revision: await delegationPolicyRevision({
                delegation: next.delegation,
                github: next.github,
                routing: next.routing,
              }),
            };
            return next;
          }),
        );
      }, signal);
    } catch (error) {
      const answer = decided.answer;
      if (answer !== null && answer.result !== 'written') {
        report(`usage-engine delegation=config result=${answer.result} issues=${answer.issues.length}`);
        return answer;
      }
      throw error;
    }
    const written = decided.answer;
    if (written === null) {
      throw new Error('the delegation config update completed without an answer');
    }
    report(`usage-engine delegation=config result=written revision=${written.revision}`);
    return written;
  };

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  const liveJobs = async (machineId: string): Promise<readonly DelegationJob[]> =>
    (
      await Effect.runPromise(
        queryDelegationJobs({
          dbPath: options.dbPath,
          limit: RESERVATION_READ_LIMIT,
          machineId,
          states: DELEGATION_LIVE_STATES,
        }),
      )
    ).jobs;

  const recoverLost: DelegationService['recoverLost'] = async () => {
    const at = now().toISOString();
    const machineId = options.machine().id;
    const live = await liveJobs(machineId);
    // Look for each process before recording the loss, so the reason says what was found.
    const scans = new Map<string, Awaited<ReturnType<FindReviewProcesses>>>();
    for (const job of live) {
      if (job.launchMarker !== null) {
        scans.set(job.jobId, await findProcesses(job.launchMarker));
      }
    }
    const describe = (jobId: string): string => {
      const scan = scans.get(jobId);
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
      markDelegationJobsLost({
        at,
        dbPath: options.dbPath,
        machineId,
        reason: ({ jobId, state }) => `engine restarted while ${state}; ${describe(jobId)}`,
      }),
    );
    for (const jobId of result.lost) {
      if (scans.get(jobId)?.kind === 'absent') {
        await Effect.runPromise(
          releaseDelegationJobReservation({ at, dbPath: options.dbPath, evidence: 'process-absent', jobId }),
        );
      }
      await removePrivateDirectory(jobId);
    }
    if (result.lost.length > 0) {
      const held = result.lost.filter((jobId) => scans.get(jobId)?.kind !== 'absent').length;
      report(`usage-engine delegation=lost count=${result.lost.length} held=${held} phase=startup`);
    }
    return result.lost;
  };

  const settle: DelegationService['settle'] = async () => {
    await Promise.all([...runs.values()].map((run) => run.settled));
  };

  const shutdown: DelegationService['shutdown'] = async () => {
    stopping = true;
    // A start in flight either launched (and is tracked once it returns) or recorded its failure.
    await Promise.allSettled([...starts]);
    const tracked = [...runs.values()];
    for (const run of tracked) {
      run.launch.terminate('shutdown');
    }
    await Promise.all(tracked.map((run) => run.settled));
    const remaining = await liveJobs(options.machine().id);
    if (remaining.length === 0) {
      if (tracked.length > 0) {
        report(`usage-engine delegation=stopped count=${tracked.length} phase=shutdown`);
      }
      return;
    }
    await gated(() =>
      Effect.runPromise(
        markDelegationJobsLost({
          at: now().toISOString(),
          dbPath: options.dbPath,
          machineId: options.machine().id,
          reason: () => SHUTDOWN_LOST_REASON,
        }),
      ),
    );
    report(`usage-engine delegation=lost count=${remaining.length} stopped=${tracked.length} phase=shutdown`);
  };

  return {
    admitReview,
    cancel,
    live: () => [...runs.keys()],
    qualify,
    recordEvaluation,
    recoverLost,
    settle,
    shutdown,
    start,
    updateConfig,
  };
};
