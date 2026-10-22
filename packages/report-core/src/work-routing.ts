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
  isExecutorAccountFingerprint,
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

/**
 * How the account the CLI is signed in to relates to the declaration (ADR 0057):
 *
 * - `confirmed`: the pinned fingerprint equals the one observed now.
 * - `contradicted`: the CLI is signed in to another account than the pinned one; the route is
 *   invalidated until the operator signs back in or re-declares.
 * - `unpinned`: the CLI reports an identity and the declaration pins none, so nothing ties the
 *   signed-in account to this route; requalification is the pin.
 * - `unobserved`: a fingerprint is pinned but no current observation reports one.
 * - `not-observable`: neither side carries one (Codex exposes none outside its credential file; an
 *   older CLI may print none); the quota binding rests on the single declaration (ADR 0052).
 */
export type CandidateIdentityState = 'confirmed' | 'contradicted' | 'not-observable' | 'unobserved' | 'unpinned';

export interface CandidateIdentity {
  /** `routing.executors[].accountFingerprint`; always a declaration, never shown as observed. */
  readonly declared: string | null;
  /** The latest observed fingerprint, with its own provenance below; `null` when none was reported. */
  readonly observed: string | null;
  readonly observedAt: string | null;
  readonly observedProvenance: CandidateProvenance;
  readonly state: CandidateIdentityState;
}

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
  /**
   * Set by `qualifyReviewCandidates` on every declared candidate; absent only on candidates built
   * elsewhere (synthetic demo fixtures), for which no identity is assessed.
   */
  readonly identity?: CandidateIdentity;
  readonly machineId: string | null;
  readonly machineLabel: string | null;
  readonly model: string | null;
  readonly provenance: CandidateProvenanceMap;
  /** Precise, realizable steps that would supply the data this candidate lacks. Empty when nothing is missing. */
  readonly qualificationActions: readonly string[];
  readonly quality: 'review-capable' | 'unknown';
  readonly quota: ProviderStatus | null;
  /**
   * Candidates with the same resource are models of one declared account: one quota resource,
   * never several reserves. Absent means the candidate is its own resource.
   */
  readonly resourceId?: string;
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

/** Words that name a window's period or family, never a model; they must not match a declared model. */
const WINDOW_GENERIC_WORDS: ReadonlySet<string> = new Set([
  '5h',
  'all',
  'daily',
  'day',
  'five',
  'hour',
  'model',
  'models',
  'monthly',
  'scoped',
  'session',
  'seven',
  'week',
  'weekly',
]);
const NON_ALPHANUMERIC_PATTERN = /[^\p{L}\p{N}]+/u;
const DIGITS_ONLY_PATTERN = /^\p{N}+$/u;

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(NON_ALPHANUMERIC_PATTERN)
    .filter((word) => word.length > 0);

/**
 * The model words a model-scoped window carries: the display name of the Agent SDK's
 * `model_scoped` windows (`model:Fable`, labelled "Fable · Weekly"), or the non-generic words of a
 * `limits[]` kind and label (`weekly_opus`, "Weekly · Opus"). Period words and bare numbers never
 * count, so a declared model can never match every window through "weekly" or "4".
 */
const windowModelWords = (window: ProviderLimitWindow): ReadonlySet<string> => {
  const sources = window.id.startsWith(MODEL_WINDOW_ID_PREFIX)
    ? [window.id.slice(MODEL_WINDOW_ID_PREFIX.length)]
    : [window.id, window.label];
  const periodWords = new Set(wordsOf(window.group ?? ''));
  return new Set(
    sources
      .flatMap(wordsOf)
      .filter((word) => !(WINDOW_GENERIC_WORDS.has(word) || periodWords.has(word) || DIGITS_ONLY_PATTERN.test(word))),
  );
};

/**
 * Whether a model-scoped window applies to the declared model. Any shared model word counts
 * ("claude-opus-4-1" and "opus" both match an "Opus" window): counting a window that might apply
 * can only exclude a candidate, while missing one would launch a model whose limit is exhausted.
 */
