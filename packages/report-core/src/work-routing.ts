import { isCanonicalInstant } from './canonical-instant';
import {
  type ProviderLimitWindow,
  type ProviderStatus,
  parseProviderStatusDataset,
  providerStatusWithFeedFreshness,
} from './provider-status';

export interface ReviewTarget {
  readonly harness: string;
  readonly kind: 'session';
  readonly machineId: string;
  readonly sourceSessionId: string;
}

export interface ReviewRequest {
  readonly action: 'read-only-review';
  readonly minimumQuality: 'review-capable';
  readonly requiredCapabilities: readonly 'read-only-review'[];
  readonly target: ReviewTarget;
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
  readonly machineId: string | null;
  readonly machineLabel: string | null;
  readonly model: string | null;
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

export const MAX_REVIEW_ROUTING_CANDIDATES = 128;
const MAX_NEAR_RESET_MINUTES = 7 * 24 * 60;
const MAX_QUOTA_WINDOWS = 64;
const MAX_ID_LENGTH = 512;

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

/** Observations provide candidates to inspect, never permission or execution qualification. */
export const observedReviewCandidates = (providers: readonly ProviderStatus[]): ReviewCandidate[] => {
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
      const ambiguous = group.length > 1;
      return {
        id: `observed:${key}`,
        machineId: provider.machineId ?? null,
        machineLabel: ambiguous ? null : (provider.machineLabel ?? null),
        accountScope: account,
        harness: family === 'claude' ? 'claude-code' : 'codex',
        model: null,
        effort: null,
        authorization: 'unknown',
        authorizedTarget: null,
        subscription: 'unverified',
        availability: 'unknown',
        capabilities: [],
        quality: 'unknown',
        quota: ambiguous ? null : provider,
        evidence: {
          source: ambiguous ? 'Ambiguous stored quota observations for this scope' : `Stored ${provider.source} quota`,
          observedAt: ambiguous ? null : provider.generatedAt,
        },
      };
    });
};

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
  if (
    window.scope === 'unknown' ||
    (window.scope === 'model' && (!candidate.model || window.group !== candidate.model))
  ) {
    requireEvidence(result, false, `${label} applicability to this model`);
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
  if (!(validId(candidate.accountScope) && validId(scope.account))) {
    requireEvidence(result, false, 'Known account scope for quota attribution');
  } else if (scope.account !== candidate.accountScope) {
    result.excluded.push('Quota account scope does not match the candidate account.');
  }
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
    result.excluded.push('API billing is outside the subscription-only policy.');
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
