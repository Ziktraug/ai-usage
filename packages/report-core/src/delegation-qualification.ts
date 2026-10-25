import { isCanonicalInstant } from './canonical-instant';
import { isRecord } from './datasets';
import type {
  DelegationAppliedRule,
  DelegationCheckoutFacts,
  DelegationConfig,
  DelegationFact,
  DelegationModelEntry,
  DelegationQualification,
  DelegationQuotaWindowFact,
  DelegationRequest,
  DelegationRoute,
  DelegationRouteAnnotation,
  DelegationRouteRequirements,
  DelegationSelection,
  FrozenDelegationScope,
  ResolvedDelegationCheckout,
} from './delegation-contracts';
import { evaluateDelegationRules, evaluateRoutePolicy } from './delegation-policy';
import { isDelegationUuid } from './delegation-request';
import {
  DELEGATION_BOUNDS,
  DELEGATION_CONTEXTS,
  DELEGATION_EXECUTOR_HARNESSES,
  DELEGATION_IDENTITY_EVIDENCE,
  DELEGATION_PROVIDERS,
  DELEGATION_QUALIFICATION_OUTCOMES,
  DELEGATION_QUALIFICATION_PURPOSES,
  DELEGATION_QUALIFIER_VERSION,
  DELEGATION_REFUSAL_REASONS,
  DELEGATION_ROUTE_BLOCKERS,
  DELEGATION_RULE_EFFECTS,
  DELEGATION_SCHEMA_VERSION,
  DELEGATION_SCOPE_KINDS,
  DELEGATION_SELECTION_CONTRACT,
  type DelegationExecutorHarness,
  type DelegationProvider,
  type DelegationQualificationPurpose,
  type DelegationRefusalReason,
  type DelegationRouteBlocker,
} from './delegation-vocabulary';
import type { ProviderLimitWindow, ProviderStatus } from './provider-status';
import { normalizeCheckoutPath } from './work-attempts';
import type { ExecutorDeclaration, ExecutorHarness, ExecutorObservation } from './work-executors';
import {
  type CheckoutRoutingTarget,
  DEFAULT_QUALIFICATION_FRESHNESS,
  evaluateReviewCandidates,
  MAX_REVIEW_ROUTING_CANDIDATES,
  QUALIFICATION_POLICY,
  type QualificationFreshness,
  qualifyReviewCandidates,
  quotaWindowAppliesToModel,
  type ReviewCandidate,
  type ReviewCandidateEvaluation,
  unsettledReviewFacts,
} from './work-routing';
import {
  CANDIDATE_IDENTITY_STATES,
  isExecutorAccountFingerprint,
  isRoutingId,
  serializedQualificationBytes,
} from './work-routing-vocabulary';

/**
 * The delegation qualification: from one request, the engine's freshly read facts and the
 * operator's policy, the list of routes a selector may choose from, each admissible or excluded
 * for stated reasons, with factual advantages and limits and a deterministic tie-break. Pure and
 * deterministic: identical inputs give identical output, and nothing here starts anything.
 *
 * The launch decision (`decideDelegationLaunch`) re-qualifies from fresh facts with the same
 * function and refuses when the cited qualification, the policy, the scope or the route moved.
 */

export const DELEGATION_QUALIFICATION_BOUNDS = {
  /** Applied rules follow the rule bound of the config. */
  maxAppliedRules: 64,
  /** One assumption per assumed rule, plus the fixed orderHint sentence. */
  maxAssumptions: 65,
  maxBytes: DELEGATION_BOUNDS.maxQualificationBytes,
  /** Entries kept per list (exclusions, missing, advantages, limits, quota windows). */
  maxEntries: 12,
  maxRoutes: 32,
  /** Characters kept per text entry; a longer one ends with an ellipsis, never silently cut. */
  maxText: 300,
} as const;

export const ORDER_HINT_ASSUMPTION =
  'orderHint is a deterministic tie-break from preferences, not a judgment of the task; choose by the task';

export interface DelegationHarnessControls {
  /** What the launch denies the harness, in words ("sandbox read-only", "tools Read Grep Glob"). */
  readonly controls: readonly string[];
  /** What those controls do not cover. */
  readonly limits: readonly string[];
}

export type DelegationCheckoutInput =
  | ResolvedDelegationCheckout
  | { readonly failure: 'checkout-unavailable'; readonly message: string };

export type DelegationScopeInput =
  | FrozenDelegationScope
  | { readonly failure: 'scope-unavailable' | 'scope-unsupported'; readonly message: string };

export interface DelegationReservations {
  /** Jobs in the retry chain of `request.retryOf` (the earlier job and its retries). */
  readonly attemptsInChain: number;
  /** Reserving jobs per pool id (live, or lost and unreleased). */
  readonly liveJobsByPool: ReadonlyMap<string, number>;
  /** The job that already reserves this action, checkout and frozen scope, when one does. */
  readonly targetReservedBy: string | null;
}

/**
 * When the signed-in account of one executor last changed, as the engine persisted it when the
 * observations were imported (`executor_account_changes`). Independent of how many observations the
 * store retains: the history may no longer show the previous account, the barrier still does.
 */
export interface ExecutorAccountChange {
  /** `null` when every fingerprint the executor ever reported was the current one. */
  readonly changedAt: string | null;
  readonly harness: ExecutorHarness;
  readonly machineId: string;
}

export interface QualifyDelegationInput {
  /**
   * The persisted account-change barriers, one per executor. A route's change time is the later of
   * its barrier and the change its retained history shows, so pruning never weakens it. Absent for a
   * caller that has no barrier table (a query-only reader of a store the engine has not migrated);
   * only the history-derived change applies then.
   */
  readonly accountChanges?: readonly ExecutorAccountChange[];
  readonly checkout: DelegationCheckoutInput;
  readonly checkoutFacts: DelegationCheckoutFacts;
  readonly config: DelegationConfig;
  readonly declarations: readonly ExecutorDeclaration[];
  /** Retained history (up to 10 per executor), the newest included; account changes are read from it. */
  readonly executorObservations: readonly ExecutorObservation[];
  readonly freshness?: Partial<QualificationFreshness>;
  readonly harnessControls: Readonly<Record<DelegationExecutorHarness, DelegationHarnessControls>>;
  readonly machineId: string;
  readonly now: string;
  readonly providers: readonly ProviderStatus[];
  readonly purpose: DelegationQualificationPurpose;
  readonly qualificationId: string;
  readonly request: DelegationRequest;
  readonly requestDigest: string;
  readonly reservations: DelegationReservations;
  readonly scope: DelegationScopeInput;
  readonly versions: { readonly catalogRevision: string; readonly policyRevision: string };
}

