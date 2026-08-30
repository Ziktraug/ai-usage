/**
 * Evidence policy for skill observations (ADR 0022).
 *
 * This module owns the facts that decide which claims a consumer can make. The
 * store still owns durable producer/read facts, and the Web server still owns
 * the inventory join; neither needs to duplicate how a tier or a loss affects
 * an invocation-absence claim.
 */

export const SKILL_OBSERVATION_TIERS = ['declared', 'inferred', 'exposed'] as const;

export type SkillObservationTier = (typeof SKILL_OBSERVATION_TIERS)[number];

const TIER_CLAIMS = {
  declared: 'invocation',
  exposed: 'exposure',
  inferred: 'invocation',
} as const satisfies Readonly<Record<SkillObservationTier, 'exposure' | 'invocation'>>;

const TIERS: ReadonlySet<string> = new Set(SKILL_OBSERVATION_TIERS);

export const isSkillObservationTier = (value: unknown): value is SkillObservationTier =>
  typeof value === 'string' && TIERS.has(value);

/** Tiers that can support a claim that a skill was invoked. */
export const SKILL_OBSERVATION_INVOCATION_TIERS: readonly SkillObservationTier[] = SKILL_OBSERVATION_TIERS.filter(
  (tier) => TIER_CLAIMS[tier] === 'invocation',
);

export const skillObservationTierSupportsInvocation = (tier: SkillObservationTier): boolean =>
  TIER_CLAIMS[tier] === 'invocation';

export type SkillObservability = 'observable' | 'not-observable';

/** Harnesses with a skill-observation collector. Cursor is deliberately absent. */
export const SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS = ['claude', 'codex', 'opencode'] as const;

const OBSERVABLE_HARNESSES: ReadonlySet<string> = new Set(SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS);

export const skillObservabilityFor = (harnessKey: string): SkillObservability =>
  OBSERVABLE_HARNESSES.has(harnessKey) ? 'observable' : 'not-observable';

/**
 * The evidence state carried by a folded dataset and by the Web response.
 *
 * `lowerBound` qualifies every count. `invocationLowerBound` is narrower: it
 * says the evidence needed to prove invocation absence is incomplete.
 */
export interface SkillObservationEvidence {
  readonly invocationLowerBound: boolean;
  readonly lowerBound: boolean;
  readonly producerCompletenessMissing: boolean;
  readonly skipped: number;
}

export const COMPLETE_SKILL_OBSERVATION_EVIDENCE: SkillObservationEvidence = Object.freeze({
  invocationLowerBound: false,
  lowerBound: false,
  producerCompletenessMissing: false,
  skipped: 0,
});

/** Refused-row counts split by the claim the row's tier could have supported. */
export interface SkillObservationRefusalCounts {
  readonly exposure: number;
  readonly invocation: number;
  /** The row's tier was unavailable or invalid, so invocation loss cannot be ruled out. */
  readonly unknown: number;
}

/** Raw loss facts produced by collection, the bounded store read, and presentation validation. */
export interface SkillObservationEvidenceFacts {
  readonly collection: {
    readonly exposureIncomplete: boolean;
    readonly invocationIncomplete: boolean;
    readonly producerCompletenessMissing: boolean;
  };
  readonly read: {
    readonly invocationTruncated: boolean;
    readonly truncated: boolean;
  };
  /** One entry per refusal site; the policy owns aggregation as well as interpretation. */
  readonly refusedRows: readonly SkillObservationRefusalCounts[];
}

/**
 * Resolves raw loss facts into the only evidence status downstream modules may
 * use. Invocation and unknown-tier refusals weaken invocation absence; a known
 * exposure refusal weakens only the pooled counts. Missing producer
 * completeness is independently sufficient to make absence provisional, even
 * if an upstream adapter supplied an inconsistent
 * `invocationIncomplete: false`.
 */
export const resolveSkillObservationEvidence = (facts: SkillObservationEvidenceFacts): SkillObservationEvidence => {
  const refused = facts.refusedRows.reduce<SkillObservationRefusalCounts>(
    (total, counts) => ({
      exposure: total.exposure + counts.exposure,
      invocation: total.invocation + counts.invocation,
      unknown: total.unknown + counts.unknown,
    }),
    { exposure: 0, invocation: 0, unknown: 0 },
  );
  const skipped = refused.exposure + refused.invocation + refused.unknown;
  const invocationLowerBound =
    facts.collection.invocationIncomplete ||
    facts.collection.producerCompletenessMissing ||
    facts.read.invocationTruncated ||
    refused.invocation > 0 ||
    refused.unknown > 0;
  return {
    invocationLowerBound,
    lowerBound: invocationLowerBound || facts.collection.exposureIncomplete || facts.read.truncated || skipped > 0,
    producerCompletenessMissing: facts.collection.producerCompletenessMissing,
    skipped,
  };
};

export interface SkillObservationEvidenceLoss {
  /** At least one presented count or roster fact was omitted. */
  readonly counts: boolean;
  /** `declared`/`inferred` evidence was omitted, possibly with a whole skill row. */
  readonly invocation: boolean;
}

/** Applies a later fold/response clamp without erasing loss already reported upstream. */
export const applySkillObservationEvidenceLoss = (
  evidence: SkillObservationEvidence,
  loss: SkillObservationEvidenceLoss,
): SkillObservationEvidence => ({
  invocationLowerBound: evidence.invocationLowerBound || loss.invocation,
  lowerBound: evidence.lowerBound || loss.counts || loss.invocation,
  producerCompletenessMissing: evidence.producerCompletenessMissing,
  skipped: evidence.skipped,
});

export const skillObservationAbsenceIsProvable = (evidence: SkillObservationEvidence): boolean =>
  !evidence.invocationLowerBound;

/** Positive invocation evidence stays conclusive; only an absence claim can be provisional. */
export const skillObservationVerdictIsProvisional = (
  evidence: SkillObservationEvidence,
  invocationObserved: boolean,
): boolean => !(invocationObserved || skillObservationAbsenceIsProvable(evidence));