const windowNamesModel = (window: ProviderLimitWindow, model: string): boolean => {
  const words = windowModelWords(window);
  return wordsOf(model).some((word) => words.has(word));
};

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

const declareAction = (family: string, account: string | null, fingerprint: string | null = null): string =>
  `Add routing.executors[] for ${family}:${account ?? '<accountScope>'} with authorization 'allowed', targets [{kind:'any-local-session'}], subscription 'verified', declaredAt${
    fingerprint === null ? '' : `, accountFingerprint "${fingerprint}" (the signed-in account)`
  }`;

interface QuotaBinding {
  readonly actions: readonly string[];
  readonly stream: QuotaStream | null;
}

/** How many declarations share this family and machine, and how many of them the signed-in account confirms. */
interface PeerDeclarations {
  readonly confirmed: number;
  readonly total: number;
}

const bindQuotaStream = (
  declaration: ExecutorDeclaration,
  streams: readonly QuotaStream[],
  peers: PeerDeclarations,
  identity: CandidateIdentity,
): QuotaBinding => {
  const family = executorHarnessFamily(declaration.harness);
  const candidates = streams.filter((stream) => stream.machineId === declaration.machineId && stream.family === family);
  const exact = candidates.find((stream) => stream.account === declaration.accountScope);
  if (exact) {
    return { actions: [], stream: exact };
  }
  const bare = candidates.filter((stream) => stream.account === null);
  const scoped = candidates.filter((stream) => stream.account !== null);
  if (bare.length === 1 && scoped.length === 0 && peers.total === 1) {
    // The stored key carries no account suffix (the live collectors record none), so the one
    // declaration for this family on this machine binds its single quota stream.
    return { actions: [], stream: bare[0] ?? null };
  }
  if (bare.length === 1 && scoped.length === 0 && peers.confirmed === 1) {
    // The bare stream is read through the signed-in CLI, so it belongs to the signed-in account:
    // the one declaration whose pinned fingerprint that account confirms binds it (ADR 0057).
    return identity.state === 'confirmed'
      ? { actions: [], stream: bare[0] ?? null }
      : {
          actions: [
            `The quota stream for ${family} on machine ${declaration.machineId} belongs to the signed-in account, which another routing.executors[] entry pins; this entry is not the signed-in account`,
          ],
          stream: null,
        };
  }
  if (bare.length === 1 && peers.total > 1) {
    return {
      actions: [
        `Quota attribution is ambiguous: ${peers.total} routing.executors[] entries for ${family} on machine ${declaration.machineId} share one quota stream without an account suffix; keep one entry, or pin each entry's accountFingerprint so the signed-in account selects one`,
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

const IDENTITY_DECLARE_FIELD = 'routing.executors[].accountFingerprint';

/**
 * Compares the pinned fingerprint with the latest observed one (ADR 0057). Only an observation
 * that is current can confirm or contradict; a stale one is shown with its own provenance and
 * settles nothing. A declared value is never reported as observed.
 */
const assessIdentity = (
  declared: string | null,
  observation: ExecutorObservation | undefined,
  availability: AvailabilityAssessment,
): CandidateIdentity => {
  const observed = observation?.accountFingerprint ?? null;
  const current = availability.provenance === 'observed-now' && observed !== null;
  let observedProvenance: CandidateProvenance = 'unknown';
  if (observed !== null) {
    observedProvenance = availability.provenance === 'stale' ? 'stale' : 'observed-now';
  }
  let state: CandidateIdentityState;
  if (declared === null) {
    state = observed === null ? 'not-observable' : 'unpinned';
  } else if (current) {
    state = declared === observed ? 'confirmed' : 'contradicted';
  } else {
    state = 'unobserved';
  }
  return {
    declared,
    observed,
    observedAt: observed === null ? null : (observation?.observedAt ?? null),
    observedProvenance,
    state,
  };
};

const identityActions = (identity: CandidateIdentity, harness: ExecutorHarness, scope: string): string[] => {
  switch (identity.state) {
    case 'unpinned':
      return [
        `Pin the signed-in account: add "accountFingerprint": "${identity.observed}" to routing.executors[] for ${scope} (observed ${identity.observedAt}); a later change of account then invalidates this route instead of passing unnoticed`,
      ];
    case 'contradicted':
      return [
        `${harnessName(harness)} is signed in to another account (fingerprint ${identity.observed} observed ${identity.observedAt}) than ${scope} pins (${identity.declared}): sign ${harnessCommand(harness)} back in to that account, or re-declare ${IDENTITY_DECLARE_FIELD} and declaredAt for the new one`,
      ];
    case 'unobserved':
      return [
        `${IDENTITY_DECLARE_FIELD} is pinned for ${scope} but no current observation reports the signed-in account; ${EXECUTOR_REFRESH_ACTION}`,
      ];
    default:
      return [];
  }
};

/** The candidate id of each declared model: the preferred model keeps the declaration's id. */
const declaredCandidateId = (declaration: ExecutorDeclaration, modelIndex: number): string => {
  const base = `declared:${executorDeclarationKey(declaration)}`;
  const alternate = modelIndex === 0 ? undefined : declaration.alternateModels?.[modelIndex - 1];
  return alternate === undefined ? base : `${base}:model:${modelIndex}:${alternate}`;
};

/**
 * The declaration and the model a declared candidate id names, or `null` when no declaration
 * produces it. The launch must use this model: an alternate candidate shares its declaration.
 */
export const declarationForReviewCandidate = (
  declarations: readonly ExecutorDeclaration[],
  candidateId: string,
): { readonly declaration: ExecutorDeclaration; readonly model: string | null } | null => {
  for (const declaration of declarations) {
    const models = [declaration.model, ...(declaration.alternateModels ?? [])];
    for (const [index, model] of models.entries()) {
      if (declaredCandidateId(declaration, index) === candidateId) {
        return { declaration, model };
      }
    }
  }
  return null;
};

const declaredCandidates = (
  declaration: ExecutorDeclaration,
  binding: QuotaBinding,
  observation: ExecutorObservation | undefined,
  input: QualifyReviewCandidatesInput,
  freshness: QualificationFreshness,
): ReviewCandidate[] => {
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
  const identity = assessIdentity(declaration.accountFingerprint ?? null, observation, availability);
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
  actions.push(...identityActions(identity, declaration.harness, scope));
  if (binding.stream !== null && quota === null) {
    actions.push(
      `Quota observations for ${scope} on machine ${declaration.machineId} are ambiguous (several stored readings for one scope); ${QUOTA_REFRESH_ACTION}`,
    );
  }
  actions.push(...binding.actions, ...availability.actions);
  const quotaFallback =
    quota === null && binding.stream === null && binding.actions.length === 0
      ? // No stream for this family and machine at all; a binding problem already names its own fix.
        [QUOTA_REFRESH_ACTION]
      : [];
  const trailing =
    Date.parse(declaration.declaredAt) > now
      ? [`declaredAt ${declaration.declaredAt} for ${scope} is in the future; correct it`]
      : [];
  const resourceId = `declared:${executorDeclarationKey(declaration)}`;
  const models = [declaration.model, ...(declaration.alternateModels ?? [])];
  return models.map((model, index) => ({
    id: declaredCandidateId(declaration, index),
    resourceId,
    machineId: declaration.machineId,
    machineLabel: quota?.machineLabel ?? null,
    accountScope: declaration.accountScope,
    harness: declaration.harness,
    identity,
    model,
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
      model: model === null ? 'unknown' : 'declared',
      effort: declaration.effort === null ? 'unknown' : 'declared',
    },
    qualificationActions: [
      ...new Set([
        ...actions,
        ...(quota === null ? quotaFallback : quotaActions(quota, quotaOrigin, now, model)),
        ...modelActions(quota, model, scope),
        ...trailing,
      ]),
    ],
    evidence: {
      source: `Declared in routing.executors[] (declaredAt ${declaration.declaredAt})${
        index === 0 ? '' : `, alternate model ${index} of ${scope}`
      }; executor ${observation ? `observed ${observation.observedAt}` : 'not observed'}; quota ${
        quota ? `stored ${quota.source} observation ${quota.generatedAt}` : 'not observed'
      }`,
      observedAt: declaration.declaredAt,
    },
  }));
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
  const identity = assessIdentity(null, observation, availability);
  return {
    id: `observed:${stream.key}`,
    identity,
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
        declareAction(stream.family, stream.account, identity.state === 'unpinned' ? identity.observed : null),
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
  const now = Date.parse(input.now);
  // Identity is assessed before binding: the signed-in account may select one of several entries.
  const identities = declarations.map((declaration) => {
    const observation = observations.get(JSON.stringify([declaration.machineId, declaration.harness]));
    const availability = assessAvailability(
      observation,
      declaration.harness,
      declaration.machineId,
      now,
      freshness.executorMs,
    );
    return assessIdentity(declaration.accountFingerprint ?? null, observation, availability);
  });
  const peers = new Map<string, { confirmed: number; total: number }>();
  for (const [index, declaration] of declarations.entries()) {
    const key = JSON.stringify([declaration.machineId, declaration.harness]);
    const current = peers.get(key) ?? { confirmed: 0, total: 0 };
    peers.set(key, {
      confirmed: current.confirmed + (identities[index]?.state === 'confirmed' ? 1 : 0),
      total: current.total + 1,
    });
  }
  const bound = new Set<string>();
  const candidates: ReviewCandidate[] = [];
  for (const [index, declaration] of declarations.entries()) {
    const key = JSON.stringify([declaration.machineId, declaration.harness]);
    const identity = identities[index];
    if (!identity) {
      throw new Error('Every declaration has an identity assessment');
    }
    const binding = bindQuotaStream(declaration, streams, peers.get(key) ?? { confirmed: 0, total: 1 }, identity);
    if (binding.stream) {
      bound.add(binding.stream.key);
    }
    candidates.push(...declaredCandidates(declaration, binding, observations.get(key), input, freshness));
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
  if (
    window.scope === 'unknown' ||
    (window.scope === 'model' && (!candidate.model || windowModelWords(window).size === 0))
  ) {
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
  // The collectors read a provider as `partial` as soon as one window is blocked. Every window is
  // judged on its own below, so one exhausted model window excludes only the models it applies to,
  // never the account's other models.
  const partialFromBlockedWindow = fresh.state === 'partial' && quota.windows.some((window) => window.blocked);
  if (fresh.state !== 'ok' && !partialFromBlockedWindow) {
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

/** ADR 0057: a pinned identity must be confirmed now; an observable one must be pinned. */
const checkIdentity = (candidate: ReviewCandidate, result: EvaluationBuilder): void => {
  const identity = candidate.identity;
  if (identity === undefined || candidate.provenance.authorization !== 'declared') {
    return;
  }
  switch (identity.state) {
    case 'contradicted':
      result.excluded.push(
        `Account identity contradicts the declaration: the CLI reports account ${identity.observed} (observed ${identity.observedAt}), the declaration pins ${identity.declared}.`,
      );
      return;
    case 'unobserved':
      // Without a current executor observation, availability already names the one missing fact.
      if (candidate.provenance.availability === 'observed-now') {
        requireEvidence(result, false, 'Account identity observation for the pinned account');
      } else {
        result.missing.push('Account identity awaits a current executor observation.');
      }
      return;
    case 'unpinned':
      result.missing.push('Account identity pin');
      result.excluded.push(
        `Account identity ${identity.observed} is observed but not pinned by the declaration; nothing ties the signed-in account to this route.`,
      );
      return;
    case 'not-observable':
      result.missing.push(
        'Account identity is not observable for this harness; the binding rests on the single declaration.',
      );
      return;
    default:
      return;
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
  checkIdentity(candidate, result);
  checkQuota(candidate, input.referenceTime, result);
  return {
    candidateId: candidate.id,
    eligible: result.excluded.length === 0,
    exclusionReasons: [...new Set(result.excluded)],
    missingData: [...new Set(result.missing)],
  };
};

/** Quota identities attributed to more than one resource; models of one account are one resource. */
const quotasSharedAcrossResources = (candidates: readonly ReviewCandidate[]): Set<string> => {
  const resources = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (candidate.quota === null) {
      continue;
    }
    const key = quotaIdentity(candidate.quota);
    const owners = resources.get(key) ?? new Set<string>();
    owners.add(candidate.resourceId ?? candidate.id);
    resources.set(key, owners);
  }
  return new Set([...resources].filter(([, owners]) => owners.size > 1).map(([key]) => key));
};

/** Whether a window bounds this candidate's model: account-wide windows always, model windows only for their model. */
const windowAppliesTo = (window: ProviderLimitWindow, candidate: ReviewCandidate): boolean =>
  window.scope !== 'model' || (candidate.model !== null && windowNamesModel(window, candidate.model));

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
    .filter((window) => windowAppliesTo(window, candidate))
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
  const duplicateQuotas = quotasSharedAcrossResources(candidates);
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
    const sameAccount = chosen.resourceId
      ? candidates.filter((candidate) => candidate.resourceId === chosen.resourceId)
      : [];
    if (sameAccount.length > 1) {
      const shared = (chosen.quota?.windows ?? [])
        .filter((window) => window.scope !== 'model')
        .map((window) => window.label);
      reasons.push(
        `${sameAccount.map((candidate) => candidate.model ?? 'unknown model').join(', ')} are models of one account (${chosen.accountScope ?? 'unknown'}): one quota resource, not separate reserves. ${
          shared.length > 0
            ? `The account-wide windows (${shared.join(', ')}) bound every model whichever runs`
            : 'No account-wide window was observed'
        }; a model window bounds only its own model.`,
      );
    }
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

/** The required provenance fields plus the account identity of a declared candidate (ADR 0057). */
type RequiredFact = (typeof REQUIRED_PROVENANCE_FIELDS)[number] | 'identity';

const MISSING_OBSERVATION_LABELS: Readonly<Record<RequiredFact, string>> = {
  accountScope: 'account scope',
  identity: 'account identity observation',
  authorization: 'authorization declaration',
  availability: 'executor availability observation',
  capabilities: 'capability declaration',
  quality: 'quality declaration',
  quota: 'quota observation',
  subscription: 'subscription declaration',
};

const EXCLUSION_FIELD_PATTERNS: Readonly<Record<RequiredFact, RegExp>> = {
  accountScope: /account scope/iu,
  identity: /account identity/iu,
  authorization: /authorization|forbidden/iu,
  availability: /availab/iu,
  capabilities: /capability/iu,
  quality: /quality/iu,
  quota: /quota/iu,
  subscription: /subscription|billing/iu,
};

const unsettledFields = (candidate: ReviewCandidate): RequiredFact[] => {
  const fields: RequiredFact[] = REQUIRED_PROVENANCE_FIELDS.filter((field) => {
    const provenance = candidate.provenance[field];
    return provenance === 'unknown' || provenance === 'stale';
  });
  const identity = candidate.identity?.state;
  if (
    candidate.provenance.authorization === 'declared' &&
    (identity === 'unpinned' || (identity === 'unobserved' && candidate.provenance.availability === 'observed-now'))
  ) {
    fields.push('identity');
  }
  return fields;
};

const missingLabel = (candidate: ReviewCandidate, field: RequiredFact): string =>
  field === 'identity' && candidate.identity?.state === 'unpinned'
    ? 'account identity pin (routing.executors[].accountFingerprint)'
    : MISSING_OBSERVATION_LABELS[field];

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
      missing: first === undefined || !chosen ? 'candidate detail' : missingLabel(chosen, first),
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
      return { candidateId: candidate.id, kind: 'conditional', missing: missingLabel(candidate, field) };
    }
  }
  return { candidateId: null, kind: 'none', missing: null };
};

export const recommendationKind = (
  result: ReviewRoutingResult,
  candidates: readonly ReviewCandidate[],
): RecommendationKind => assessReviewRecommendation(result, candidates).kind;

// ---------------------------------------------------------------------------------------------
// Engine qualification (ADR 0057): one bounded decision the engine computes on request from the
// facts it has just re-read, carried through the control plane as a decision, never as report data
// ---------------------------------------------------------------------------------------------

/** The policy of a qualification is the launch's own, so what the page shows is what a launch re-decides. */
export const QUALIFICATION_POLICY: ReviewRoutingPolicy = {
  forcedCandidateId: null,
  nearResetMinutes: 60,
  preferNearReset: false,
  preferredHarness: 'claude-code',
};

export const ROUTING_QUALIFICATION_BOUNDS = {
  /** Serialized UTF-8 budget of one qualification, under the control plane's completion bound. */
  maxBytes: 48 * 1024,
  maxCandidates: 8,
  /** Entries kept per list (reasons, exclusions, missing data, actions). */
  maxEntries: 12,
  maxId: MAX_ID_LENGTH,
  /** Characters kept per text entry; a longer one ends with an ellipsis, never silently cut. */
  maxText: 480,
} as const;

export const CANDIDATE_IDENTITY_STATES = [
  'confirmed',
  'contradicted',
  'not-observable',
  'unobserved',
  'unpinned',
] as const satisfies readonly CandidateIdentityState[];

export interface RoutingQualificationCandidate {
  readonly accountScope: string | null;
  /** The qualification actions of the candidate: what to declare, observe or refresh. */
  readonly actions: readonly string[];
  readonly candidateId: string;
  readonly eligible: boolean;
  readonly exclusionReasons: readonly string[];
  readonly harness: ExecutorHarness;
  /** Per-field provenance is kept: `declared` is the pin, `observed` the engine's observation. */
  readonly identity: Omit<CandidateIdentity, 'observedProvenance'> | null;
  readonly missingData: readonly string[];
  readonly model: string | null;
}

/** The engine's own executor observation for this qualification. */
export interface RoutingQualificationExecutors {
  /** The `executors.capabilities` outcome of the run this qualification requested. */
  readonly outcome:
    | 'disabled'
    | 'failed'
    | 'not-detected'
    | 'success'
    | 'timed-out'
    | 'warning'
    | 'skipped'
    | 'not-run';
  /** Whether that run finished after the qualification started; only then are its observations fresh. */
  readonly refreshed: boolean;
}

export interface RoutingQualification {
  readonly candidates: readonly RoutingQualificationCandidate[];
  readonly chosenCandidateId: string | null;
  readonly executors: RoutingQualificationExecutors;
  /** Candidates left out to respect the size bound; counted, never dropped in silence. */
  readonly omittedCandidates: number;
  /** The reference time every provenance was judged against. */
  readonly qualifiedAt: string;
  readonly reasons: readonly string[];
  readonly recommendation: ReviewRecommendation;
}

const QUALIFICATION_EXECUTOR_OUTCOMES = [
  'disabled',
  'failed',
  'not-detected',
  'not-run',
  'skipped',
  'success',
  'timed-out',
  'warning',
] as const satisfies readonly RoutingQualificationExecutors['outcome'][];
const RECOMMENDATION_KINDS = ['conditional', 'none', 'real'] as const satisfies readonly RecommendationKind[];

export interface QualifyReviewRoutingInput extends QualifyReviewCandidatesInput {
  readonly target: ReviewTarget;
}

/** Qualifies, simulates under the launch policy and assesses, in one pure step the engine runs. */
export const qualifyReviewRouting = (
  input: QualifyReviewRoutingInput,
): {
  readonly candidates: readonly ReviewCandidate[];
  readonly recommendation: ReviewRecommendation;
  readonly result: ReviewRoutingResult;
} => {
  const candidates = qualifyReviewCandidates(input);
  const result = simulateWorkReviewRouting({
    candidates,
    policy: QUALIFICATION_POLICY,
    referenceTime: input.now,
    request: {
      action: 'read-only-review',
      minimumQuality: 'review-capable',
      requiredCapabilities: ['read-only-review'],
      target: input.target,
    },
  });
  return { candidates, recommendation: assessReviewRecommendation(result, candidates), result };
};

const boundedText = (text: string): string =>
  text.length <= ROUTING_QUALIFICATION_BOUNDS.maxText
    ? text
    : `${text.slice(0, ROUTING_QUALIFICATION_BOUNDS.maxText - 1)}…`;
const boundedList = (values: readonly string[]): string[] =>
  values.slice(0, ROUTING_QUALIFICATION_BOUNDS.maxEntries).map(boundedText);
const serializedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export interface BuildRoutingQualificationInput {
  readonly candidates: readonly ReviewCandidate[];
  readonly executors: RoutingQualificationExecutors;
  readonly recommendation: ReviewRecommendation;
  readonly result: ReviewRoutingResult;
}

/**
 * The transportable decision: the chosen candidate first, then the others in their stable order;
 * every list and text is bounded, and candidates beyond the byte budget are counted as omitted.
 */
export const buildRoutingQualification = (input: BuildRoutingQualificationInput): RoutingQualification => {
  const evaluations = new Map(input.result.evaluations.map((evaluation) => [evaluation.candidateId, evaluation]));
  const chosen = input.result.chosenCandidateId;
  const ordered = [...input.candidates].sort((left, right) => {
    if ((left.id === chosen) !== (right.id === chosen)) {
      return left.id === chosen ? -1 : 1;
    }
    return compareText(left.id, right.id);
  });
  const rows: RoutingQualificationCandidate[] = ordered
    .filter((candidate) => validId(candidate.id))
    .map((candidate) => {
      const evaluation = evaluations.get(candidate.id);
      return {
        accountScope: candidate.accountScope,
        actions: boundedList(candidate.qualificationActions),
        candidateId: candidate.id,
        eligible: evaluation?.eligible ?? false,
        exclusionReasons: boundedList(evaluation?.exclusionReasons ?? []),
        harness: candidate.harness,
        identity:
          candidate.identity === undefined
            ? null
            : {
                declared: candidate.identity.declared,
                observed: candidate.identity.observed,
                observedAt: candidate.identity.observedAt,
                state: candidate.identity.state,
              },
        missingData: boundedList(evaluation?.missingData ?? []),
        model: candidate.model === null ? null : boundedText(candidate.model),
      };
    });
  let kept = rows.slice(0, ROUTING_QUALIFICATION_BOUNDS.maxCandidates);
  const make = (): RoutingQualification => ({
    candidates: kept,
    chosenCandidateId: chosen,
    executors: input.executors,
    omittedCandidates: input.candidates.length - kept.length,
    qualifiedAt: input.result.referenceTime,
    reasons: boundedList(input.result.reasons),
    recommendation: {
      candidateId: input.recommendation.candidateId,
      kind: input.recommendation.kind,
      missing: input.recommendation.missing === null ? null : boundedText(input.recommendation.missing),
    },
  });
  let qualification = make();
  while (kept.length > 1 && serializedBytes(qualification) > ROUTING_QUALIFICATION_BOUNDS.maxBytes) {
    kept = kept.slice(0, -1);
    qualification = make();
  }
  return qualification;
};

const isBoundedQualificationText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= ROUTING_QUALIFICATION_BOUNDS.maxText;
const isQualificationList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= ROUTING_QUALIFICATION_BOUNDS.maxEntries &&
  value.every(isBoundedQualificationText);
const isQualificationId = (value: unknown): value is string => typeof value === 'string' && validId(value);
const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isFingerprintOrNull = (value: unknown): value is string | null =>
  value === null || isExecutorAccountFingerprint(value);

const isOneOfValues = <const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] => typeof value === 'string' && (values as readonly string[]).includes(value);

const parseQualificationIdentity = (value: unknown): RoutingQualificationCandidate['identity'] | undefined => {
  if (value === null) {
    return null;
  }
  if (!(isRecordValue(value) && hasExactly(value, ['declared', 'observed', 'observedAt', 'state']))) {
    return;
  }
  const { declared, observed, observedAt, state } = value;
  if (
    !(
      isFingerprintOrNull(declared) &&
      isFingerprintOrNull(observed) &&
      (observedAt === null || isCanonicalInstant(observedAt)) &&
      isOneOfValues(CANDIDATE_IDENTITY_STATES, state)
    )
  ) {
    return;
  }
  return { declared, observed, observedAt, state };
};

const parseQualificationCandidate = (value: unknown): RoutingQualificationCandidate | null => {
  if (
    !(
      isRecordValue(value) &&
      hasExactly(value, [
        'accountScope',
        'actions',
        'candidateId',
        'eligible',
        'exclusionReasons',
        'harness',
        'identity',
        'missingData',
        'model',
      ]) &&
      (value.accountScope === null || isQualificationId(value.accountScope)) &&
      isQualificationList(value.actions) &&
      isQualificationId(value.candidateId) &&
      typeof value.eligible === 'boolean' &&
      isQualificationList(value.exclusionReasons) &&
      (value.harness === 'claude-code' || value.harness === 'codex') &&
      isQualificationList(value.missingData) &&
      (value.model === null || isBoundedQualificationText(value.model))
    )
  ) {
    return null;
  }
  const identity = parseQualificationIdentity(value.identity);
  if (identity === undefined) {
    return null;
  }
  return {
    accountScope: value.accountScope,
    actions: value.actions,
    candidateId: value.candidateId,
    eligible: value.eligible,
    exclusionReasons: value.exclusionReasons,
    harness: value.harness,
    identity,
    missingData: value.missingData,
    model: value.model,
  };
};

/** Strict re-validation of a qualification crossing a process boundary; `null` when it does not conform. */
const parseQualificationExecutors = (value: unknown): RoutingQualificationExecutors | null => {
  if (!(isRecordValue(value) && hasExactly(value, ['outcome', 'refreshed']))) {
    return null;
  }
  const { outcome, refreshed } = value;
  return isOneOfValues(QUALIFICATION_EXECUTOR_OUTCOMES, outcome) && typeof refreshed === 'boolean'
    ? { outcome, refreshed }
    : null;
};

const parseQualificationRecommendation = (value: unknown): ReviewRecommendation | null => {
  if (!(isRecordValue(value) && hasExactly(value, ['candidateId', 'kind', 'missing']))) {
    return null;
  }
  const { candidateId, kind, missing } = value;
  return (candidateId === null || isQualificationId(candidateId)) &&
    isOneOfValues(RECOMMENDATION_KINDS, kind) &&
    (missing === null || isBoundedQualificationText(missing))
    ? { candidateId, kind, missing }
    : null;
};

/** Strict re-validation of a qualification crossing a process boundary; `null` when it does not conform. */
export const parseRoutingQualification = (value: unknown): RoutingQualification | null => {
  if (
    !(
      isRecordValue(value) &&
      hasExactly(value, [
        'candidates',
        'chosenCandidateId',
        'executors',
        'omittedCandidates',
        'qualifiedAt',
        'reasons',
        'recommendation',
      ]) &&
      serializedBytes(value) <= ROUTING_QUALIFICATION_BOUNDS.maxBytes
    )
  ) {
    return null;
  }
  const { candidates, chosenCandidateId, omittedCandidates, qualifiedAt, reasons } = value;
  const executors = parseQualificationExecutors(value.executors);
  const recommendation = parseQualificationRecommendation(value.recommendation);
  if (
    !(
      Array.isArray(candidates) &&
      candidates.length <= ROUTING_QUALIFICATION_BOUNDS.maxCandidates &&
      (chosenCandidateId === null || isQualificationId(chosenCandidateId)) &&
      executors !== null &&
      typeof omittedCandidates === 'number' &&
      Number.isSafeInteger(omittedCandidates) &&
      omittedCandidates >= 0 &&
      isCanonicalInstant(qualifiedAt) &&
      isQualificationList(reasons) &&
      recommendation !== null
    )
  ) {
    return null;
  }
  const parsed: RoutingQualificationCandidate[] = [];
  for (const entry of candidates) {
    const candidate = parseQualificationCandidate(entry);
    if (candidate === null) {
      return null;
    }
    parsed.push(candidate);
  }
  return {
    candidates: parsed,
    chosenCandidateId,
    executors,
    omittedCandidates,
    qualifiedAt,
    reasons,
    recommendation,
  };
};
