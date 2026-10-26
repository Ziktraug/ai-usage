import type {
  DelegationAbstentionReason,
  DelegationAcceptanceVerdict,
  DelegationAction,
  DelegationCancelResult,
  DelegationContext,
  DelegationEvaluationAuthor,
  DelegationEvaluationKind,
  DelegationExecutorHarness,
  DelegationFindingSeverity,
  DelegationIdentityEvidence,
  DelegationJobState,
  DelegationProvider,
  DelegationQualificationOutcome,
  DelegationQualificationPurpose,
  DelegationRefusalReason,
  DelegationReleaseEvidence,
  DelegationResultKind,
  DelegationRouteBlocker,
  DelegationRuleEffect,
  DelegationScopeKind,
  DelegationTaskCategory,
  DelegationVerificationVerdict,
} from './delegation-vocabulary';

/**
 * The delegation contracts as types only (no behaviour). Parsers and policy live in
 * `delegation-request.ts`, `delegation-policy.ts`, `delegation-qualification.ts`,
 * `delegation-result.ts` and `delegation-job.ts`; every edge (engine control, MCP, CLI, Web)
 * transports these shapes. The caller's identity is metadata: nothing in a request authorizes.
 */

// ---------------------------------------------------------------------------------------------
// Request (what a caller asks for)
// ---------------------------------------------------------------------------------------------

export type DelegationScopeRequest =
  | { readonly commit: string; readonly kind: 'commit' }
  | { readonly base: string; readonly head: string; readonly kind: 'range' };

/** Informative only; never used to authorize, route or bill. */
export interface DelegationClientInfo {
  readonly correlationId?: string;
  readonly name?: string;
  readonly sessionRef?: string;
}

export interface DelegationRequest {
  readonly action: DelegationAction;
  readonly checkout: { readonly path: string };
  readonly client?: DelegationClientInfo;
  /** What the worker must not do or must respect (bounded, informative for the worker). */
  readonly constraints: readonly string[];
  /** What a good result must establish (bounded); recorded as success criteria. */
  readonly criteria: readonly string[];
  readonly objective: string;
  /** The job this request retries or escalates; its chain counts against `maxAttempts`. */
  readonly retryOf?: string;
  readonly schemaVersion: 1;
  readonly scope: DelegationScopeRequest;
  readonly taskCategory: DelegationTaskCategory;
}

// ---------------------------------------------------------------------------------------------
// Engine-resolved facts (never taken from the caller)
// ---------------------------------------------------------------------------------------------

/** The checkout as the engine resolved it on disk, admitted or not by `routing.reviewTargets[]`. */
export interface ResolvedDelegationCheckout {
  /** The `routing.reviewTargets[]` entry that admits the canonical path, or `null`. */
  readonly admittedBy: string | null;
  /** Canonical path: realpath of `git rev-parse --show-toplevel` of the requested path. */
  readonly path: string;
  /** The checkout directory name, the label a declared `project` target admits (ADR 0058). */
  readonly projectLabel: string;
}

/** The scope frozen to object ids; a commit review never widens to a branch. */
export interface FrozenDelegationScope {
  /** `first-parent` or `empty-tree` for a commit; `range-base` for a range. */
  readonly base: 'empty-tree' | 'first-parent' | 'range-base';
  readonly baseRef: string | null;
  readonly baseSha: string;
  /** Commits in `base..head` (1 for a commit scope). */
  readonly commitCount: number;
  readonly headRef: string;
  readonly headSha: string;
  readonly kind: DelegationScopeKind;
}

/**
 * `declared`: an operator declaration. `observed`: read in full from the machine. `unknown`: not
 * readable (`value` is `null`). `partial`: observed, but at least one source could not be
 * identified — `value` lists only what was identified, so an absent entry is not a known absence.
 * Only list facts can be `partial`; a scalar fact is observed or unknown.
 */
export type DelegationFactProvenance = 'declared' | 'observed' | 'partial' | 'unknown';

export interface DelegationFact<Value> {
  readonly provenance: DelegationFactProvenance;
  /** Where the value came from, e.g. "git remote -v" or "github.accounts[owner=acme]"; counts, never a URL. */
  readonly source: string;
  readonly value: Value | null;
}

