import { isCanonicalInstant } from './canonical-instant';
import {
  LIVE_PROVIDER_STATUS_MAX_AGE_MS,
  type ProviderLimitWindow,
  type ProviderStatus,
  parseProviderStatusDataset,
  providerStatusWithFeedFreshness,
} from './provider-status';
import {
  EXECUTOR_CAPABILITIES_CADENCE_MS,
  type ExecutorDeclaration,
  type ExecutorDeclaredTarget,
  type ExecutorHarness,
  type ExecutorObservation,
  executorAuthMethodIndicatesApiKey,
  executorDeclarationKey,
  executorHarnessFamily,
} from './work-executors';

export interface ReviewTarget {
  readonly harness: string;
  readonly kind: 'session';
  readonly machineId: string;
  /** The project the session is shown under; lets a declared `project` target admit it. Not part of identity. */
  readonly projectLabel?: string | null;
  readonly sourceSessionId: string;
}

export interface ReviewRequest {
  readonly action: 'read-only-review';
  readonly minimumQuality: 'review-capable';
  readonly requiredCapabilities: readonly 'read-only-review'[];
  readonly target: ReviewTarget;
}

/** Where each qualification field came from. A declaration is dated; an observation is fresh or stale. */
export type CandidateProvenance = 'observed-now' | 'declared' | 'unknown' | 'stale';

export const CANDIDATE_PROVENANCE_FIELDS = [
  'accountScope',
  'authorization',
  'subscription',
  'availability',
  'capabilities',
  'quality',
  'quota',
  'model',
  'effort',
] as const;
export type CandidateProvenanceField = (typeof CANDIDATE_PROVENANCE_FIELDS)[number];
export type CandidateProvenanceMap = Readonly<Record<CandidateProvenanceField, CandidateProvenance>>;

export interface ReviewCandidate {
  readonly accountScope: string | null;
  readonly authorization: 'allowed' | 'forbidden' | 'unknown';
  readonly authorizedTarget: ReviewTarget | null;
  readonly availability: 'available' | 'unavailable' | 'unknown';
  readonly capabilities: readonly 'read-only-review'[];
  readonly effort: string | null;
  readonly evidence: { readonly source: string; readonly observedAt: string | null };
  readonly harness: 'claude-code' | 'codex';
  readonly id: string;
  readonly machineId: string | null;
  readonly machineLabel: string | null;
  readonly model: string | null;
  readonly provenance: CandidateProvenanceMap;
  /** Precise, realizable steps that would supply the data this candidate lacks. Empty when nothing is missing. */
  readonly qualificationActions: readonly string[];
  readonly quality: 'review-capable' | 'unknown';
  readonly quota: ProviderStatus | null;
  readonly subscription: 'verified' | 'unverified' | 'api';
}

export interface ReviewRoutingPolicy {
  readonly forcedCandidateId: string | null;
  readonly nearResetMinutes: number;
  readonly preferNearReset: boolean;
  readonly preferredHarness: 'claude-code' | 'codex' | null;
}

export interface ReviewRoutingInput {
  readonly candidates: readonly ReviewCandidate[];
  readonly policy: ReviewRoutingPolicy;
  readonly referenceTime: string;
  readonly request: ReviewRequest;
}

export interface ReviewCandidateEvaluation {
  readonly candidateId: string;
  readonly eligible: boolean;
  readonly exclusionReasons: readonly string[];
  readonly missingData: readonly string[];
}

export interface ReviewRoutingResult {
  readonly chosenCandidateId: string | null;
  readonly evaluations: readonly ReviewCandidateEvaluation[];
  readonly reasons: readonly string[];
  readonly referenceTime: string;
}

export interface QualificationFreshness {
  /** An executor observation older than this is `stale`; defaults to twice the source cadence. */
  readonly executorMs: number;
  /** A quota observation older than this is `stale`; defaults to the quota feed's own rule (15 minutes). */
  readonly quotaMs: number;
}

export const DEFAULT_QUALIFICATION_FRESHNESS: QualificationFreshness = {
  executorMs: 2 * EXECUTOR_CAPABILITIES_CADENCE_MS,
  quotaMs: LIVE_PROVIDER_STATUS_MAX_AGE_MS,
};

export interface QualifyReviewCandidatesInput {
  readonly declarations: readonly ExecutorDeclaration[];
  readonly executorObservations: readonly ExecutorObservation[];
  readonly freshness?: Partial<QualificationFreshness>;
  readonly now: string;
  readonly providers: readonly ProviderStatus[];
  /** The session under review; `null` when none is selected, which leaves every authorization unbound. */
  readonly target: ReviewTarget | null;
}

export type RecommendationKind = 'real' | 'conditional' | 'none';

export interface ReviewRecommendation {
  readonly candidateId: string | null;
  readonly kind: RecommendationKind;
  /** For `conditional`: the one named observation whose absence or staleness blocks the candidate. */
  readonly missing: string | null;
}

