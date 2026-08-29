import type { SkillObservationTier } from '@ai-usage/report-core/skill-observation';
import type { SkillObservationHarness, SkillObservations, SkillObservationTally } from '@ai-usage/web-contract/skills';

/**
 * The join between the skills inventory (what exists on disk) and the skill-observation fact family
 * (what the harnesses recorded). It happens here, in the web layer, because `@ai-usage/skills` is a
 * filesystem-projection domain and must not learn to read the usage store (ADR 0022).
 *
 * Everything this module produces is text. Tier and observability are words, never a colour or a
 * position, so the surface reads the same to a screen reader, in a monochrome terminal screenshot,
 * and to somebody who cannot distinguish two of the palette's hues.
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

/**
 * `unmanaged` is the adoption candidate — observed, but resolving to no inventory entry.
 * `never-observed` is the deletion candidate — projected everywhere and never seen.
 */
export type SkillObservationVerdict = 'never-observed' | 'observed' | 'unmanaged';

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

export interface SkillObservationRow {
  harnesses: readonly SkillObservationHarnessCell[];
  lastObservedAt: string | null;
  managed: boolean;
  resolvedPaths: readonly string[];
  skillName: string;
  verdict: SkillObservationVerdict;
}

export interface SkillObservationsView {
  /** Observed, but resolving to no inventory entry: the "invoked but unmanaged" verdict. */
  adoptionCandidates: readonly SkillObservationRow[];
  /** Managed and projected, but never observed by any harness that can observe. */
  deletionCandidates: readonly SkillObservationRow[];
  harnesses: readonly SkillObservationHarness[];
  /** The read hit its bound, so every count below is a lower bound. */
  lowerBound: boolean;
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

const cellFor = (
  harness: SkillObservationHarness,
  tallies: readonly SkillObservationTally[],
): SkillObservationHarnessCell => {
  if (harness.observability === 'not-observable') {
    // No count, ever. A harness that records nothing cannot report a zero, and rendering one would
    // assert that its projected skills go unused.
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

const verdictFor = (managed: boolean, observed: boolean): SkillObservationVerdict => {
  if (!managed) {
    return 'unmanaged';
  }
  return observed ? 'observed' : 'never-observed';
};

export interface BuildSkillObservationsViewInput {
  readonly managedSkillNames: readonly string[];
  readonly observations: SkillObservations;
}

export const buildSkillObservationsView = ({
  managedSkillNames,
  observations,
}: BuildSkillObservationsViewInput): SkillObservationsView => {
  const managed = new Set(managedSkillNames);
  const observedByName = new Map(observations.skills.map((skill) => [skill.skillName, skill]));
  // Every managed skill appears, observed or not: a skill missing from the observation read is the
  // deletion candidate this feature exists to name, and dropping it would erase the verdict.
  const names = [...new Set([...managedSkillNames, ...observedByName.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  const rows = names.map((skillName) => {
    const observed = observedByName.get(skillName);
    const talliesByHarness = new Map<string, SkillObservationTally[]>();
    for (const tally of observed?.tallies ?? []) {
      talliesByHarness.set(tally.harnessKey, [...(talliesByHarness.get(tally.harnessKey) ?? []), tally]);
    }
    return {
      harnesses: observations.harnesses.map((harness) =>
        cellFor(harness, talliesByHarness.get(harness.harnessKey) ?? []),
      ),
      lastObservedAt: observed?.lastObservedAt ?? null,
      managed: managed.has(skillName),
      resolvedPaths: observed?.resolvedPaths ?? [],
      skillName,
      verdict: verdictFor(managed.has(skillName), observed !== undefined),
    } satisfies SkillObservationRow;
  });
  return {
    adoptionCandidates: rows.filter((row) => row.verdict === 'unmanaged'),
    deletionCandidates: rows.filter((row) => row.verdict === 'never-observed'),
    harnesses: observations.harnesses,
    lowerBound: observations.lowerBound,
    rows: [...rows.filter((row) => row.managed), ...rows.filter((row) => !row.managed)],
    skipped: observations.skipped,
  };
};

export const skillObservationRow = (view: SkillObservationsView, skillName: string): SkillObservationRow | undefined =>
  view.rows.find((row) => row.skillName === skillName);