const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};
const timestamp = (value: string | null | undefined): number | null =>
  isCanonicalInstant(value) ? Date.parse(value) : null;
const sameText = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const boundedText = (text: string): string =>
  text.length <= DELEGATION_QUALIFICATION_BOUNDS.maxText
    ? text
    : `${text.slice(0, DELEGATION_QUALIFICATION_BOUNDS.maxText - 1)}…`;
const boundedList = (values: readonly string[]): string[] =>
  [...new Set(values)].slice(0, DELEGATION_QUALIFICATION_BOUNDS.maxEntries).map(boundedText);

const providerOf = (harness: DelegationExecutorHarness): DelegationProvider =>
  harness === 'claude-code' ? 'anthropic' : 'openai';

const isDelegationHarness = (value: string): value is DelegationExecutorHarness =>
  (DELEGATION_EXECUTOR_HARNESSES as readonly string[]).includes(value);

// ---------------------------------------------------------------------------------------------
// Exclusion families
// ---------------------------------------------------------------------------------------------

/** The families `assessReviewRecommendation` recognises, in the order a reason is tried against them. */
const EXCLUSION_BLOCKERS: readonly (readonly [RegExp, DelegationRouteBlocker])[] = [
  [/account identity/iu, 'identity'],
  [/authorization|forbidden/iu, 'authorization'],
  [/subscription|billing/iu, 'subscription'],
  [/availab/iu, 'availability'],
  [/capability|quality/iu, 'capability'],
  [/quota|account scope/iu, 'quota'],
];

const blockerForExclusion = (reason: string, identityState: string | undefined): DelegationRouteBlocker => {
  for (const [pattern, blocker] of EXCLUSION_BLOCKERS) {
    if (pattern.test(reason)) {
      return blocker === 'identity' && identityState === 'contradicted' ? 'identity-changed' : blocker;
    }
  }
  return 'other';
};

// ---------------------------------------------------------------------------------------------
// Facts about one route
// ---------------------------------------------------------------------------------------------

const remainingOf = (window: ProviderLimitWindow): number | null =>
  window.remainingPercent ?? (window.usedPercent === null ? null : 100 - window.usedPercent);

const windowScope = (window: ProviderLimitWindow): DelegationQuotaWindowFact['scope'] => {
  if (window.scope === 'model') {
    return 'model';
  }
  return window.scope === 'unknown' ? 'unknown' : 'account';
};

const applicableWindows = (candidate: ReviewCandidate): ProviderLimitWindow[] =>
  (candidate.quota?.windows ?? []).filter((window) => quotaWindowAppliesToModel(window, candidate.model));

const quotaFacts = (candidate: ReviewCandidate): DelegationQuotaWindowFact[] =>
  applicableWindows(candidate)
    .slice(0, DELEGATION_QUALIFICATION_BOUNDS.maxEntries)
    .map((window) => ({
      label: boundedText(window.label),
      observedAt: candidate.quota?.generatedAt ?? null,
      remainingPercent: remainingOf(window),
      resetsAt: window.resetsAt,
      scope: windowScope(window),
    }));

/** Future resets of the windows that bound this route, as epoch milliseconds, ascending. */
const futureResets = (candidate: ReviewCandidate, now: number): number[] =>
  applicableWindows(candidate)
    .map((window) => timestamp(window.resetsAt))
    .filter((reset): reset is number => reset !== null && reset > now)
    .sort((left, right) => left - right);

/**
 * When the signed-in account last changed, read from the retained observations of one executor:
 * the first observation of the newest run carrying the current fingerprint, when an earlier
 * observation carried another one. `null` when no change is observed or no fingerprint is current.
 */
export const observedAccountChangeAt = (observations: readonly ExecutorObservation[]): string | null => {
  const sorted = [...observations].sort((left, right) => compareText(left.observedAt, right.observedAt));
  const latest = sorted.at(-1);
  const current = latest?.accountFingerprint ?? null;
  if (latest === undefined || current === null) {
    return null;
  }
  let runStart = sorted.length - 1;
  while (runStart > 0 && (sorted[runStart - 1]?.accountFingerprint ?? null) === current) {
    runStart--;
  }
  const changed = sorted
    .slice(0, runStart)
    .some((entry) => (entry.accountFingerprint ?? null) !== null && entry.accountFingerprint !== current);
  return changed ? (sorted[runStart]?.observedAt ?? null) : null;
};

/** The later of two canonical instants; the one known when the other is `null`. */
const laterInstant = (left: string | null, right: string | null): string | null => {
  if (left === null || right === null) {
    return left ?? right;
  }
  return compareText(left, right) >= 0 ? left : right;
};

const catalogEntry = (
  models: readonly DelegationModelEntry[],
  provider: DelegationProvider,
  model: string | null,
): DelegationModelEntry | null => {
  if (model === null) {
    return null;
  }
  return (
    models.find(
      (entry) =>
        entry.provider === provider &&
        (sameText(entry.nativeId, model) ||
          sameText(entry.id, model) ||
          (entry.alias !== null && sameText(entry.alias, model))),
    ) ?? null
  );
};

const catalogSentence = (entry: DelegationModelEntry, verb: string, category: string): string =>
  `Declared ${verb} ${category} (operator declaration, declaredAt ${entry.declaredAt}; resolved version ${
    entry.resolvedVersion ?? 'unknown'
  })`;

interface RouteDraft {
  /** Epoch ms of the facts' freshness expiries and future resets; the earliest bounds `validUntil`. */
  readonly expiries: readonly number[];
  readonly harnessRank: number;
  readonly modelRank: number;
  readonly nearestReset: number;
  readonly route: DelegationRoute;
}

interface RouteContext {
  readonly accountChangeAt: string | null;
  readonly annotation: DelegationRouteAnnotation | null;
  readonly applied: readonly DelegationAppliedRule[];
  readonly candidate: ReviewCandidate;
  readonly evaluation: ReviewCandidateEvaluation | undefined;
  readonly input: QualifyDelegationInput;
  readonly now: number;
  readonly observation: ExecutorObservation | undefined;
  readonly sharedPoolSize: number;
}