export const MAX_REVIEW_ROUTING_CANDIDATES = 128;
const MAX_NEAR_RESET_MINUTES = 7 * 24 * 60;
const MAX_QUOTA_WINDOWS = 64;
const MAX_ID_LENGTH = 512;
const MODEL_WINDOW_ID_PREFIX = 'model:';
const QUOTA_REFRESH_ACTION = 'Refresh quota observations (ai-usage quota --json or wait for the 5-minute source)';
const EXECUTOR_REFRESH_ACTION =
  'Refresh executor observations: run executors.capabilities from /sources (15-minute cadence)';

const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};
const validId = (value: string | null): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;
const timestamp = (value: string | null): number | null => (isCanonicalInstant(value) ? Date.parse(value) : null);

const sameTarget = (left: ReviewTarget, right: ReviewTarget): boolean =>
  left.kind === right.kind &&
  left.machineId === right.machineId &&
  left.harness === right.harness &&
  left.sourceSessionId === right.sourceSessionId;

const providerScope = (provider: ProviderStatus) => {
  const colon = provider.key.indexOf(':');
  return {
    family: colon < 0 ? provider.key : provider.key.slice(0, colon),
    account: colon < 0 ? null : provider.key.slice(colon + 1) || null,
  };
};

const quotaIdentity = (quota: ProviderStatus): string => {
  const { family, account } = providerScope(quota);
  return JSON.stringify([quota.machineId ?? null, family, account]);
};

const harnessCommand = (harness: ExecutorHarness): string => (harness === 'claude-code' ? 'claude' : 'codex');
const harnessName = (harness: ExecutorHarness): string => (harness === 'claude-code' ? 'Claude Code' : 'Codex');

const windowModelNames = (window: ProviderLimitWindow): string[] =>
  [
    window.group,
    window.id.startsWith(MODEL_WINDOW_ID_PREFIX) ? window.id.slice(MODEL_WINDOW_ID_PREFIX.length) : window.id,
    window.id.split(':')[0] ?? window.id,
    window.label.split(' · ')[0] ?? window.label,
  ]
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim().toLowerCase());

/** Whether a model-scoped window names the candidate's declared model, as the provider spells it. */
const windowNamesModel = (window: ProviderLimitWindow, model: string): boolean =>
  windowModelNames(window).includes(model.trim().toLowerCase());

// ---------------------------------------------------------------------------------------------
// Qualification: merge declarations, executor observations and quota without inventing anything
// ---------------------------------------------------------------------------------------------

interface QuotaStream {
  readonly account: string | null;
  readonly family: string;
  readonly key: string;
  readonly machineId: string | null;
  readonly providers: readonly ProviderStatus[];
}

const quotaStreams = (providers: readonly ProviderStatus[]): QuotaStream[] => {
  const groups = new Map<string, ProviderStatus[]>();
  for (const provider of providers) {
    const { family } = providerScope(provider);
    if (family !== 'claude' && family !== 'codex') {
      continue;
    }
    const key = quotaIdentity(provider);
    const group = groups.get(key) ?? [];
    group.push(provider);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, group]) => {
      const provider = group[0];
      if (!provider) {
        throw new Error('Observed candidate group is empty');
      }
      const { family, account } = providerScope(provider);
      return { account, family, key, machineId: provider.machineId ?? null, providers: group };
    });
};

const latestExecutorObservations = (observations: readonly ExecutorObservation[]): Map<string, ExecutorObservation> => {
  const latest = new Map<string, ExecutorObservation>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.machineId, observation.harness]);
    const current = latest.get(key);
    if (!current || compareText(observation.observedAt, current.observedAt) > 0) {
      latest.set(key, observation);
    }
  }
  return latest;
};

const quotaProvenance = (quota: ProviderStatus, now: number, quotaMs: number): CandidateProvenance => {
  const observedAt = timestamp(quota.generatedAt);
  if (observedAt === null) {
    return 'unknown';
  }
  return quota.state === 'stale' || now - observedAt > quotaMs ? 'stale' : 'observed-now';
};

interface AvailabilityAssessment {
  readonly actions: readonly string[];
  readonly availability: ReviewCandidate['availability'];
  readonly provenance: CandidateProvenance;
}

const assessAvailability = (
  observation: ExecutorObservation | undefined,
  harness: ExecutorHarness,
  machineId: string,
  now: number,
  executorMs: number,
): AvailabilityAssessment => {
  if (!observation) {
    return {
      actions: [`${EXECUTOR_REFRESH_ACTION}: no observation of ${harnessCommand(harness)} on machine ${machineId}`],
      availability: 'unknown',
      provenance: 'unknown',
    };
  }
  const observedAt = timestamp(observation.observedAt);
  if (observedAt === null || now - observedAt > executorMs) {
    return {
      actions: [`${EXECUTOR_REFRESH_ACTION}; ${harnessCommand(harness)} was last observed ${observation.observedAt}`],
      availability: 'unknown',
      provenance: 'stale',
    };
  }
  if (observation.binaryPath === null || observation.outcome === 'unavailable') {
    return {
      actions: [`Install the ${harnessName(harness)} CLI (${harnessCommand(harness)}) on machine ${machineId}`],
      availability: 'unavailable',
      provenance: 'observed-now',
    };
  }
  if (observation.authState === 'logged-out') {
    return {
      actions: [
        harness === 'claude-code'
          ? 'Sign in the Claude Code CLI (claude auth login)'
          : 'Sign in the Codex CLI (codex login)',
      ],
      availability: 'unavailable',
      provenance: 'observed-now',
    };
  }
  if (observation.authState === 'logged-in') {
    return { actions: [], availability: 'available', provenance: 'observed-now' };
  }
  return {
    actions: [
      `Check \`${harnessCommand(harness)} ${harness === 'claude-code' ? 'auth status' : 'login status'}\` on machine ${machineId}: the collector could not read the sign-in state (${observation.authEvidence})`,
    ],
    availability: 'unknown',
    provenance: 'unknown',
  };
};

