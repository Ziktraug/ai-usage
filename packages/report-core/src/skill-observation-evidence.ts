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

/** Maximum age at which a producer answer may still underwrite an absence claim. */
export const SKILL_OBSERVATION_PRODUCER_MAX_AGE_MS = 5 * 60 * 1000;
/**
 * Active browser revalidation cadence for the time-bounded producer proof.
 * The engine normally sweeps once per minute, so this also picks up a completed
 * sweep promptly when publication invalidation is unavailable.
 */
export const SKILL_OBSERVATION_PRODUCER_REVALIDATION_MS = 60 * 1000;
/**
 * Oldest producer answer a new server read accepts. The remaining minute is
 * reserved for browser caching, so a response cannot extend a five-minute
 * producer proof with a second five-minute cache window.
 */
export const SKILL_OBSERVATION_PRODUCER_READ_MAX_AGE_MS =
  SKILL_OBSERVATION_PRODUCER_MAX_AGE_MS - SKILL_OBSERVATION_PRODUCER_REVALIDATION_MS;

const OBSERVABLE_HARNESSES: ReadonlySet<string> = new Set(SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS);

export const skillObservabilityFor = (harnessKey: string): SkillObservability =>
  OBSERVABLE_HARNESSES.has(harnessKey) ? 'observable' : 'not-observable';

/**
 * Which harnesses an incompleteness belongs to, per channel.
 *
 * A count on this surface always belongs to exactly one harness (ADR 0022: a count cannot exist
 * without its tier and its harness), so hedging Claude Code's fully-collected invocations because
 * Codex rejected one line states an uncertainty that does not exist. This is the per-metric
 * provenance ADR 0022 decision 4 asks for, made structural.
 *
 * The unattributed flags are the fail-closed half. Some losses genuinely cannot be blamed on a
 * harness — a bounded read that stopped mid-history could have dropped any harness's rows, and a
 * refusal count does not carry the harness whose row it refused. Those set the flag, and the flag
 * means *every* harness is a floor. A producer that reports a loss without naming a harness is
 * therefore read as an unattributed loss, never as no loss at all.
 */
export interface SkillObservationHarnessIncompleteness {
  /** Harnesses whose exposure evidence is known incomplete. */
  readonly exposure: readonly string[];
  /** An exposure/pooled loss no harness could be blamed for; it hedges every harness. */
  readonly exposureUnattributed: boolean;
  /** Harnesses whose `declared`/`inferred` evidence is known incomplete. */
  readonly invocation: readonly string[];
  /** An invocation loss no harness could be blamed for; it hedges every harness. */
  readonly invocationUnattributed: boolean;
}

export const COMPLETE_SKILL_OBSERVATION_HARNESS_INCOMPLETENESS: SkillObservationHarnessIncompleteness = Object.freeze({
  exposure: Object.freeze([]) as readonly string[],
  exposureUnattributed: false,
  invocation: Object.freeze([]) as readonly string[],
  invocationUnattributed: false,
});

/**
 * The evidence state carried by a folded dataset and by the Web response.
 *
 * `lowerBound` qualifies every count. `invocationLowerBound` is narrower: it
 * says the evidence needed to prove invocation absence is incomplete.
 *
 * Both stay **global**, and every cross-harness claim keeps using them —
 * "not invoked in any observable harness" cannot be proved while any harness's
 * invocation evidence is short. `harnessIncompleteness` is the finer answer,
 * and it is only sound for a statement that already belongs to one harness.
 */
export interface SkillObservationEvidence {
  /** Per-harness detail behind the two global booleans; see the type's own doc comment. */
  readonly harnessIncompleteness: SkillObservationHarnessIncompleteness;
  readonly invocationLowerBound: boolean;
  readonly lowerBound: boolean;
  /** At least one expected producer lacks usable current state; rejection/truncation stay separate. */
  readonly producerCompletenessMissing: boolean;
  readonly skipped: number;
}

export const COMPLETE_SKILL_OBSERVATION_EVIDENCE: SkillObservationEvidence = Object.freeze({
  harnessIncompleteness: COMPLETE_SKILL_OBSERVATION_HARNESS_INCOMPLETENESS,
  invocationLowerBound: false,
  lowerBound: false,
  producerCompletenessMissing: false,
  skipped: 0,
});