/** Local facts about the checkout that rules may match. The Git author is not the GitHub account. */
export interface DelegationCheckoutFacts {
  /** Local `git config user.email` of the checkout (observed); the commit author identity. */
  readonly gitAuthorEmail: DelegationFact<string>;
  /** `github.accounts[]` login declared for the repository owner (operator declaration). */
  readonly githubAccount: DelegationFact<string>;
  /** Owners of the checkout's github.com remotes (observed from `git remote -v`). */
  readonly githubOwners: DelegationFact<readonly string[]>;
  /** `owner/name` of the checkout's github.com remotes (observed). */
  readonly repositories: DelegationFact<readonly string[]>;
}

// ---------------------------------------------------------------------------------------------
// Configuration (home `delegation` section; `routing.executors[]` stays the route declaration)
// ---------------------------------------------------------------------------------------------

export interface DelegationDefaults {
  readonly identityEvidence: DelegationIdentityEvidence;
  readonly maxAttempts: number;
  readonly maxConcurrentPerPool: number;
  readonly qualificationTtlSeconds: number;
  readonly reservePercent: number;
}

export interface DelegationRouteAnnotation {
  readonly accountScope: string;
  readonly context: DelegationContext;
  readonly harness: DelegationExecutorHarness;
  readonly label?: string;
  /** Defaults to this machine. */
  readonly machineId?: string;
  readonly maxConcurrent?: number;
  readonly reservePercent?: number;
}

export interface DelegationRuleMatch {
  /** Canonical checkout path prefix, compared on path-segment boundaries. */
  readonly checkoutPath?: string;
  readonly gitAuthorEmail?: string;
  /** Matches the `github.accounts[]` login declared for the repository owner. */
  readonly githubAccount?: string;
  readonly githubOwner?: string;
  /** `owner/name`, case-insensitive. */
  readonly repository?: string;
}

export interface DelegationRouteSelector {
  readonly accountScopes?: readonly string[];
  readonly contexts?: readonly DelegationContext[];
  readonly harnesses?: readonly DelegationExecutorHarness[];
  readonly providers?: readonly DelegationProvider[];
}

export interface DelegationRequirements {
  readonly identityEvidence?: DelegationIdentityEvidence;
  readonly maxAttempts?: number;
  readonly maxConcurrent?: number;
  readonly reservePercent?: number;
}

export interface DelegationRule {
  readonly description?: string;
  readonly effect: DelegationRuleEffect;
  readonly id: string;
  readonly match: DelegationRuleMatch;
  /** The routes the rule forbids, restricts to, or constrains; absent = every route. */
  readonly require?: DelegationRequirements;
  readonly routes?: DelegationRouteSelector;
}

export interface DelegationPreferences {
  readonly harnesses: readonly DelegationExecutorHarness[];
  /** Native model ids in preference order. */
  readonly models: readonly string[];
  /** Order routes whose applicable window resets within this horizon first; `null` = off. */
  readonly nearResetMinutes: number | null;
}

/** An operator's declaration about a model; never a measured performance. */
export interface DelegationModelEntry {
  readonly alias: string | null;
  readonly declaredAt: string;
  readonly discouragedFor: readonly DelegationTaskCategory[];
  readonly harnesses: readonly DelegationExecutorHarness[];
  readonly id: string;
  readonly nativeId: string;
  readonly note: string | null;
  readonly provider: DelegationProvider;
  readonly recommendedFor: readonly DelegationTaskCategory[];
  /** A dated snapshot or version when known; `null` means unknown, never guessed. */
  readonly resolvedVersion: string | null;
}

export interface DelegationConfig {
  readonly defaults: DelegationDefaults;
  readonly models: readonly DelegationModelEntry[];
  readonly preferences: DelegationPreferences;
  readonly routes: readonly DelegationRouteAnnotation[];
  readonly rules: readonly DelegationRule[];
}

