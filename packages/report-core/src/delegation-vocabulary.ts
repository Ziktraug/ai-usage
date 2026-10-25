/**
 * The delegation vocabulary, in a module with no import at all. The usage-engine control contract,
 * the MCP adapter and the web contract validate these values; reading them from here keeps the
 * delegation policy, the routing qualification and the executor parsers out of those closures.
 * `delegation-*.ts` modules re-export what they use; this file must stay import-free.
 *
 * A delegation is a bounded task a caller (any MCP client: Claude Code, Codex, OpenCode, Cursor…)
 * hands to AI Usage. The caller describes it, AI Usage qualifies the admissible routes from its own
 * rules and fresh observations, a selector chooses one route or abstains, and the engine runs the
 * chosen executor. The caller's name and session are metadata, never authority.
 */

export const DELEGATION_SCHEMA_VERSION = 1 as const;
/** Version of the stored decision trace (request, routes, choice, execution, evaluations). */
export const DELEGATION_TRACE_VERSION = 1 as const;
export const DELEGATION_QUALIFIER_VERSION = 'delegation-qualifier/1' as const;
export const DELEGATION_SELECTION_CONTRACT = 'delegation-selection/1' as const;

/** The only action this version executes. */
export const DELEGATION_ACTIONS = ['read-only-review'] as const;
export type DelegationAction = (typeof DELEGATION_ACTIONS)[number];
/** Actions the contract names so a request for them is refused explicitly, never executed. */
export const DELEGATION_RESERVED_ACTIONS = ['code-change', 'commit', 'publish'] as const;
export type DelegationReservedAction = (typeof DELEGATION_RESERVED_ACTIONS)[number];

export const DELEGATION_TASK_CATEGORIES = [
  'general-review',
  'correctness',
  'security',
  'design',
  'tests',
  'documentation',
] as const;
export type DelegationTaskCategory = (typeof DELEGATION_TASK_CATEGORIES)[number];

/** Review scopes the engine can freeze to commit SHAs. */
export const DELEGATION_SCOPE_KINDS = ['commit', 'range'] as const;
export type DelegationScopeKind = (typeof DELEGATION_SCOPE_KINDS)[number];
/** Scopes refused explicitly: nothing captures uncommitted changes reliably for a worker. */
export const DELEGATION_RESERVED_SCOPE_KINDS = ['working-tree'] as const;

export const DELEGATION_JOB_STATES = [
  'requested',
  'starting',
  'running',
  'finished',
  'failed',
  'cancelled',
  'refused',
  'abstained',
  'lost',
] as const;
export type DelegationJobState = (typeof DELEGATION_JOB_STATES)[number];
export const DELEGATION_LIVE_STATES = [
  'requested',
  'starting',
  'running',
] as const satisfies readonly DelegationJobState[];
export const DELEGATION_ENDED_STATES = [
  'finished',
  'failed',
  'cancelled',
  'refused',
  'abstained',
] as const satisfies readonly DelegationJobState[];

export const isLiveDelegationState = (state: DelegationJobState): boolean =>
  (DELEGATION_LIVE_STATES as readonly DelegationJobState[]).includes(state);

/** A lost job keeps its reservations until evidence releases it (the ADR 0055 rule). */
export const holdsDelegationReservation = (job: {
  readonly releasedAt: string | null;
  readonly state: DelegationJobState;
}): boolean => isLiveDelegationState(job.state) || (job.state === 'lost' && job.releasedAt === null);

export const DELEGATION_REFUSAL_REASONS = [
  'invalid-request',
  'action-unsupported',
  'scope-unsupported',
  'scope-unavailable',
  'scope-changed',
  'checkout-unavailable',
  'checkout-not-admitted',
  'no-admissible-route',
  'route-not-admissible',
  'qualification-unknown',
  'qualification-expired',
  'qualification-mismatch',
  'policy-changed',
  'identity-changed',
  'target-reserved',
  'pool-busy',
  'attempts-exhausted',
  'idempotency-conflict',
  'executor-unavailable',
  'recursive-delegation',
  'engine-stopping',
] as const;
export type DelegationRefusalReason = (typeof DELEGATION_REFUSAL_REASONS)[number];

/** How an executed job's output was qualified when it ended. */
export const DELEGATION_RESULT_KINDS = ['review', 'unstructured', 'error', 'timeout', 'cancelled'] as const;
export type DelegationResultKind = (typeof DELEGATION_RESULT_KINDS)[number];

export const DELEGATION_FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'note'] as const;
export type DelegationFindingSeverity = (typeof DELEGATION_FINDING_SEVERITIES)[number];

export const DELEGATION_RELEASE_EVIDENCE = [
  'process-absent',
  'outcome-recorded-late',
  'operator-declared-ended',
] as const;
export type DelegationReleaseEvidence = (typeof DELEGATION_RELEASE_EVIDENCE)[number];

/** Execution, verification and acceptance are three different facts. */
export const DELEGATION_EVALUATION_KINDS = ['verification', 'acceptance'] as const;
export type DelegationEvaluationKind = (typeof DELEGATION_EVALUATION_KINDS)[number];
export const DELEGATION_VERIFICATION_VERDICTS = [
  'confirmed',
  'partially-confirmed',
  'refuted',
  'inconclusive',
] as const;
export type DelegationVerificationVerdict = (typeof DELEGATION_VERIFICATION_VERDICTS)[number];
export const DELEGATION_ACCEPTANCE_VERDICTS = ['accepted', 'rejected', 'taken-over'] as const;
export type DelegationAcceptanceVerdict = (typeof DELEGATION_ACCEPTANCE_VERDICTS)[number];
/**
 * Who recorded an evaluation. `operator` is written only by the Web edge, where the person acts;
 * the MCP edge always records `calling-model`; the engine's own output check is `automated-check`.
 * A model or a check never records an acceptance as the operator's.
 */
