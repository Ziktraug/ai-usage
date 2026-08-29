import type {
  ObservedSkill,
  SkillObservationHarness,
  SkillObservations,
  SkillObservationTally,
  SkillObservationTier,
} from '@ai-usage/web-contract/skills';

/**
 * Presentation for the skill-observation surface.
 *
 * This module deliberately does **not** join anything. Managed-ness, projection completeness, and
 * every verdict are decided on the server, where the inventory is (plan 099 decision 3), and arrive
 * as facts. What is left here is turning those facts into words — a step that needs no inventory
 * data and therefore belongs in the browser.
 *
 * Everything it produces is text. Tier and observability are words, never a colour or a position,
 * so the surface reads the same to a screen reader, in a monochrome screenshot, and to somebody who
 * cannot distinguish two of the palette's hues.
 */

export const SKILL_OBSERVATION_TIER_LABELS: Record<SkillObservationTier, string> = {
  declared: 'declared',
  exposed: 'exposed',
  inferred: 'inferred',
};

export const SKILL_OBSERVATION_TIER_DESCRIPTIONS: Record<SkillObservationTier, string> = {
  declared: 'The harness recorded the invocation as a skill call.',
  exposed: 'The skill was offered to the model, with no evidence it was used.',
  inferred: 'Reconstructed from a weaker trace that was never meant to record an invocation.',
};

export type SkillObservationHarnessState = 'no-observations' | 'not-observable' | 'observed';

export interface SkillObservationHarnessCell {
  harnessKey: string;
  label: string;
  state: SkillObservationHarnessState;
  /**
   * The rendered text for this harness. For an observed harness it lists one phrase per tier —
   * `declared 3`, `inferred 1` — and never joins them into a total.
   */
  summary: string;
  tallies: readonly SkillObservationTally[];
}

export interface SkillObservationRow extends ObservedSkill {
  harnesses: readonly SkillObservationHarnessCell[];
}

export interface SkillObservationsView {
  /** Invoked, but resolving to no inventory entry: the adoption candidates. */
  adoptionCandidates: readonly SkillObservationRow[];
  /** Managed, installed in every runtime, and still never invoked: the deletion candidates. */
  deletionCandidates: readonly SkillObservationRow[];
  harnesses: readonly SkillObservationHarness[];
  /** The read hit its bound, so every count below is a lower bound. */
  lowerBound: boolean;
  /** Whether the read can prove an absence at all. */
  observationsComplete: boolean;
  /** Offered to a model with no evidence of use, and not already a deletion candidate. */
  offeredOnly: readonly SkillObservationRow[];
  /** Managed skills first, then the unmanaged names, each alphabetically. */
  rows: readonly SkillObservationRow[];
  /** Persisted rows the reader could not re-validate. */
  skipped: number;
}

export const NOT_OBSERVABLE_TEXT = 'not observable';
export const NO_OBSERVATIONS_TEXT = 'none observed';

/**
 * `2026-08-01 09:07 UTC`, from a canonical ISO instant.
 *
 * Deliberately timezone- and locale-independent: this renders identically on the server and in the
 * browser, so an SSR paint and its hydration cannot disagree, and the string means the same thing
 * to a reader in any timezone. The exact instant stays available in the element's `datetime`.
 */
export const formatObservedAt = (isoTimestamp: string): string => {
  const instant = new Date(isoTimestamp);
  if (!Number.isFinite(instant.getTime())) {
    return isoTimestamp;
  }
  const [date, time] = instant.toISOString().split('T');
  return `${date} ${(time ?? '').slice(0, 5)} UTC`;
};

/**
 * One phrase per tier, joined by a separator that is not arithmetic. `declared 3 · inferred 1`
 * states two facts; `4` would state a third that is not true of anything.
 */
export const tallySummary = (tallies: readonly SkillObservationTally[]): string =>
  tallies.map((tally) => `${SKILL_OBSERVATION_TIER_LABELS[tally.tier]} ${tally.count}`).join(' · ');

/**
 * What one skill's row says about one harness.
 *
 * The `not-observable` branch comes first and returns before any count is considered, so there is
 * no path on which a harness that cannot report renders a number — including the case where the
 * store somehow holds rows under its key.
 */
const cellFor = (
  harness: SkillObservationHarness,
  tallies: readonly SkillObservationTally[],
): SkillObservationHarnessCell => {
  if (harness.observability === 'not-observable') {
    return {
      harnessKey: harness.harnessKey,
      label: harness.label,
      state: 'not-observable',
      summary: NOT_OBSERVABLE_TEXT,
      tallies: [],
    };
  }
  if (tallies.length === 0) {
    return {
      harnessKey: harness.harnessKey,
      label: harness.label,
      state: 'no-observations',
      summary: NO_OBSERVATIONS_TEXT,
      tallies: [],
    };
  }
  return {
    harnessKey: harness.harnessKey,
    label: harness.label,
    state: 'observed',
    summary: tallySummary(tallies),
    tallies,
  };
};

/**
 * The sentence a verdict becomes.
 *
 * A provisional verdict is one that claims an absence the read could not establish — the read was
 * bounded, or rows failed re-validation. It says what it actually knows ("no ... within the read
 * bound") rather than repeating a claim it cannot support.
 */
export const verdictText = (row: Pick<SkillObservationRow, 'verdict' | 'verdictProvisional'>): string => {
  if (row.verdict === 'invoked') {
    return 'Invoked in at least one harness.';
  }
  if (row.verdict === 'invoked-unmanaged') {
    return 'Invoked but unmanaged — an adoption candidate for the source repository.';
  }
  if (row.verdict === 'offered-only') {
    return row.verdictProvisional
      ? 'Offered to a model; no invocation within the read bound.'
      : 'Offered to a model, with no evidence it was ever invoked.';
  }
  return row.verdictProvisional ? 'No observation within the read bound.' : 'Never observed by any harness.';
};

export const buildSkillObservationsView = (observations: SkillObservations): SkillObservationsView => {
  const rows = observations.skills.map((skill) => {
    const talliesByHarness = new Map<string, SkillObservationTally[]>();
    for (const tally of skill.tallies) {
      talliesByHarness.set(tally.harnessKey, [...(talliesByHarness.get(tally.harnessKey) ?? []), tally]);
    }
    return {
      ...skill,
      harnesses: observations.harnesses.map((harness) =>
        cellFor(harness, talliesByHarness.get(harness.harnessKey) ?? []),
      ),
    } satisfies SkillObservationRow;
  });
  return {
    adoptionCandidates: rows.filter((row) => row.verdict === 'invoked-unmanaged'),
    deletionCandidates: rows.filter((row) => row.deletionCandidate),
    harnesses: observations.harnesses,
    lowerBound: observations.lowerBound,
    observationsComplete: !observations.lowerBound && observations.skipped === 0,
    // Exclusive of the deletion group, so no skill is listed twice under two headings.
    offeredOnly: rows.filter((row) => row.verdict === 'offered-only' && !row.deletionCandidate),
    rows: [...rows.filter((row) => row.managed), ...rows.filter((row) => !row.managed)],
    skipped: observations.skipped,
  };
};

export const skillObservationRow = (view: SkillObservationsView, skillName: string): SkillObservationRow | undefined =>
  view.rows.find((row) => row.skillName === skillName);