const targetAdmitted = (targets: readonly ExecutorDeclaredTarget[], target: ReviewTarget): boolean =>
  targets.some(
    (declared) =>
      declared.kind === 'any-local-session' ||
      (declared.kind === 'project' &&
        typeof target.projectLabel === 'string' &&
        declared.projectLabel === target.projectLabel),
  );

const quotaActions = (
  quota: ProviderStatus | null,
  provenance: CandidateProvenance,
  now: number,
  model: string | null,
): string[] => {
  if (quota === null) {
    return [QUOTA_REFRESH_ACTION];
  }
  const actions: string[] = [];
  if (provenance === 'stale') {
    actions.push(`${QUOTA_REFRESH_ACTION}; last observed ${quota.generatedAt}`);
  }
  for (const window of quota.windows) {
    // Another model's window is not this review's capacity; an undeclared model is handled by
    // `modelActions`, so neither yields a wait-for-reset action here.
    if (window.scope === 'model' && (model === null || !windowNamesModel(window, model))) {
      continue;
    }
    const reset = timestamp(window.resetsAt);
    if (reset !== null && reset <= now) {
      actions.push(`Quota window ${window.label} crossed its reset: a new observation is required`);
    } else if (window.blocked || (window.usedPercent !== null && window.usedPercent >= 100)) {
      actions.push(
        `Quota window ${window.label} is exhausted; wait for its reset${window.resetsAt ? ` at ${window.resetsAt}` : ''}`,
      );
    }
  }
  return actions;
};

const modelActions = (quota: ProviderStatus | null, model: string | null, scope: string): string[] => {
  if (quota === null || model !== null) {
    return [];
  }
  const modelWindows = quota.windows.filter((window) => window.scope === 'model').map((window) => window.id);
  return modelWindows.length === 0
    ? []
    : [
        `Declare routing.executors[].model for ${scope}: the quota reports model-scoped windows (${modelWindows.join(', ')}) that cannot be attributed without it`,
      ];
};

const declareAction = (family: string, account: string | null): string =>
  `Add routing.executors[] for ${family}:${account ?? '<accountScope>'} with authorization 'allowed', targets [{kind:'any-local-session'}], subscription 'verified', declaredAt`;

interface QuotaBinding {
  readonly actions: readonly string[];
  readonly stream: QuotaStream | null;
}

const bindQuotaStream = (
  declaration: ExecutorDeclaration,
  streams: readonly QuotaStream[],
  peerDeclarations: number,
): QuotaBinding => {
  const family = executorHarnessFamily(declaration.harness);
  const candidates = streams.filter((stream) => stream.machineId === declaration.machineId && stream.family === family);
  const exact = candidates.find((stream) => stream.account === declaration.accountScope);
  if (exact) {
    return { actions: [], stream: exact };
  }
  const bare = candidates.filter((stream) => stream.account === null);
  const scoped = candidates.filter((stream) => stream.account !== null);
  if (bare.length === 1 && scoped.length === 0 && peerDeclarations === 1) {
    // The stored key carries no account suffix (the live collectors record none), so the one
    // declaration for this family on this machine binds its single quota stream.
    return { actions: [], stream: bare[0] ?? null };
  }
  if (bare.length === 1 && peerDeclarations > 1) {
    return {
      actions: [
        `Quota attribution is ambiguous: ${peerDeclarations} routing.executors[] entries for ${family} on machine ${declaration.machineId} share one quota stream without an account suffix; keep one entry`,
      ],
      stream: null,
    };
  }
  if (scoped.length > 0) {
    return {
      actions: [
        `Quota streams for ${family} on machine ${declaration.machineId} are account-scoped (${scoped
          .map((stream) => stream.account)
          .join(', ')}); set routing.executors[].accountScope to one of them`,
      ],
      stream: null,
    };
  }
  return { actions: [], stream: null };
};

const streamQuota = (stream: QuotaStream | null): ProviderStatus | null =>
  stream !== null && stream.providers.length === 1 ? (stream.providers[0] ?? null) : null;

