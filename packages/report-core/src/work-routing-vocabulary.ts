import { isCanonicalInstant } from './canonical-instant';
import type { ExecutorHarness } from './work-executors';

/**
 * The routing qualification as it crosses a process boundary (ADR 0057): the account fingerprint
 * shape, the identity states, the bounded decision and its strict parser, in a module whose only
 * import is the import-free canonical instant check. The usage-engine control contract parses the
 * `qualify-review-routing` completion and sits in the browser's first-load closure; reading the
 * parser from here keeps the routing policy and the executor parser out of that closure (the way
 * `work-attempts-vocabulary.ts` does for attempts). `work-routing.ts` and `work-executors.ts`
 * re-export what they share with it; this file must import nothing else at run time.
 */

/** `accountFingerprint`: lowercase hexadecimal characters of the truncated SHA-256 (ADR 0057). */
export const ACCOUNT_FINGERPRINT_LENGTH = 16;

const ACCOUNT_FINGERPRINT_PATTERN = new RegExp(`^[0-9a-f]{${ACCOUNT_FINGERPRINT_LENGTH}}$`, 'u');

/** Exactly the collector's format: lowercase hexadecimal of the documented length. */
export const isExecutorAccountFingerprint = (value: unknown): value is string =>
  typeof value === 'string' && ACCOUNT_FINGERPRINT_PATTERN.test(value);

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

export const CANDIDATE_IDENTITY_STATES = [
  'confirmed',
  'contradicted',
  'not-observable',
  'unobserved',
  'unpinned',
] as const satisfies readonly CandidateIdentityState[];

export type RecommendationKind = 'real' | 'conditional' | 'none';

export interface ReviewRecommendation {
  readonly candidateId: string | null;
  readonly kind: RecommendationKind;
  /** For `conditional`: the one named observation whose absence or staleness blocks the candidate. */
  readonly missing: string | null;
}

/** Longest id (candidate, account scope) the routing accepts. */
const MAX_ID_LENGTH = 512;

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

/** The identity of a candidate as transported: the pin and the observation, without provenance. */
export interface RoutingQualificationIdentity {
  /** `routing.executors[].accountFingerprint`; always a declaration, never shown as observed. */
  readonly declared: string | null;
  /** The latest observed fingerprint; `null` when none was reported. */
  readonly observed: string | null;
  readonly observedAt: string | null;
  readonly state: CandidateIdentityState;
}

export interface RoutingQualificationCandidate {
  readonly accountScope: string | null;
  /** The qualification actions of the candidate: what to declare, observe or refresh. */
  readonly actions: readonly string[];
  readonly candidateId: string;
  readonly eligible: boolean;
  readonly exclusionReasons: readonly string[];
  readonly harness: ExecutorHarness;
  /** Per-field provenance is kept: `declared` is the pin, `observed` the engine's observation. */
  readonly identity: RoutingQualificationIdentity | null;
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

/** A routing id: non-blank and within `ROUTING_QUALIFICATION_BOUNDS.maxId`. */
export const isRoutingId = (value: string | null): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;

/** The serialized UTF-8 size the `maxBytes` bound is judged on. */
export const serializedQualificationBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const isBoundedQualificationText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= ROUTING_QUALIFICATION_BOUNDS.maxText;
const isQualificationList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= ROUTING_QUALIFICATION_BOUNDS.maxEntries &&
  value.every(isBoundedQualificationText);
const isQualificationId = (value: unknown): value is string => typeof value === 'string' && isRoutingId(value);
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
      serializedQualificationBytes(value) <= ROUTING_QUALIFICATION_BOUNDS.maxBytes
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