const annotationFor = (
  config: DelegationConfig,
  candidate: ReviewCandidate,
  machineId: string,
): DelegationRouteAnnotation | null =>
  config.routes.find(
    (route) =>
      route.harness === candidate.harness &&
      route.accountScope === candidate.accountScope &&
      (route.machineId ?? machineId) === candidate.machineId,
  ) ?? null;

const defaultRequirements = (config: DelegationConfig): DelegationRouteRequirements => ({
  identityEvidence: config.defaults.identityEvidence,
  maxAttempts: config.defaults.maxAttempts,
  maxConcurrent: config.defaults.maxConcurrentPerPool,
  reservePercent: config.defaults.reservePercent,
});

const identityOf = (candidate: ReviewCandidate): DelegationRoute['identity'] =>
  candidate.identity === undefined
    ? null
    : { declared: candidate.identity.declared, observed: candidate.identity.observed, state: candidate.identity.state };

const rank = (values: readonly string[], value: string | null): number => {
  if (value === null) {
    return Number.POSITIVE_INFINITY;
  }
  const index = values.findIndex((entry) => sameText(entry, value));
  return index < 0 ? Number.POSITIVE_INFINITY : index;
};

const nearestResetWithin = (resets: readonly number[], now: number, horizonMinutes: number | null): number => {
  if (horizonMinutes === null) {
    return Number.POSITIVE_INFINITY;
  }
  const horizon = now + horizonMinutes * 60_000;
  return resets.find((reset) => reset <= horizon) ?? Number.POSITIVE_INFINITY;
};

/** A quota stream nobody declared: visible so the operator sees what a declaration would bind, never admissible. */
const observedOnlyDraft = (context: RouteContext): RouteDraft => {
  const { candidate, input } = context;
  const provider = providerOf(candidate.harness);
  const declareAction = candidate.qualificationActions[0];
  return {
    expiries: [],
    harnessRank: Number.POSITIVE_INFINITY,
    modelRank: Number.POSITIVE_INFINITY,
    nearestReset: Number.POSITIVE_INFINITY,
    route: {
      accountScope: candidate.accountScope,
      admissible: false,
      advantages: [],
      blockers: ['authorization'],
      context: null,
      effort: null,
      exclusions: boundedList([
        'Not declared in routing.executors[]; a quota observation alone never authorizes.',
        ...(declareAction === undefined ? [] : [declareAction]),
      ]),
      harness: candidate.harness,
      identity: identityOf(candidate),
      label: boundedText(`${candidate.harness} · ${candidate.accountScope ?? 'unknown account'} (observed only)`),
      limits: [],
      liveJobsInPool: input.reservations.liveJobsByPool.get(candidate.id) ?? 0,
      missing: [],
      model: null,
      orderHint: null,
      poolId: candidate.id,
      provider,
      quota: quotaFacts(candidate),
      requirements: defaultRequirements(input.config),
      routeId: candidate.id,
    },
  };
};

const declaredDraft = (context: RouteContext): RouteDraft => {
  const { candidate, input, now } = context;
  const provider = providerOf(candidate.harness);
  const blockers: DelegationRouteBlocker[] = [];
  const exclusions: string[] = [];
  const block = (blocker: DelegationRouteBlocker, exclusion: string): void => {
    if (!blockers.includes(blocker)) {
      blockers.push(blocker);
    }
    exclusions.push(exclusion);
  };
  const identityState = candidate.identity?.state;
  for (const reason of context.evaluation?.exclusionReasons ?? []) {
    block(blockerForExclusion(reason, identityState), reason);
  }
  if (context.evaluation === undefined) {
    block('other', 'The route was not evaluated.');
  }
  const unsettled = unsettledReviewFacts(candidate);
  if (unsettled.length > 0) {
    block('unsettled-fact', `Missing or stale: ${unsettled.join(', ')}.`);
  }
  const policy = evaluateRoutePolicy({
    annotation: context.annotation,
    applied: context.applied,
    defaults: input.config.defaults,
    route: {
      accountScope: candidate.accountScope,
      context: context.annotation?.context ?? null,
      harness: candidate.harness,
      provider,
    },
    rules: input.config.rules,
  });
  for (const [index, blocker] of policy.blockers.entries()) {
    block(blocker, policy.exclusions[index] ?? blocker);
  }
  const { requirements } = policy;
  if (requirements.identityEvidence === 'observed' && identityState !== 'confirmed') {
    block(
      'identity-evidence',
      `Policy requires an observed account identity; this route's identity is ${identityState ?? 'not assessed'}.`,
    );
  }
  if (identityState === 'contradicted' && !blockers.includes('identity-changed')) {
    block('identity-changed', 'The signed-in account contradicts the pinned declaration.');
  }
  const windows = applicableWindows(candidate);
  for (const window of windows) {
    const remaining = remainingOf(window);
    if (remaining !== null && remaining < requirements.reservePercent) {
      block(
        'reserve',
        `Quota window ${window.label}: ${remaining}% remaining is below the ${requirements.reservePercent}% reserve.`,
      );
    }
  }
  const quotaAt = timestamp(candidate.quota?.generatedAt);
  const changeAt = timestamp(context.accountChangeAt);
  if (quotaAt !== null && changeAt !== null && quotaAt < changeAt) {
    block(
      'quota-before-account-change',
      `Quota observed ${candidate.quota?.generatedAt} predates the account change observed ${context.accountChangeAt}; a new quota observation is required.`,
    );
  }
  const poolId = candidate.resourceId ?? candidate.id;
  const liveJobsInPool = input.reservations.liveJobsByPool.get(poolId) ?? 0;
  if (liveJobsInPool >= requirements.maxConcurrent) {
    block(
      'pool-busy',
      `Pool ${poolId} runs ${liveJobsInPool} reserving job(s); the limit is ${requirements.maxConcurrent}.`,
    );
  }
  if (input.request.retryOf !== undefined && input.reservations.attemptsInChain >= requirements.maxAttempts) {
    block(
      'attempts-exhausted',
      `The retry chain of ${input.request.retryOf} already counts ${input.reservations.attemptsInChain} attempt(s); the limit is ${requirements.maxAttempts}.`,
    );
  }
  const admissible = (context.evaluation?.eligible ?? false) && blockers.length === 0;

  const advantages: string[] = [];
  const limits: string[] = [];
  const entry = catalogEntry(input.config.models, provider, candidate.model);
  if (entry !== null) {
    if (entry.recommendedFor.includes(input.request.taskCategory)) {
      advantages.push(catalogSentence(entry, 'recommended for', input.request.taskCategory));
    }
    if (entry.discouragedFor.includes(input.request.taskCategory)) {
      limits.push(catalogSentence(entry, 'discouraged for', input.request.taskCategory));
    }
  }
  if (identityState === 'confirmed') {
    advantages.push(
      `Account identity confirmed by the current observation (${candidate.identity?.observedAt ?? 'unknown time'})`,
    );
  }
  const resets = futureResets(candidate, now);
  const horizon = input.config.preferences.nearResetMinutes;
  if (horizon !== null) {
    const limit = now + horizon * 60_000;
    for (const window of windows) {
      const reset = timestamp(window.resetsAt);
      if (reset !== null && reset > now && reset <= limit) {
        advantages.push(`observed reset of ${window.label} at ${window.resetsAt}; preference`);
      }
    }
  }
  if (context.sharedPoolSize > 1) {
    limits.push(
      `Shares pool ${poolId} with ${context.sharedPoolSize - 1} other model route(s): models of one account share one quota resource`,
    );
  }
  const controls = input.harnessControls[candidate.harness];
  advantages.push(...controls.controls.map((control) => `Read-only control: ${control}`));
  limits.push(...controls.limits);
  if (identityState === 'not-observable') {
    limits.push('Account identity not observable for this harness; bound by the declaration only');
  }

  const expiries: number[] = [];
  const freshness: QualificationFreshness = { ...DEFAULT_QUALIFICATION_FRESHNESS, ...input.freshness };
  const observedAt = timestamp(context.observation?.observedAt);
  if (observedAt !== null) {
    expiries.push(observedAt + freshness.executorMs);
  }
  if (quotaAt !== null) {
    expiries.push(quotaAt + freshness.quotaMs);
  }
  if (resets[0] !== undefined) {
    expiries.push(resets[0]);
  }
  return {
    expiries,
    harnessRank: rank(input.config.preferences.harnesses, candidate.harness),
    modelRank: rank(input.config.preferences.models, candidate.model),
    nearestReset: nearestResetWithin(resets, now, horizon),
    route: {
      accountScope: candidate.accountScope,
      admissible,
      advantages: boundedList(advantages),
      blockers,
      context: context.annotation?.context ?? null,
      effort: candidate.effort === null ? null : boundedText(candidate.effort),
      exclusions: boundedList(exclusions),
      harness: candidate.harness,
      identity: identityOf(candidate),
      label: boundedText(
        context.annotation?.label ??
          `${candidate.harness} · ${candidate.accountScope ?? 'unknown account'} · ${candidate.model ?? 'default model'}`,
      ),
      limits: boundedList(limits),
      liveJobsInPool,
      missing: boundedList([...unsettled, ...(context.evaluation?.missingData ?? [])]),
      model: candidate.model === null ? null : boundedText(candidate.model),
      orderHint: null,
      poolId,
      provider,
      quota: quotaFacts(candidate),
      requirements,
      routeId: candidate.id,
    },
  };
};