const declaredCandidate = (
  declaration: ExecutorDeclaration,
  binding: QuotaBinding,
  observation: ExecutorObservation | undefined,
  input: QualifyReviewCandidatesInput,
  freshness: QualificationFreshness,
): ReviewCandidate => {
  const now = Date.parse(input.now);
  const scope = `${executorHarnessFamily(declaration.harness)}:${declaration.accountScope}`;
  const quota = streamQuota(binding.stream);
  const quotaOrigin = quota === null ? 'unknown' : quotaProvenance(quota, now, freshness.quotaMs);
  const availability = assessAvailability(
    observation,
    declaration.harness,
    declaration.machineId,
    now,
    freshness.executorMs,
  );
  const target = input.target;
  const admitted = target !== null && targetAdmitted(declaration.targets, target);
  // A current sign-in through an API key contradicts a declared subscription: the CLI would bill
  // the API whatever the declaration says. Only a fresh observation can say so; a stale or absent
  // one leaves the declaration as written.
  const apiKeyObserved =
    observation !== undefined &&
    availability.provenance === 'observed-now' &&
    executorAuthMethodIndicatesApiKey(observation.authMethod);
  const subscription: ReviewCandidate['subscription'] =
    declaration.subscription === 'verified' && apiKeyObserved ? 'api' : declaration.subscription;
  const actions: string[] = [];
  if (target === null) {
    actions.push('Select a session with a machine and native identity to bind the authorization to a target');
  } else if (!admitted) {
    actions.push(
      `Declared targets do not admit this session (project '${target.projectLabel ?? 'unknown'}'): add {kind:'project', projectLabel:'${target.projectLabel ?? '<project>'}'} or {kind:'any-local-session'} to routing.executors[] for ${scope}`,
    );
  }
  if (declaration.subscription === 'api') {
    actions.push(
      `Declared subscription 'api' for ${scope} is outside the subscription-only policy; declare 'verified' only if the account is on a subscription`,
    );
  } else if (subscription === 'api' && observation !== undefined) {
    actions.push(
      `subscription: declared verified, but the CLI reports API-key authentication (authMethod ${observation.authMethod ?? 'unknown'} observed ${observation.observedAt}); sign ${harnessCommand(declaration.harness)} in with the subscription account or declare 'api'`,
    );
  }
  if (!declaration.capabilities.includes('read-only-review')) {
    actions.push(`Add 'read-only-review' to routing.executors[].capabilities for ${scope}`);
  }
  if (binding.stream !== null && quota === null) {
    actions.push(
      `Quota observations for ${scope} on machine ${declaration.machineId} are ambiguous (several stored readings for one scope); ${QUOTA_REFRESH_ACTION}`,
    );
  }
  actions.push(...binding.actions, ...availability.actions);
  if (quota !== null) {
    actions.push(...quotaActions(quota, quotaOrigin, now, declaration.model));
  } else if (binding.stream === null && binding.actions.length === 0) {
    // No stream for this family and machine at all; a binding problem already names its own fix.
    actions.push(QUOTA_REFRESH_ACTION);
  }
  actions.push(...modelActions(quota, declaration.model, scope));
  if (Date.parse(declaration.declaredAt) > now) {
    actions.push(`declaredAt ${declaration.declaredAt} for ${scope} is in the future; correct it`);
  }
  return {
    id: `declared:${executorDeclarationKey(declaration)}`,
    machineId: declaration.machineId,
    machineLabel: quota?.machineLabel ?? null,
    accountScope: declaration.accountScope,
    harness: declaration.harness,
    model: declaration.model,
    effort: declaration.effort,
    authorization: declaration.authorization,
    authorizedTarget: admitted ? target : null,
    subscription,
    availability: availability.availability,
    capabilities: declaration.capabilities,
    quality: declaration.quality,
    quota,
    provenance: {
      accountScope: 'declared',
      authorization: 'declared',
      subscription: subscription === declaration.subscription ? 'declared' : 'observed-now',
      availability: availability.provenance,
      capabilities: 'declared',
      quality: 'declared',
      quota: quotaOrigin,
      model: declaration.model === null ? 'unknown' : 'declared',
      effort: declaration.effort === null ? 'unknown' : 'declared',
    },
    qualificationActions: [...new Set(actions)],
    evidence: {
      source: `Declared in routing.executors[] (declaredAt ${declaration.declaredAt}); executor ${
        observation ? `observed ${observation.observedAt}` : 'not observed'
      }; quota ${quota ? `stored ${quota.source} observation ${quota.generatedAt}` : 'not observed'}`,
      observedAt: declaration.declaredAt,
    },
  };
};