const sortedUnique = (keys: readonly string[]): readonly string[] => [...new Set(keys)].sort();

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
    /**
     * The harnesses the exposure incompleteness belongs to. Omitting it while reporting
     * `exposureIncomplete` is read as an unattributed loss — every harness is hedged — because a
     * loss nobody owns is not a loss that did not happen.
     */
    readonly exposureIncompleteHarnessKeys?: readonly string[];
    readonly invocationIncomplete: boolean;
    /** The harnesses the invocation incompleteness belongs to; see the exposure field. */
    readonly invocationIncompleteHarnessKeys?: readonly string[];
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
  const invocationHarnessKeys = sortedUnique(facts.collection.invocationIncompleteHarnessKeys ?? []);
  const exposureHarnessKeys = sortedUnique(facts.collection.exposureIncompleteHarnessKeys ?? []);
  // A bounded read stops somewhere in a recency-ordered stream, so the rows past the bound could
  // have belonged to any harness; a refusal count records how many rows failed re-validation, not
  // whose they were. Neither can name a harness, so both hedge all of them.
  const invocationUnattributed =
    facts.read.invocationTruncated ||
    refused.invocation > 0 ||
    refused.unknown > 0 ||
    ((facts.collection.invocationIncomplete || facts.collection.producerCompletenessMissing) &&
      invocationHarnessKeys.length === 0);
  const exposureUnattributed =
    facts.read.truncated ||
    refused.exposure > 0 ||
    (facts.collection.exposureIncomplete && exposureHarnessKeys.length === 0);
  const invocationLowerBound = invocationUnattributed || invocationHarnessKeys.length > 0;
  return {
    harnessIncompleteness: {
      exposure: exposureHarnessKeys,
      exposureUnattributed,
      invocation: invocationHarnessKeys,
      invocationUnattributed,
    },
    invocationLowerBound,
    lowerBound: invocationLowerBound || exposureUnattributed || exposureHarnessKeys.length > 0,
    producerCompletenessMissing: facts.collection.producerCompletenessMissing,
    skipped,
  };
};

export interface SkillObservationEvidenceLoss {
  /** At least one presented count or roster fact was omitted. */
  readonly counts: boolean;
  /**
   * Every harness that carried a dropped row.
   *
   * The conservative reading, deliberately: a clamp drops whole rows rather than one tier of one
   * harness, so every harness present in a dropped row is marked on the channel that was degraded,
   * even where its own tallies in that row were exposure-only. Over-hedging one harness is a
   * smaller error than telling a reader a count is exact when its row was thrown away. An empty
   * list beside a reported loss is read as unattributable and hedges every harness.
   */
  readonly harnessKeys?: readonly string[];
  /** `declared`/`inferred` evidence was omitted, possibly with a whole skill row. */
  readonly invocation: boolean;
}

/** Applies a later fold/response clamp without erasing loss already reported upstream. */
export const applySkillObservationEvidenceLoss = (
  evidence: SkillObservationEvidence,
  loss: SkillObservationEvidenceLoss,
): SkillObservationEvidence => {
  const droppedHarnessKeys = loss.harnessKeys ?? [];
  const attributable = droppedHarnessKeys.length > 0;
  const incompleteness = evidence.harnessIncompleteness;
  const countsLost = loss.counts || loss.invocation;
  return {
    harnessIncompleteness: {
      exposure:
        countsLost && attributable
          ? sortedUnique([...incompleteness.exposure, ...droppedHarnessKeys])
          : incompleteness.exposure,
      exposureUnattributed: incompleteness.exposureUnattributed || (countsLost && !attributable),
      invocation:
        loss.invocation && attributable
          ? sortedUnique([...incompleteness.invocation, ...droppedHarnessKeys])
          : incompleteness.invocation,
      invocationUnattributed: incompleteness.invocationUnattributed || (loss.invocation && !attributable),
    },
    invocationLowerBound: evidence.invocationLowerBound || loss.invocation,
    lowerBound: evidence.lowerBound || countsLost,
    producerCompletenessMissing: evidence.producerCompletenessMissing,
    skipped: evidence.skipped,
  };
};

/**
 * Whether one harness's own `declared`/`inferred` counts are exact.
 *
 * This is the question a rendered per-harness number asks, and it is **not** the question a
 * cross-harness verdict asks. `deletionCandidate`, `never-observed` and `offered-only` claim a
 * skill was not invoked in *any* observable harness, so they keep using the global
 * `invocationLowerBound`: one harness's short evidence is enough to make that claim unprovable.
 * Unifying the two would silently turn an unprovable absence into a stated fact.
 */
export const skillObservationHarnessInvocationIsComplete = (
  evidence: Pick<SkillObservationEvidence, 'harnessIncompleteness'>,
  harnessKey: string,
): boolean =>
  !(
    evidence.harnessIncompleteness.invocationUnattributed ||
    evidence.harnessIncompleteness.invocation.includes(harnessKey)
  );

/**
 * Whether one harness's signal history is complete across every tier — the per-harness form of
 * `lowerBound`, and therefore the right input for "no signal recorded for X".
 *
 * Invocation loss counts here too: the pooled bound has always included it, and a harness missing
 * invocation rows has not recorded every signal it produced.
 */
export const skillObservationHarnessSignalsAreComplete = (
  evidence: Pick<SkillObservationEvidence, 'harnessIncompleteness'>,
  harnessKey: string,
): boolean =>
  skillObservationHarnessInvocationIsComplete(evidence, harnessKey) &&
  !(
    evidence.harnessIncompleteness.exposureUnattributed || evidence.harnessIncompleteness.exposure.includes(harnessKey)
  );

export const skillObservationAbsenceIsProvable = (evidence: SkillObservationEvidence): boolean =>
  !evidence.invocationLowerBound;

/** Positive invocation evidence stays conclusive; only an absence claim can be provisional. */
export const skillObservationVerdictIsProvisional = (
  evidence: SkillObservationEvidence,
  invocationObserved: boolean,
): boolean => !(invocationObserved || skillObservationAbsenceIsProvable(evidence));