// ---------------------------------------------------------------------------------------------
// The qualification
// ---------------------------------------------------------------------------------------------

const refusedQualification = (
  input: QualifyDelegationInput,
  reason: DelegationRefusalReason,
  message: string,
  resolved: { readonly checkout: ResolvedDelegationCheckout | null; readonly scope: FrozenDelegationScope | null },
): DelegationQualification => ({
  admissibleRouteIds: [],
  appliedRules: [],
  assumptions: [],
  checkout: resolved.checkout,
  checkoutFacts: resolved.checkout === null ? null : input.checkoutFacts,
  omittedRoutes: 0,
  outcome: 'refused',
  purpose: input.purpose,
  qualificationId: input.qualificationId,
  qualifiedAt: input.now,
  refusal: { message: boundedText(message), reason },
  request: { action: input.request.action, digest: input.requestDigest, taskCategory: input.request.taskCategory },
  routes: [],
  schemaVersion: DELEGATION_SCHEMA_VERSION,
  scope: resolved.scope,
  validUntil: input.now,
  versions: {
    catalogRevision: input.versions.catalogRevision,
    policyRevision: input.versions.policyRevision,
    qualifier: DELEGATION_QUALIFIER_VERSION,
    selectorContract: DELEGATION_SELECTION_CONTRACT,
  },
});

const compareDrafts = (left: RouteDraft, right: RouteDraft): number => {
  if (left.modelRank !== right.modelRank) {
    return left.modelRank < right.modelRank ? -1 : 1;
  }
  if (left.harnessRank !== right.harnessRank) {
    return left.harnessRank < right.harnessRank ? -1 : 1;
  }
  if (left.nearestReset !== right.nearestReset) {
    return left.nearestReset < right.nearestReset ? -1 : 1;
  }
  return compareText(left.route.routeId, right.route.routeId);
};

const latestObservationsByExecutor = (
  observations: readonly ExecutorObservation[],
): Map<string, { readonly all: ExecutorObservation[]; readonly latest: ExecutorObservation }> => {
  const byExecutor = new Map<string, { all: ExecutorObservation[]; latest: ExecutorObservation }>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.machineId, observation.harness]);
    const current = byExecutor.get(key);
    if (current === undefined) {
      byExecutor.set(key, { all: [observation], latest: observation });
      continue;
    }
    current.all.push(observation);
    if (compareText(observation.observedAt, current.latest.observedAt) > 0) {
      current.latest = observation;
    }
  }
  return byExecutor;
};

/**
 * Qualifies one request: refuses when the checkout, its admission, the scope or the target's
 * reservation forbid any route; otherwise lists every route of this machine with the review
 * constraints (`evaluateReviewCandidates`) and the delegation constraints applied, bounded, ordered
 * deterministically, and dated by the earliest fact that expires.
 */