const observedOnlyCandidate = (
  stream: QuotaStream,
  observation: ExecutorObservation | undefined,
  input: QualifyReviewCandidatesInput,
  freshness: QualificationFreshness,
): ReviewCandidate => {
  const now = Date.parse(input.now);
  const provider = stream.providers[0];
  if (!provider) {
    throw new Error('Observed candidate group is empty');
  }
  const harness: ExecutorHarness = stream.family === 'claude' ? 'claude-code' : 'codex';
  const ambiguous = stream.providers.length > 1;
  const quota = ambiguous ? null : provider;
  const availability =
    stream.machineId === null
      ? ({ actions: [], availability: 'unknown', provenance: 'unknown' } as const)
      : assessAvailability(observation, harness, stream.machineId, now, freshness.executorMs);
  const quotaOrigin = quota === null ? 'unknown' : quotaProvenance(quota, now, freshness.quotaMs);
  return {
    id: `observed:${stream.key}`,
    machineId: stream.machineId,
    machineLabel: ambiguous ? null : (provider.machineLabel ?? null),
    accountScope: stream.account,
    harness,
    model: null,
    effort: null,
    authorization: 'unknown',
    authorizedTarget: null,
    subscription: 'unverified',
    availability: availability.availability,
    capabilities: [],
    quality: 'unknown',
    quota,
    provenance: {
      accountScope: stream.account === null ? 'unknown' : 'observed-now',
      authorization: 'unknown',
      subscription: 'unknown',
      availability: availability.provenance,
      capabilities: 'unknown',
      quality: 'unknown',
      quota: quotaOrigin,
      model: 'unknown',
      effort: 'unknown',
    },
    qualificationActions: [
      ...new Set([
        declareAction(stream.family, stream.account),
        ...availability.actions,
        ...(ambiguous ? [`Ambiguous stored quota observations for this scope; ${QUOTA_REFRESH_ACTION}`] : []),
        ...quotaActions(quota, quotaOrigin, now, null).filter(() => !ambiguous),
      ]),
    ],
    evidence: {
      source: ambiguous ? 'Ambiguous stored quota observations for this scope' : `Stored ${provider.source} quota`,
      observedAt: ambiguous ? null : provider.generatedAt,
    },
  };
};

/**
 * One candidate per (machine, family, account) seen in quota and per declaration without a quota
 * stream. Authorization, subscription, capabilities and quality come only from a declaration;
 * availability only from an executor observation; quota only from provider status. Nothing is
 * inferred across those sources, and the output is deterministic for identical inputs.
 */
export const qualifyReviewCandidates = (input: QualifyReviewCandidatesInput): ReviewCandidate[] => {
  if (timestamp(input.now) === null) {
    throw new RangeError('Qualification requires a canonical ISO reference time');
  }
  const freshness: QualificationFreshness = { ...DEFAULT_QUALIFICATION_FRESHNESS, ...input.freshness };
  const streams = quotaStreams(input.providers);
  const observations = latestExecutorObservations(input.executorObservations);
  const declarations = [...input.declarations].sort((left, right) =>
    compareText(executorDeclarationKey(left), executorDeclarationKey(right)),
  );
  const peers = new Map<string, number>();
  for (const declaration of declarations) {
    const key = JSON.stringify([declaration.machineId, declaration.harness]);
    peers.set(key, (peers.get(key) ?? 0) + 1);
  }
  const bound = new Set<string>();
  const candidates: ReviewCandidate[] = [];
  for (const declaration of declarations) {
    const binding = bindQuotaStream(
      declaration,
      streams,
      peers.get(JSON.stringify([declaration.machineId, declaration.harness])) ?? 1,
    );
    if (binding.stream) {
      bound.add(binding.stream.key);
    }
    const observation = observations.get(JSON.stringify([declaration.machineId, declaration.harness]));
    candidates.push(declaredCandidate(declaration, binding, observation, input, freshness));
  }
  for (const stream of streams) {
    if (bound.has(stream.key)) {
      continue;
    }
    const harness: ExecutorHarness = stream.family === 'claude' ? 'claude-code' : 'codex';
    const observation =
      stream.machineId === null ? undefined : observations.get(JSON.stringify([stream.machineId, harness]));
    candidates.push(observedOnlyCandidate(stream, observation, input, freshness));
  }
  return candidates.sort((left, right) => compareText(left.id, right.id));
};

/** Observations provide candidates to inspect, never permission or execution qualification. */
export const observedReviewCandidates = (
  providers: readonly ProviderStatus[],
  now: string = new Date().toISOString(),
): ReviewCandidate[] =>
  qualifyReviewCandidates({ declarations: [], executorObservations: [], now, providers, target: null });

// ---------------------------------------------------------------------------------------------
// Simulation: constraints first, then preferences; nothing here grants permission or capacity
// ---------------------------------------------------------------------------------------------

const inputErrors = ({ candidates, policy, referenceTime, request }: ReviewRoutingInput): string[] => {
  const errors: string[] = [];
  if (timestamp(referenceTime) === null) {
    errors.push('Reference time must be a canonical ISO timestamp.');
  }
  if (candidates.length > MAX_REVIEW_ROUTING_CANDIDATES) {
    errors.push(
      `Routing accepts at most ${MAX_REVIEW_ROUTING_CANDIDATES} candidates; no subset was silently selected.`,
    );
  }
  if (
    request.action !== 'read-only-review' ||
    request.minimumQuality !== 'review-capable' ||
    request.target.kind !== 'session' ||
    !validId(request.target.machineId) ||
    !validId(request.target.harness) ||
    !validId(request.target.sourceSessionId) ||
    request.requiredCapabilities.length !== 1 ||
    request.requiredCapabilities[0] !== 'read-only-review'
  ) {
    errors.push('The request must name one exact session and require a review-capable read-only review.');
  }
  if (
    !Number.isFinite(policy.nearResetMinutes) ||
    policy.nearResetMinutes < 0 ||
    policy.nearResetMinutes > MAX_NEAR_RESET_MINUTES ||
    typeof policy.preferNearReset !== 'boolean' ||
    ![null, 'claude-code', 'codex'].includes(policy.preferredHarness) ||
    (policy.forcedCandidateId !== null && !validId(policy.forcedCandidateId))
  ) {
    errors.push(
      `Policy requires a valid harness preference and a reset horizon between 0 and ${MAX_NEAR_RESET_MINUTES} minutes.`,
    );
  }
  return errors;
};