export const DELEGATION_EVALUATION_AUTHORS = ['operator', 'calling-model', 'automated-check'] as const;
export type DelegationEvaluationAuthor = (typeof DELEGATION_EVALUATION_AUTHORS)[number];

export const DELEGATION_SELECTION_KINDS = ['choice', 'abstain'] as const;
export type DelegationSelectionKind = (typeof DELEGATION_SELECTION_KINDS)[number];
export const DELEGATION_ABSTENTION_REASONS = [
  'keep-with-caller',
  'no-suitable-route',
  'insufficient-confidence',
  'task-unsuitable',
] as const;
export type DelegationAbstentionReason = (typeof DELEGATION_ABSTENTION_REASONS)[number];

export const DELEGATION_CONTEXTS = ['professional', 'personal'] as const;
export type DelegationContext = (typeof DELEGATION_CONTEXTS)[number];
export const DELEGATION_PROVIDERS = ['anthropic', 'openai'] as const;
export type DelegationProvider = (typeof DELEGATION_PROVIDERS)[number];
/** The proof a policy requires for the account a route runs under. */
export const DELEGATION_IDENTITY_EVIDENCE = ['declared', 'observed'] as const;
export type DelegationIdentityEvidence = (typeof DELEGATION_IDENTITY_EVIDENCE)[number];

export const DELEGATION_RULE_EFFECTS = ['forbid', 'restrict', 'require'] as const;
export type DelegationRuleEffect = (typeof DELEGATION_RULE_EFFECTS)[number];

export const DELEGATION_QUALIFICATION_PURPOSES = ['delegation', 'simulation'] as const;
export type DelegationQualificationPurpose = (typeof DELEGATION_QUALIFICATION_PURPOSES)[number];
export const DELEGATION_QUALIFICATION_OUTCOMES = ['routes-available', 'no-admissible-route', 'refused'] as const;
export type DelegationQualificationOutcome = (typeof DELEGATION_QUALIFICATION_OUTCOMES)[number];

/** Answers of `cancel-delegation`; a cancellation never signals a process this engine did not start. */
export const DELEGATION_CANCEL_RESULTS = ['cancelling', 'already-ended', 'not-found', 'not-cancellable-lost'] as const;
export type DelegationCancelResult = (typeof DELEGATION_CANCEL_RESULTS)[number];

export const DELEGATION_CONFIG_WRITE_RESULTS = ['written', 'revision-conflict', 'invalid'] as const;
export type DelegationConfigWriteResult = (typeof DELEGATION_CONFIG_WRITE_RESULTS)[number];

/** Executors this version can launch; OpenCode and Cursor are cataloged, never launched. */
export const DELEGATION_EXECUTOR_HARNESSES = ['claude-code', 'codex'] as const;
export type DelegationExecutorHarness = (typeof DELEGATION_EXECUTOR_HARNESSES)[number];
export const DELEGATION_CATALOGED_HARNESSES = ['claude-code', 'codex', 'opencode', 'cursor'] as const;
export type DelegationCatalogedHarness = (typeof DELEGATION_CATALOGED_HARNESSES)[number];

/** Environment variable set in every worker; a delegation request made under it is refused. */
export const DELEGATION_DEPTH_ENVIRONMENT_KEY = 'AI_USAGE_DELEGATION_DEPTH' as const;

export const DELEGATION_BOUNDS = {
  maxConstraintCharacters: 500,
  maxConstraints: 12,
  maxCriteria: 12,
  maxCriterionCharacters: 500,
  maxCheckoutPathCharacters: 4096,
  maxClientCorrelationCharacters: 128,
  maxClientNameCharacters: 64,
  maxClientSessionRefCharacters: 256,
  maxEvaluationChecks: 12,
  maxEvaluationCheckCharacters: 300,
  maxEvaluationNoteCharacters: 2000,
  maxIdempotencyKeyCharacters: 128,
  minIdempotencyKeyCharacters: 8,
  maxObjectiveCharacters: 2000,
  maxRevisionCharacters: 256,
  maxSelectionRationale: 4,
  maxSelectionRationaleCharacters: 300,
  maxSelectorVersionCharacters: 128,
  /** The transported qualification stays under the control plane's 64 KiB completion bound. */
  maxQualificationBytes: 48 * 1024,
  /** One job view (status and result) as MCP, CLI and Web read it. */
  maxJobViewBytes: 64 * 1024,
  /** The worker's final message kept for parsing and display. */
  maxWorkerFinalTextBytes: 32 * 1024,
} as const;

export const DELEGATION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;
/** A Git revision the engine resolves itself; never an option, never a path with spaces. */
export const DELEGATION_REVISION_PATTERN = /^[A-Za-z0-9._/@{}^~+-]{1,256}$/u;

/**
 * Why a route is not admissible, one code per exclusion family; the launch maps the codes that
 * have a typed refusal (`pool-busy`, `attempts-exhausted`, `identity-changed`).
 */
export const DELEGATION_ROUTE_BLOCKERS = [
  'context-undeclared',
  'forbidden-by-rule',
  'outside-restriction',
  'incompatible-rules',
  'authorization',
  'subscription',
  'availability',
  'capability',
  'identity',
  'identity-changed',
  'identity-evidence',
  'quota',
  'reserve',
  'quota-before-account-change',
  'pool-busy',
  'attempts-exhausted',
  'unsettled-fact',
  'other',
] as const;
export type DelegationRouteBlocker = (typeof DELEGATION_ROUTE_BLOCKERS)[number];