export const qualifyDelegation = (input: QualifyDelegationInput): DelegationQualification => {
  const now = timestamp(input.now);
  if (now === null) {
    throw new RangeError('Qualification requires a canonical ISO reference time');
  }
  if ('failure' in input.checkout) {
    return refusedQualification(input, input.checkout.failure, input.checkout.message, { checkout: null, scope: null });
  }
  const checkout = input.checkout;
  const scope = 'failure' in input.scope ? null : input.scope;
  if (checkout.admittedBy === null) {
    return refusedQualification(
      input,
      'checkout-not-admitted',
      `Checkout ${checkout.path} is not admitted by routing.reviewTargets[]: add { checkoutPath: '${checkout.path}' } (or an ancestor) to routing.reviewTargets in the home config.`,
      { checkout, scope },
    );
  }
  if (normalizeCheckoutPath(checkout.path) !== checkout.path) {
    return refusedQualification(
      input,
      'checkout-unavailable',
      'The resolved checkout path is not canonical (absolute, without . or .. segments, duplicate or trailing slashes).',
      { checkout: null, scope },
    );
  }
  if ('failure' in input.scope) {
    return refusedQualification(input, input.scope.failure, input.scope.message, { checkout, scope: null });
  }
  if (input.reservations.targetReservedBy !== null) {
    return refusedQualification(
      input,
      'target-reserved',
      `Job ${input.reservations.targetReservedBy} already reserves this review (same action, checkout and frozen scope); follow it with delegation status instead of starting another.`,
      { checkout, scope },
    );
  }

  const target: CheckoutRoutingTarget = {
    checkoutPath: checkout.path,
    kind: 'checkout',
    machineId: input.machineId,
    projectLabel: checkout.projectLabel,
  };
  const allCandidates = qualifyReviewCandidates({
    declarations: input.declarations,
    executorObservations: input.executorObservations,
    ...(input.freshness === undefined ? {} : { freshness: input.freshness }),
    now: input.now,
    providers: input.providers,
    target,
  }).filter((candidate) => candidate.machineId === input.machineId && isDelegationHarness(candidate.harness));
  const candidates = allCandidates.slice(0, MAX_REVIEW_ROUTING_CANDIDATES);
  let omittedRoutes = allCandidates.length - candidates.length;
  const evaluations = new Map(
    evaluateReviewCandidates({
      candidates,
      policy: QUALIFICATION_POLICY,
      referenceTime: input.now,
      request: {
        action: 'read-only-review',
        minimumQuality: 'review-capable',
        requiredCapabilities: ['read-only-review'],
        target,
      },
    }).map((evaluation) => [evaluation.candidateId, evaluation] as const),
  );
  const rules = evaluateDelegationRules({
    checkoutPath: checkout.path,
    facts: input.checkoutFacts,
    rules: input.config.rules,
  });
  const observations = latestObservationsByExecutor(input.executorObservations);
  const persistedChanges = new Map(
    (input.accountChanges ?? []).map((change) => [
      JSON.stringify([change.machineId, change.harness]),
      change.changedAt,
    ]),
  );
  const poolSizes = new Map<string, number>();
  for (const candidate of candidates) {
    const poolId = candidate.resourceId ?? candidate.id;
    poolSizes.set(poolId, (poolSizes.get(poolId) ?? 0) + 1);
  }
  const drafts = candidates.map((candidate) => {
    const executorKey = JSON.stringify([candidate.machineId, candidate.harness]);
    const executor = observations.get(executorKey);
    const context: RouteContext = {
      accountChangeAt: laterInstant(
        executor === undefined ? null : observedAccountChangeAt(executor.all),
        persistedChanges.get(executorKey) ?? null,
      ),
      annotation: annotationFor(input.config, candidate, input.machineId),
      applied: rules.applied,
      candidate,
      evaluation: evaluations.get(candidate.id),
      input,
      now,
      observation: executor?.latest,
      sharedPoolSize: poolSizes.get(candidate.resourceId ?? candidate.id) ?? 1,
    };
    return candidate.provenance.authorization === 'declared' ? declaredDraft(context) : observedOnlyDraft(context);
  });
  const admissibleDrafts = drafts.filter((draft) => draft.route.admissible).sort(compareDrafts);
  const orderHints = new Map(admissibleDrafts.map((draft, index) => [draft.route.routeId, index] as const));
  let routes = drafts
    .map((draft) => ({ ...draft.route, orderHint: orderHints.get(draft.route.routeId) ?? null }))
    .sort((left, right) => {
      if ((left.orderHint === null) !== (right.orderHint === null)) {
        return left.orderHint === null ? 1 : -1;
      }
      if (left.orderHint !== null && right.orderHint !== null && left.orderHint !== right.orderHint) {
        return left.orderHint - right.orderHint;
      }
      return compareText(left.routeId, right.routeId);
    });

  const ttlExpiry = now + input.config.defaults.qualificationTtlSeconds * 1000;
  const validUntil = new Date(
    Math.min(ttlExpiry, ...admissibleDrafts.flatMap((draft) => draft.expiries)),
  ).toISOString();
  const assumptions = [...rules.assumptions, ...(admissibleDrafts.length > 0 ? [ORDER_HINT_ASSUMPTION] : [])]
    .slice(0, DELEGATION_QUALIFICATION_BOUNDS.maxAssumptions)
    .map(boundedText);

  const make = (): DelegationQualification => {
    const admissibleRouteIds = routes.filter((route) => route.admissible).map((route) => route.routeId);
    return {
      admissibleRouteIds,
      appliedRules: rules.applied.slice(0, DELEGATION_QUALIFICATION_BOUNDS.maxAppliedRules).map((rule) => ({
        ...rule,
        reason: boundedText(rule.reason),
      })),
      assumptions,
      checkout,
      checkoutFacts: input.checkoutFacts,
      omittedRoutes,
      outcome: admissibleRouteIds.length > 0 ? 'routes-available' : 'no-admissible-route',
      purpose: input.purpose,
      qualificationId: input.qualificationId,
      qualifiedAt: input.now,
      refusal: null,
      request: { action: input.request.action, digest: input.requestDigest, taskCategory: input.request.taskCategory },
      routes,
      schemaVersion: DELEGATION_SCHEMA_VERSION,
      scope,
      validUntil,
      versions: {
        catalogRevision: input.versions.catalogRevision,
        policyRevision: input.versions.policyRevision,
        qualifier: DELEGATION_QUALIFIER_VERSION,
        selectorContract: DELEGATION_SELECTION_CONTRACT,
      },
    };
  };
  // Non-admissible routes go first (the last by id), then the admissible route with the highest
  // orderHint; every drop is counted. The routes are already ordered admissible-first, by orderHint.
  const dropOne = (): boolean => {
    if (routes.length === 0) {
      return false;
    }
    routes = routes.slice(0, -1);
    omittedRoutes++;
    return true;
  };
  while (routes.length > DELEGATION_QUALIFICATION_BOUNDS.maxRoutes && dropOne()) {
    // bounded by the route count
  }
  let qualification = make();
  while (serializedQualificationBytes(qualification) > DELEGATION_QUALIFICATION_BOUNDS.maxBytes && dropOne()) {
    qualification = make();
  }
  return qualification;
};