interface EvaluationBuilder {
  readonly excluded: string[];
  readonly missing: string[];
}

const requireEvidence = (evaluation: EvaluationBuilder, condition: boolean, label: string): void => {
  if (!condition) {
    evaluation.missing.push(label);
    evaluation.excluded.push(`${label} is not established.`);
  }
};

const checkWindow = (
  window: ProviderLimitWindow,
  candidate: ReviewCandidate,
  now: number,
  result: EvaluationBuilder,
): void => {
  const label = `Quota window ${window.label}`;
  if (window.scope === 'unknown' || (window.scope === 'model' && !candidate.model)) {
    requireEvidence(result, false, `${label} applicability to this model`);
  } else if (window.scope === 'model' && candidate.model && !windowNamesModel(window, candidate.model)) {
    // Another model's window on the same account: one resource, but not this review's capacity.
    // It is neither counted nor summed with the windows that do apply.
    result.missing.push(`${label} applies to another model than ${candidate.model}; not counted.`);
    return;
  }
  const used = window.usedPercent ?? (window.remainingPercent === null ? null : 100 - window.remainingPercent);
  requireEvidence(result, used !== null, `${label} capacity`);
  if (window.blocked || (used !== null && used >= 100)) {
    result.excluded.push(`${label} is exhausted or blocked.`);
  }
  if (
    window.usedPercent !== null &&
    window.remainingPercent !== null &&
    Math.abs(window.usedPercent + window.remainingPercent - 100) > 0.001
  ) {
    result.excluded.push(`${label} has contradictory used and remaining percentages.`);
  }
  const reset = timestamp(window.resetsAt);
  requireEvidence(result, reset !== null, `${label} reset time`);
  if (reset !== null && reset <= now) {
    result.excluded.push(`${label} has crossed its observed reset; a new observation is required.`);
  }
};

const checkQuotaAccount = (candidate: ReviewCandidate, account: string | null, result: EvaluationBuilder): void => {
  if (account === null) {
    // A stored key without an account suffix is bound only by a declaration that names the account
    // for this family and machine; an observed-only candidate has no account to attribute it to.
    if (!(candidate.provenance.accountScope === 'declared' && validId(candidate.accountScope))) {
      requireEvidence(result, false, 'Known account scope for quota attribution');
    }
    return;
  }
  if (!validId(candidate.accountScope)) {
    requireEvidence(result, false, 'Known account scope for quota attribution');
  } else if (account !== candidate.accountScope) {
    result.excluded.push('Quota account scope does not match the candidate account.');
  }
};

const checkQuota = (candidate: ReviewCandidate, referenceTime: string, result: EvaluationBuilder): void => {
  const quota = candidate.quota;
  if (quota === null) {
    requireEvidence(result, false, 'Quota observation');
    return;
  }
  if (
    quota.windows.length > MAX_QUOTA_WINDOWS ||
    !parseProviderStatusDataset({ generatedAt: referenceTime, providers: [quota], schemaVersion: 1 })
  ) {
    result.excluded.push('Quota observation is invalid or exceeds the window budget.');
    return;
  }
  const now = Date.parse(referenceTime);
  const observedAt = timestamp(quota.generatedAt);
  requireEvidence(result, observedAt !== null, 'Valid quota observation time');
  if (observedAt !== null && observedAt > now) {
    result.excluded.push('Quota observation is dated after the reference time.');
  }
  const scope = providerScope(quota);
  if (scope.family !== (candidate.harness === 'claude-code' ? 'claude' : 'codex')) {
    result.excluded.push('Quota provider does not match the candidate harness.');
  }
  if (!quota.machineId || quota.machineId !== candidate.machineId) {
    result.excluded.push('Quota machine does not match the candidate machine.');
  }
  checkQuotaAccount(candidate, scope.account, result);
  if (quota.source !== 'live-api' && quota.source !== 'local-history') {
    result.excluded.push('Quota source is not an observed provider or session-log reading.');
  }
  const fresh = providerStatusWithFeedFreshness(quota, new Date(now));
  if (fresh.state !== 'ok') {
    result.excluded.push(`Quota observation is ${fresh.state}; current capacity is not established.`);
  }
  requireEvidence(result, quota.windows.length > 0, 'Usable quota windows');
  const windowIds = new Set<string>();
  for (const window of quota.windows) {
    if (windowIds.has(window.id)) {
      result.excluded.push('Quota observation contains duplicate window identities.');
    }
    windowIds.add(window.id);
    checkWindow(window, candidate, now, result);
  }
};