export interface DelegationConfigIssue {
  /** Config path such as `delegation.rules[2].match.repository`; never the offending value. */
  readonly path: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------------------------
// Qualification (what the selector chooses from)
// ---------------------------------------------------------------------------------------------

export interface DelegationAppliedRule {
  /** `yes`: every condition matched an observed or declared fact; `assumed`: a needed fact is unknown. */
  readonly applies: 'assumed' | 'yes';
  readonly effect: DelegationRuleEffect;
  readonly id: string;
  readonly reason: string;
}

export interface DelegationQuotaWindowFact {
  readonly label: string;
  readonly observedAt: string | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly scope: 'account' | 'model' | 'unknown';
}

export interface DelegationRouteRequirements {
  readonly identityEvidence: DelegationIdentityEvidence;
  readonly maxAttempts: number;
  readonly maxConcurrent: number;
  readonly reservePercent: number;
}

export interface DelegationRoute {
  readonly accountScope: string | null;
  readonly admissible: boolean;
  /** Facts in the route's favour (declared recommendation, confirmed identity, resets…). */
  readonly advantages: readonly string[];
  /** One code per exclusion family; empty when admissible. */
  readonly blockers: readonly DelegationRouteBlocker[];
  readonly context: DelegationContext | null;
  readonly effort: string | null;
  readonly exclusions: readonly string[];
  readonly harness: DelegationExecutorHarness;
  readonly identity: {
    readonly declared: string | null;
    readonly observed: string | null;
    readonly state: string;
  } | null;
  readonly label: string;
  /** Facts against it (identity only declared, guarantee limits, discouraged category…). */
  readonly limits: readonly string[];
  readonly liveJobsInPool: number;
  readonly missing: readonly string[];
  readonly model: string | null;
  /** Deterministic tie-break among admissible routes (0 first, `null` when excluded); never a judgment of the task. */
  readonly orderHint: number | null;
  readonly poolId: string;
  readonly provider: DelegationProvider;
  readonly quota: readonly DelegationQuotaWindowFact[];
  readonly requirements: DelegationRouteRequirements;
  readonly routeId: string;
}

export interface DelegationQualificationVersions {
  readonly catalogRevision: string;
  readonly policyRevision: string;
  readonly qualifier: string;
  readonly selectorContract: string;
}

export interface DelegationQualification {
  readonly admissibleRouteIds: readonly string[];
  readonly appliedRules: readonly DelegationAppliedRule[];
  readonly assumptions: readonly string[];
  readonly checkout: ResolvedDelegationCheckout | null;
  readonly checkoutFacts: DelegationCheckoutFacts | null;
  readonly omittedRoutes: number;
  readonly outcome: DelegationQualificationOutcome;
  readonly purpose: DelegationQualificationPurpose;
  readonly qualificationId: string;
  readonly qualifiedAt: string;
  readonly refusal: { readonly message: string; readonly reason: DelegationRefusalReason } | null;
  readonly request: {
    readonly action: string;
    readonly digest: string;
    readonly taskCategory: string;
  };
  readonly routes: readonly DelegationRoute[];
  readonly schemaVersion: 1;
  readonly scope: FrozenDelegationScope | null;
  readonly validUntil: string;
  readonly versions: DelegationQualificationVersions;
}

// ---------------------------------------------------------------------------------------------
// Selection (the replaceable selector contract)
// ---------------------------------------------------------------------------------------------

export type DelegationSelection =
  | {
      /** Self-reported by the selector; never a measured probability that the task succeeds. */
      readonly confidence?: number;
      readonly kind: 'choice';
      readonly qualificationId: string;
      /** Short factual reasons the selector gives; stored as its statement, not as evidence. */
      readonly rationale?: readonly string[];
      readonly routeId: string;
      readonly selectorVersion: string;
    }
  | {
      readonly kind: 'abstain';
      readonly note?: string;
      readonly qualificationId: string;
      readonly reason: DelegationAbstentionReason;
      readonly selectorVersion: string;
    };

// ---------------------------------------------------------------------------------------------
// Worker output (the structured result contract) and execution facts
// ---------------------------------------------------------------------------------------------

export interface DelegationFindingEvidence {
  readonly line: number | null;
  readonly path: string;
}

export interface DelegationFinding {
  readonly detail: string;
  readonly evidence: readonly DelegationFindingEvidence[];
  readonly severity: DelegationFindingSeverity;
  readonly title: string;
}

/** What the worker's final message must contain; parsed strictly, bounded. */
export interface DelegationReviewResult {
  readonly checks: readonly string[];
  readonly coverage: { readonly notReviewed: readonly string[]; readonly reviewed: string };
  readonly findings: readonly DelegationFinding[];
  readonly limits: readonly string[];
  readonly summary: string;
}

/** The scope as actually given to the worker: coverage and truncation are part of the result. */
export interface DelegationExecutedScope {
  readonly fileCount: number;
  readonly files: readonly {
    readonly coverage: 'binary' | 'complete' | 'omitted' | 'partial';
    readonly path: string;
  }[];
  readonly includedBytes: number;
  readonly patchBytes: number;
  readonly patchSha256: string;
  readonly truncated: boolean;
  readonly workingTreeDirty: boolean;
}

/** What the harness was allowed to do, as launched; read-only rests on these controls. */
export interface DelegationHarnessGuarantee {
  readonly cliVersion: string;
  /** Human-readable controls, e.g. "sandbox read-only", "tools Read Grep Glob", "no MCP servers". */
  readonly controls: readonly string[];
  readonly effort: string | null;
  readonly harness: DelegationExecutorHarness;
  /** What the controls do not cover (managed policy, harness session logs…). */
  readonly limits: readonly string[];
  readonly model: string | null;
}

/** Tokens as the harness reported them; `null` when it reported none. Never converted to a budget. */
export interface DelegationUsage {
  readonly cachedInputTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly source: 'harness-reported';
}

export interface DelegationJobResult {
  /** The worker's final text when it did not satisfy the contract, bounded; else `null`. */
  readonly excerpt: string | null;
  readonly kind: DelegationResultKind;
  readonly review: DelegationReviewResult | null;
}

export interface DelegationEvaluation {
  readonly author: DelegationEvaluationAuthor;
  /** A free label the edge supplies ("claude-code", "web"); never an authority. */
  readonly authorLabel: string | null;
  readonly checks: readonly string[];
  readonly evaluationId: string;
  readonly jobId: string;
  readonly kind: DelegationEvaluationKind;
  readonly note: string | null;
  readonly recordedAt: string;
  readonly verdict: DelegationAcceptanceVerdict | DelegationVerificationVerdict;
}

export interface DelegationJob {
  readonly accountScope: string | null;
  readonly action: string;
  readonly attemptNumber: number;
  readonly cancelRequestedAt: string | null;
  readonly checkoutPath: string | null;
  readonly context: DelegationContext | null;
  readonly effort: string | null;
  readonly endedAt: string | null;
  readonly executedScope: DelegationExecutedScope | null;
  readonly executorHarness: DelegationExecutorHarness | null;
  readonly exitCode: number | null;
  readonly failureReason: string | null;
  readonly guarantee: DelegationHarnessGuarantee | null;
  readonly harnessVersion: string | null;
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly launchMarker: string | null;
  readonly machineId: string;
  readonly modelRequested: string | null;
  /** The model the harness reported running, when it reported one; else `null` (unknown). */
  readonly modelResolved: string | null;
  readonly nativeSessionId: string | null;
  readonly pid: number | null;
  readonly poolId: string | null;
  readonly qualification: DelegationQualification | null;
  readonly qualificationId: string | null;
  readonly refusalReason: DelegationRefusalReason | null;
  readonly releasedAt: string | null;
  readonly releaseEvidence: DelegationReleaseEvidence | null;
  readonly request: DelegationRequest;
  readonly requestDigest: string;
  readonly requestedAt: string;
  readonly result: DelegationJobResult | null;
  readonly retryOf: string | null;
  readonly routeId: string | null;
  readonly scope: FrozenDelegationScope | null;
  readonly selection: DelegationSelection | null;
  readonly startedAt: string | null;
  readonly state: DelegationJobState;
  readonly taskCategory: string;
  readonly traceVersion: number;
  readonly updatedAt: string;
  readonly usage: DelegationUsage | null;
}

// ---------------------------------------------------------------------------------------------
// Command answers (shared by the engine control contract, MCP and CLI)
// ---------------------------------------------------------------------------------------------

export interface DelegationStartAnswer {
  readonly job: { readonly jobId: string; readonly reused: boolean; readonly state: DelegationJobState } | null;
  readonly refusal: { readonly message: string; readonly reason: DelegationRefusalReason } | null;
}

export interface DelegationCancelAnswer {
  readonly jobId: string;
  readonly result: DelegationCancelResult;
  readonly state: DelegationJobState | null;
}