// ---------------------------------------------------------------------------------------------
// Strict re-validation for storage and transport
// ---------------------------------------------------------------------------------------------

const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isOneOf = <const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] =>
  typeof value === 'string' && (values as readonly string[]).includes(value);
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= DELEGATION_QUALIFICATION_BOUNDS.maxText;
const isTextList = (value: unknown, maximum: number = DELEGATION_QUALIFICATION_BOUNDS.maxEntries): value is string[] =>
  Array.isArray(value) && value.length <= maximum && value.every(isText);
const isNullableText = (value: unknown): value is string | null => value === null || isText(value);
const isNullableInstant = (value: unknown): value is string | null => value === null || isCanonicalInstant(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isPercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const isId = (value: unknown): value is string => typeof value === 'string' && isRoutingId(value);
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{16}$/u;
const FACT_PROVENANCES = ['declared', 'observed', 'unknown'] as const;
const SCOPE_BASES = ['empty-tree', 'first-parent', 'range-base'] as const;
const WINDOW_SCOPES = ['account', 'model', 'unknown'] as const;

const parseFact = <Value>(
  value: unknown,
  isValue: (member: unknown) => member is Value,
): DelegationFact<Value> | null => {
  if (!(isRecord(value) && hasExactly(value, ['provenance', 'source', 'value']))) {
    return null;
  }
  const { provenance, source, value: member } = value;
  return isOneOf(FACT_PROVENANCES, provenance) && isText(source) && (member === null || isValue(member))
    ? { provenance, source, value: member }
    : null;
};

const isTextArray = (value: unknown): value is readonly string[] => isTextList(value, 64);

const parseFacts = (value: unknown): DelegationCheckoutFacts | null => {
  if (!(isRecord(value) && hasExactly(value, ['gitAuthorEmail', 'githubAccount', 'githubOwners', 'repositories']))) {
    return null;
  }
  const gitAuthorEmail = parseFact(value.gitAuthorEmail, isText);
  const githubAccount = parseFact(value.githubAccount, isText);
  const githubOwners = parseFact(value.githubOwners, isTextArray);
  const repositories = parseFact(value.repositories, isTextArray);
  return gitAuthorEmail && githubAccount && githubOwners && repositories
    ? { gitAuthorEmail, githubAccount, githubOwners, repositories }
    : null;
};

const parseCheckout = (value: unknown): ResolvedDelegationCheckout | null => {
  if (!(isRecord(value) && hasExactly(value, ['admittedBy', 'path', 'projectLabel']))) {
    return null;
  }
  const { admittedBy, path, projectLabel } = value;
  return (admittedBy === null || isText(admittedBy)) &&
    typeof path === 'string' &&
    normalizeCheckoutPath(path) === path &&
    isText(projectLabel)
    ? { admittedBy, path, projectLabel }
    : null;
};

const parseScope = (value: unknown): FrozenDelegationScope | null => {
  if (
    !(isRecord(value) && hasExactly(value, ['base', 'baseRef', 'baseSha', 'commitCount', 'headRef', 'headSha', 'kind']))
  ) {
    return null;
  }
  const { base, baseRef, baseSha, commitCount, headRef, headSha, kind } = value;
  return isOneOf(SCOPE_BASES, base) &&
    isNullableText(baseRef) &&
    typeof baseSha === 'string' &&
    SHA_PATTERN.test(baseSha) &&
    isCount(commitCount) &&
    isText(headRef) &&
    typeof headSha === 'string' &&
    SHA_PATTERN.test(headSha) &&
    isOneOf(DELEGATION_SCOPE_KINDS, kind)
    ? { base, baseRef, baseSha, commitCount, headRef, headSha, kind }
    : null;
};

const parseAppliedRule = (value: unknown): DelegationAppliedRule | null => {
  if (!(isRecord(value) && hasExactly(value, ['applies', 'effect', 'id', 'reason']))) {
    return null;
  }
  const { applies, effect, id, reason } = value;
  return (applies === 'assumed' || applies === 'yes') &&
    isOneOf(DELEGATION_RULE_EFFECTS, effect) &&
    isText(id) &&
    isText(reason)
    ? { applies, effect, id, reason }
    : null;
};

const parseQuotaFact = (value: unknown): DelegationQuotaWindowFact | null => {
  if (!(isRecord(value) && hasExactly(value, ['label', 'observedAt', 'remainingPercent', 'resetsAt', 'scope']))) {
    return null;
  }
  const { label, observedAt, remainingPercent, resetsAt, scope } = value;
  return isText(label) &&
    isNullableInstant(observedAt) &&
    (remainingPercent === null || isPercent(remainingPercent)) &&
    isNullableInstant(resetsAt) &&
    isOneOf(WINDOW_SCOPES, scope)
    ? { label, observedAt, remainingPercent, resetsAt, scope }
    : null;
};

const parseRequirements = (value: unknown): DelegationRouteRequirements | null => {
  if (!(isRecord(value) && hasExactly(value, ['identityEvidence', 'maxAttempts', 'maxConcurrent', 'reservePercent']))) {
    return null;
  }
  const { identityEvidence, maxAttempts, maxConcurrent, reservePercent } = value;
  return isOneOf(DELEGATION_IDENTITY_EVIDENCE, identityEvidence) &&
    isCount(maxAttempts) &&
    maxAttempts >= 1 &&
    isCount(maxConcurrent) &&
    maxConcurrent >= 1 &&
    isPercent(reservePercent)
    ? { identityEvidence, maxAttempts, maxConcurrent, reservePercent }
    : null;
};

const parseIdentity = (value: unknown): DelegationRoute['identity'] | undefined => {
  if (value === null) {
    return null;
  }
  if (!(isRecord(value) && hasExactly(value, ['declared', 'observed', 'state']))) {
    return;
  }
  const { declared, observed, state } = value;
  return (declared === null || isExecutorAccountFingerprint(declared)) &&
    (observed === null || isExecutorAccountFingerprint(observed)) &&
    isOneOf(CANDIDATE_IDENTITY_STATES, state)
    ? { declared, observed, state }
    : undefined;
};

const ROUTE_KEYS = [
  'accountScope',
  'admissible',
  'advantages',
  'blockers',
  'context',
  'effort',
  'exclusions',
  'harness',
  'identity',
  'label',
  'limits',
  'liveJobsInPool',
  'missing',
  'model',
  'orderHint',
  'poolId',
  'provider',
  'quota',
  'requirements',
  'routeId',
] as const;

const parseRoute = (value: unknown): DelegationRoute | null => {
  if (!(isRecord(value) && hasExactly(value, ROUTE_KEYS))) {
    return null;
  }
  const identity = parseIdentity(value.identity);
  const requirements = parseRequirements(value.requirements);
  if (
    !(
      (value.accountScope === null || isId(value.accountScope)) &&
      typeof value.admissible === 'boolean' &&
      isTextList(value.advantages) &&
      Array.isArray(value.blockers) &&
      value.blockers.length <= DELEGATION_ROUTE_BLOCKERS.length &&
      value.blockers.every((blocker) => isOneOf(DELEGATION_ROUTE_BLOCKERS, blocker)) &&
      value.admissible === (value.blockers.length === 0) &&
      (value.context === null || isOneOf(DELEGATION_CONTEXTS, value.context)) &&
      isNullableText(value.effort) &&
      isTextList(value.exclusions) &&
      isOneOf(DELEGATION_EXECUTOR_HARNESSES, value.harness) &&
      identity !== undefined &&
      isText(value.label) &&
      isTextList(value.limits) &&
      isCount(value.liveJobsInPool) &&
      isTextList(value.missing) &&
      isNullableText(value.model) &&
      (value.orderHint === null || isCount(value.orderHint)) &&
      (value.admissible || value.orderHint === null) &&
      isId(value.poolId) &&
      isOneOf(DELEGATION_PROVIDERS, value.provider) &&
      Array.isArray(value.quota) &&
      value.quota.length <= DELEGATION_QUALIFICATION_BOUNDS.maxEntries &&
      requirements !== null &&
      isId(value.routeId)
    )
  ) {
    return null;
  }
  const quota: DelegationQuotaWindowFact[] = [];
  for (const entry of value.quota) {
    const fact = parseQuotaFact(entry);
    if (fact === null) {
      return null;
    }
    quota.push(fact);
  }
  const blockers: DelegationRouteBlocker[] = [];
  for (const blocker of value.blockers) {
    if (!isOneOf(DELEGATION_ROUTE_BLOCKERS, blocker)) {
      return null;
    }
    blockers.push(blocker);
  }
  return {
    accountScope: value.accountScope,
    admissible: value.admissible,
    advantages: value.advantages,
    blockers,
    context: value.context,
    effort: value.effort,
    exclusions: value.exclusions,
    harness: value.harness,
    identity,
    label: value.label,
    limits: value.limits,
    liveJobsInPool: value.liveJobsInPool,
    missing: value.missing,
    model: value.model,
    orderHint: value.orderHint,
    poolId: value.poolId,
    provider: value.provider,
    quota,
    requirements,
    routeId: value.routeId,
  };
};

const QUALIFICATION_KEYS = [
  'admissibleRouteIds',
  'appliedRules',
  'assumptions',
  'checkout',
  'checkoutFacts',
  'omittedRoutes',
  'outcome',
  'purpose',
  'qualificationId',
  'qualifiedAt',
  'refusal',
  'request',
  'routes',
  'schemaVersion',
  'scope',
  'validUntil',
  'versions',
] as const;

const parseRefusal = (value: unknown): DelegationQualification['refusal'] | undefined => {
  if (value === null) {
    return null;
  }
  if (!(isRecord(value) && hasExactly(value, ['message', 'reason']))) {
    return;
  }
  const { message, reason } = value;
  return isText(message) && isOneOf(DELEGATION_REFUSAL_REASONS, reason) ? { message, reason } : undefined;
};

const parseRequestSummary = (value: unknown): DelegationQualification['request'] | null => {
  if (!(isRecord(value) && hasExactly(value, ['action', 'digest', 'taskCategory']))) {
    return null;
  }
  const { action, digest, taskCategory } = value;
  return isText(action) && typeof digest === 'string' && DIGEST_PATTERN.test(digest) && isText(taskCategory)
    ? { action, digest, taskCategory }
    : null;
};

const parseVersions = (value: unknown): DelegationQualification['versions'] | null => {
  if (!(isRecord(value) && hasExactly(value, ['catalogRevision', 'policyRevision', 'qualifier', 'selectorContract']))) {
    return null;
  }
  const { catalogRevision, policyRevision, qualifier, selectorContract } = value;
  return typeof catalogRevision === 'string' &&
    REVISION_PATTERN.test(catalogRevision) &&
    typeof policyRevision === 'string' &&
    REVISION_PATTERN.test(policyRevision) &&
    isText(qualifier) &&
    isText(selectorContract)
    ? { catalogRevision, policyRevision, qualifier, selectorContract }
    : null;
};

const parseList = <Entry>(value: unknown, maximum: number, parse: (entry: unknown) => Entry | null): Entry[] | null => {
  if (!(Array.isArray(value) && value.length <= maximum)) {
    return null;
  }
  const entries: Entry[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (parsed === null) {
      return null;
    }
    entries.push(parsed);
  }
  return entries;
};

/**
 * Strict re-validation of a qualification read from storage or a process boundary; `null` when
 * any field does not conform, including the invariants a forged copy would break (admissible ids
 * equal to the admissible routes, a refusal exactly when the outcome is refused, size).
 */
export const parseDelegationQualification = (value: unknown): DelegationQualification | null => {
  if (
    !(
      isRecord(value) &&
      hasExactly(value, QUALIFICATION_KEYS) &&
      serializedQualificationBytes(value) <= DELEGATION_QUALIFICATION_BOUNDS.maxBytes
    )
  ) {
    return null;
  }
  const refusal = parseRefusal(value.refusal);
  const request = parseRequestSummary(value.request);
  const versions = parseVersions(value.versions);
  const appliedRules = parseList(value.appliedRules, DELEGATION_QUALIFICATION_BOUNDS.maxAppliedRules, parseAppliedRule);
  const routes = parseList(value.routes, DELEGATION_QUALIFICATION_BOUNDS.maxRoutes, parseRoute);
  const checkout = value.checkout === null ? null : parseCheckout(value.checkout);
  const checkoutFacts = value.checkoutFacts === null ? null : parseFacts(value.checkoutFacts);
  const scope = value.scope === null ? null : parseScope(value.scope);
  if (
    !(
      isTextList(value.admissibleRouteIds, DELEGATION_QUALIFICATION_BOUNDS.maxRoutes) &&
      appliedRules !== null &&
      isTextList(value.assumptions, DELEGATION_QUALIFICATION_BOUNDS.maxAssumptions) &&
      (value.checkout === null || checkout !== null) &&
      (value.checkoutFacts === null || checkoutFacts !== null) &&
      isCount(value.omittedRoutes) &&
      isOneOf(DELEGATION_QUALIFICATION_OUTCOMES, value.outcome) &&
      isOneOf(DELEGATION_QUALIFICATION_PURPOSES, value.purpose) &&
      isDelegationUuid(value.qualificationId) &&
      isCanonicalInstant(value.qualifiedAt) &&
      refusal !== undefined &&
      request !== null &&
      routes !== null &&
      value.schemaVersion === DELEGATION_SCHEMA_VERSION &&
      (value.scope === null || scope !== null) &&
      isCanonicalInstant(value.validUntil) &&
      versions !== null
    )
  ) {
    return null;
  }
  const admissible = routes.filter((route) => route.admissible).map((route) => route.routeId);
  const ids = value.admissibleRouteIds;
  if (
    ids.length !== admissible.length ||
    !admissible.every((id) => ids.includes(id)) ||
    (value.outcome === 'refused') !== (refusal !== null) ||
    (value.outcome === 'routes-available') !== (refusal === null && admissible.length > 0)
  ) {
    return null;
  }
  return {
    admissibleRouteIds: ids,
    appliedRules,
    assumptions: value.assumptions,
    checkout,
    checkoutFacts,
    omittedRoutes: value.omittedRoutes,
    outcome: value.outcome,
    purpose: value.purpose,
    qualificationId: value.qualificationId,
    qualifiedAt: value.qualifiedAt,
    refusal,
    request,
    routes,
    schemaVersion: DELEGATION_SCHEMA_VERSION,
    scope,
    validUntil: value.validUntil,
    versions,
  };
};

// ---------------------------------------------------------------------------------------------
// Launch decision
// ---------------------------------------------------------------------------------------------

export interface DecideDelegationLaunchInput {
  /** The qualification the selection cites, as stored; `null` when none is found. */
  readonly cited: DelegationQualification | null;
  /** A qualification of the same request computed now, from fresh facts. */
  readonly fresh: DelegationQualification;
  readonly now: string;
  readonly requestDigest: string;
  readonly selection: DelegationSelection;
}

export type DelegationLaunchDecision =
  | { readonly kind: 'abstained' }
  | { readonly kind: 'allowed'; readonly route: DelegationRoute }
  | { readonly kind: 'refused'; readonly message: string; readonly reason: DelegationRefusalReason };

/** Blocker families that have their own refusal reason when they are the only thing in the way. */
const TYPED_BLOCKERS = [
  'attempts-exhausted',
  'identity-changed',
  'pool-busy',
] as const satisfies readonly (DelegationRefusalReason & DelegationRouteBlocker)[];

const refuse = (reason: DelegationRefusalReason, message: string): DelegationLaunchDecision => ({
  kind: 'refused',
  message,
  reason,
});

/**
 * Whether a cited choice may start now, in a fixed order: the selector's abstention, the cited
 * qualification's existence, identity (purpose, request digest, id), expiry, the route's admission
 * then, the fresh qualification's refusal, the policy revision, the frozen scope, and the route's
 * admission now. A route the cited qualification never offered is refused whatever the fresh one
 * says: a forged id is not a choice.
 */
export const decideDelegationLaunch = (input: DecideDelegationLaunchInput): DelegationLaunchDecision => {
  const { cited, fresh, selection } = input;
  if (selection.kind === 'abstain') {
    return { kind: 'abstained' };
  }
  if (cited === null) {
    return refuse(
      'qualification-unknown',
      `No qualification ${selection.qualificationId} is known on this machine; qualify first.`,
    );
  }
  if (
    cited.purpose !== 'delegation' ||
    cited.request.digest !== input.requestDigest ||
    cited.qualificationId !== selection.qualificationId
  ) {
    return refuse(
      'qualification-mismatch',
      cited.purpose === 'delegation'
        ? 'The cited qualification was made for another request or is not the one the selection names.'
        : 'The cited qualification was a simulation; a launch needs a qualification made for delegation.',
    );
  }
  if (compareText(input.now, cited.validUntil) > 0) {
    return refuse('qualification-expired', `The cited qualification expired at ${cited.validUntil}; qualify again.`);
  }
  if (!cited.admissibleRouteIds.includes(selection.routeId)) {
    return refuse('route-not-admissible', `Route ${selection.routeId} was not offered by the cited qualification.`);
  }
  if (fresh.outcome === 'refused' && fresh.refusal !== null) {
    return refuse(fresh.refusal.reason, fresh.refusal.message);
  }
  if (fresh.versions.policyRevision !== cited.versions.policyRevision) {
    return refuse(
      'policy-changed',
      'The routing or delegation configuration changed since the qualification; qualify again.',
    );
  }
  if (
    fresh.scope === null ||
    cited.scope === null ||
    fresh.scope.baseSha !== cited.scope.baseSha ||
    fresh.scope.headSha !== cited.scope.headSha
  ) {
    return refuse(
      'scope-changed',
      'The revisions no longer resolve to the frozen scope of the qualification; qualify again.',
    );
  }
  const route = fresh.routes.find((entry) => entry.routeId === selection.routeId);
  if (route === undefined) {
    return refuse('route-not-admissible', `Route ${selection.routeId} is no longer listed for this request.`);
  }
  if (!route.admissible) {
    const [only] = route.blockers;
    if (route.blockers.length === 1 && isOneOf(TYPED_BLOCKERS, only)) {
      return refuse(only, route.exclusions.join(' '));
    }
    return refuse(
      'route-not-admissible',
      `Route ${selection.routeId} is no longer admissible: ${route.exclusions.join(' ')}`,
    );
  }
  return { kind: 'allowed', route };
};