const evaluateCandidate = (
  candidate: ReviewCandidate,
  input: ReviewRoutingInput,
  duplicateIds: ReadonlySet<string>,
  duplicateQuotas: ReadonlySet<string>,
): ReviewCandidateEvaluation => {
  const result: EvaluationBuilder = { excluded: [], missing: [] };
  if (!validId(candidate.id) || duplicateIds.has(candidate.id)) {
    result.excluded.push('Candidate identity is invalid or duplicated.');
  }
  if (candidate.harness !== 'claude-code' && candidate.harness !== 'codex') {
    result.excluded.push('Candidate harness is unsupported.');
  }
  requireEvidence(result, validId(candidate.machineId), 'Candidate machine');
  if (candidate.machineId !== null && candidate.machineId !== input.request.target.machineId) {
    result.excluded.push('Candidate machine cannot access this machine-scoped session.');
  }
  if (candidate.authorization === 'forbidden') {
    result.excluded.push('Read-only review is forbidden for this candidate.');
  } else {
    requireEvidence(result, candidate.authorization === 'allowed', 'Review authorization');
  }
  requireEvidence(result, candidate.authorizedTarget !== null, 'Authorization bound to a target');
  if (candidate.authorizedTarget !== null && !sameTarget(candidate.authorizedTarget, input.request.target)) {
    result.excluded.push('Authorization belongs to a different target.');
  }
  if (candidate.subscription === 'api') {
    result.excluded.push(
      candidate.provenance.subscription === 'observed-now'
        ? 'API billing observed from the CLI sign-in contradicts the declared subscription; outside the subscription-only policy.'
        : 'API billing is outside the subscription-only policy.',
    );
  } else {
    requireEvidence(result, candidate.subscription === 'verified', 'Verified subscription billing');
  }
  if (candidate.availability === 'unavailable') {
    result.excluded.push('Candidate is unavailable.');
  } else {
    requireEvidence(result, candidate.availability === 'available', 'Candidate availability');
  }
  requireEvidence(result, candidate.capabilities.includes('read-only-review'), 'Read-only review capability');
  requireEvidence(result, candidate.quality === 'review-capable', 'Review-capable quality');
  requireEvidence(result, validId(candidate.evidence.source), 'Candidate evidence source');
  const evidenceTime = timestamp(candidate.evidence.observedAt);
  requireEvidence(result, evidenceTime !== null, 'Candidate evidence observation time');
  if (evidenceTime !== null && evidenceTime > Date.parse(input.referenceTime)) {
    result.excluded.push('Candidate evidence is dated after the reference time.');
  }
  if (candidate.model === null) {
    result.missing.push('Model was not observed (optional for global quota windows).');
  }
  if (candidate.effort === null) {
    result.missing.push('Effort was not observed (optional).');
  }
  if (candidate.quota !== null && duplicateQuotas.has(quotaIdentity(candidate.quota))) {
    result.excluded.push('Quota scope is attributed to multiple candidates; attribution is ambiguous.');
  }
  checkQuota(candidate, input.referenceTime, result);
  return {
    candidateId: candidate.id,
    eligible: result.excluded.length === 0,
    exclusionReasons: [...new Set(result.excluded)],
    missingData: [...new Set(result.missing)],
  };
};

const repeatedValues = (values: readonly string[]): Set<string> => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value);
    }
    seen.add(value);
  }
  return repeated;
};

const preferredReset = (candidate: ReviewCandidate, input: ReviewRoutingInput): number => {
  if (!input.policy.preferNearReset) {
    return Number.POSITIVE_INFINITY;
  }
  const now = Date.parse(input.referenceTime);
  const horizon = now + input.policy.nearResetMinutes * 60_000;
  const resets = (candidate.quota?.windows ?? [])
    .map((window) => timestamp(window.resetsAt))
    .filter((reset): reset is number => reset !== null && reset > now && reset <= horizon);
  return Math.min(...resets);
};

/** Pure simulation. Constraints run first; preferences cannot grant permission or capacity. */
export const simulateWorkReviewRouting = (input: ReviewRoutingInput): ReviewRoutingResult => {
  const errors = inputErrors(input);
  if (errors.length > 0) {
    return { chosenCandidateId: null, evaluations: [], reasons: errors, referenceTime: input.referenceTime };
  }
  const candidates = [...input.candidates].sort((left, right) => compareText(left.id, right.id));
  const duplicateIds = repeatedValues(candidates.map((candidate) => candidate.id));
  const duplicateQuotas = repeatedValues(
    candidates.flatMap((candidate) => (candidate.quota === null ? [] : [quotaIdentity(candidate.quota)])),
  );
  const evaluations = candidates.map((candidate) => evaluateCandidate(candidate, input, duplicateIds, duplicateQuotas));
  const reasons = ['Simulation only: no harness is started and no permission is granted.'];
  const eligible = candidates.filter((_, index) => evaluations[index]?.eligible);
  const forced = input.policy.forcedCandidateId;
  let choices = eligible;
  if (forced !== null) {
    choices = eligible.filter((candidate) => candidate.id === forced);
    reasons.push(
      choices.length > 0
        ? `The explicit candidate override selects ${forced} after all constraints pass.`
        : `The explicit candidate override ${forced} is absent or ineligible; it cannot bypass constraints.`,
    );
  }
  choices.sort((left, right) => {
    const leftReset = preferredReset(left, input);
    const rightReset = preferredReset(right, input);
    if (leftReset !== rightReset) {
      return leftReset < rightReset ? -1 : 1;
    }
    const leftPreferred = left.harness === input.policy.preferredHarness;
    const rightPreferred = right.harness === input.policy.preferredHarness;
    if (leftPreferred !== rightPreferred) {
      return leftPreferred ? -1 : 1;
    }
    return compareText(left.id, right.id);
  });
  const chosen = choices[0];
  if (chosen) {
    reasons.push(
      `Selected ${chosen.id}: all authorization, target, subscription, availability, capability, quality and quota constraints passed.`,
    );
    reasons.push(
      input.policy.preferNearReset
        ? `Preference order: observed future reset within ${input.policy.nearResetMinutes} minutes (earliest first), ${input.policy.preferredHarness ?? 'no harness preference'}, then stable candidate identity.`
        : `Preference order: ${input.policy.preferredHarness ?? 'no harness preference'}, then stable candidate identity.`,
    );
    reasons.push(
      'Quota percentages are checked only against their own windows; offers are never compared by percentage.',
    );
  } else {
    reasons.push(
      candidates.length === 0
        ? 'No observed candidates are available; machine, account and execution qualification are missing.'
        : 'No candidate satisfies every constraint and the explicit policy. See exclusions and missing data.',
    );
  }
  return { chosenCandidateId: chosen?.id ?? null, evaluations, reasons, referenceTime: input.referenceTime };
};

// ---------------------------------------------------------------------------------------------
// Recommendation: is the simulated choice backed by current facts, or conditional on one of them
// ---------------------------------------------------------------------------------------------

const REQUIRED_PROVENANCE_FIELDS = [
  'accountScope',
  'authorization',
  'subscription',
  'availability',
  'capabilities',
  'quality',
  'quota',
] as const satisfies readonly CandidateProvenanceField[];

const MISSING_OBSERVATION_LABELS: Readonly<Record<(typeof REQUIRED_PROVENANCE_FIELDS)[number], string>> = {
  accountScope: 'account scope',
  authorization: 'authorization declaration',
  availability: 'executor availability observation',
  capabilities: 'capability declaration',
  quality: 'quality declaration',
  quota: 'quota observation',
  subscription: 'subscription declaration',
};

const EXCLUSION_FIELD_PATTERNS: Readonly<Record<(typeof REQUIRED_PROVENANCE_FIELDS)[number], RegExp>> = {
  accountScope: /account scope/iu,
  authorization: /authorization|forbidden/iu,
  availability: /availab/iu,
  capabilities: /capability/iu,
  quality: /quality/iu,
  quota: /quota/iu,
  subscription: /subscription|billing/iu,
};

const unsettledFields = (candidate: ReviewCandidate) =>
  REQUIRED_PROVENANCE_FIELDS.filter((field) => {
    const provenance = candidate.provenance[field];
    return provenance === 'unknown' || provenance === 'stale';
  });

/**
 * `real` when the chosen candidate rests on declared and currently observed facts only;
 * `conditional` when no candidate is eligible but one would be with exactly one named observation
 * that is missing or stale (a conditional simulation never permits a launch); otherwise `none`.
 */
export const assessReviewRecommendation = (
  result: ReviewRoutingResult,
  candidates: readonly ReviewCandidate[],
): ReviewRecommendation => {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate] as const));
  if (result.chosenCandidateId !== null) {
    const chosen = byId.get(result.chosenCandidateId);
    const unsettled = chosen ? unsettledFields(chosen) : [];
    if (chosen && unsettled.length === 0) {
      return { candidateId: chosen.id, kind: 'real', missing: null };
    }
    const first = unsettled[0];
    return {
      candidateId: result.chosenCandidateId,
      kind: 'conditional',
      missing: first === undefined ? 'candidate detail' : MISSING_OBSERVATION_LABELS[first],
    };
  }
  const evaluations = [...result.evaluations].sort((left, right) => compareText(left.candidateId, right.candidateId));
  for (const evaluation of evaluations) {
    const candidate = byId.get(evaluation.candidateId);
    if (!candidate || evaluation.exclusionReasons.length === 0) {
      continue;
    }
    const unsettled = unsettledFields(candidate);
    const field = unsettled[0];
    if (unsettled.length !== 1 || field === undefined) {
      continue;
    }
    const pattern = EXCLUSION_FIELD_PATTERNS[field];
    if (evaluation.exclusionReasons.every((reason) => pattern.test(reason))) {
      return { candidateId: candidate.id, kind: 'conditional', missing: MISSING_OBSERVATION_LABELS[field] };
    }
  }
  return { candidateId: null, kind: 'none', missing: null };
};

export const recommendationKind = (
  result: ReviewRoutingResult,
  candidates: readonly ReviewCandidate[],
): RecommendationKind => assessReviewRecommendation(result, candidates).kind;
