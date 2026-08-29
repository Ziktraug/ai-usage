import type {
  ObservedSkill,
  SkillObservationHarness,
  SkillObservations,
  SkillObservationTally,
  SkillObservationTier,
  SkillObservationVerdict,
} from '@ai-usage/web-contract/skills';

/**
 * Presentation for the skill-observation surface.
 *
 * This module deliberately does **not** join anything. Managed-ness, projection completeness, and
 * every verdict are decided on the server, where the inventory is (plan 111 decision 3), and arrive
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
  /** Managed, installed in every enabled runtime, and still never invoked: the deletion candidates. */
  deletionCandidates: readonly SkillObservationRow[];
  harnesses: readonly SkillObservationHarness[];
  /**
   * Whether the read can prove an absence at all — which depends on the *invocation* evidence
   * alone, since every absence claim on this surface is a claim about `declared` and `inferred`
   * rows. Exposure is catalogue boilerplate: truncating it costs nothing a verdict rests on.
   */
  invocationEvidenceComplete: boolean;
  /** The read hit its bound, so every count below is a lower bound. */
  lowerBound: boolean;
  /** Offered to a model with no evidence of use, and not already a deletion candidate. */
  offeredOnly: readonly SkillObservationRow[];
  /**
   * The counts are floors but the invocation evidence behind the verdicts is whole — the ordinary
   * state of a store with real Codex history. The surface says which of the two it is rather than
   * flattening both into one hedge.
   */
  onlyExposureTruncated: boolean;
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

/** The two verdicts decided from managed-ness, and therefore the two that can misattribute. */
const MANAGED_DERIVED_VERDICTS: ReadonlySet<SkillObservationVerdict> = new Set(['invoked', 'invoked-unmanaged']);

/**
 * Which installation of a name the detail surface is describing.
 *
 * It matters because observations aggregate by skill *name*, not by install: a harness records the
 * name it was asked for, and only sometimes a resolved directory. So one set of counts covers every
 * installation sharing a name, and a page showing them beside one selected install has to say so.
 */
export type SkillInstallScope = 'global' | 'project';

/**
 * Per-metric provenance for the counts on a per-skill detail, stated in words beside them.
 *
 * The resolved-path list is rendered directly under this sentence, so when a name really does
 * resolve to several directories the reader sees the claim corroborated rather than asserted.
 */
export const NAME_SCOPED_COUNTS_TEXT =
  'These counts are for the skill name, and cover every installation that shares it.';

/**
 * Whether the managed-derived sentences describe the install the page has selected.
 *
 * `managed` is a fact about the *name*: some skill of this name exists in the managed source
 * repository. On a global selection that is the selected install, so the verdict describes it. On a
 * project selection it is a different install — the project copy is not the managed one, whatever
 * the name says — and presenting the managed verdict there states something about the selected item
 * that was decided from somewhere else. On the operator's machine `pr-review` is exactly this: a
 * managed global skill and a project-local skill sharing one name, where the project install would
 * inherit `invoked` from the global one and lose the adoption reading that actually applies to it.
 *
 * A project-only name is unaffected: "this name is nowhere in the managed repository" is a property
 * of the name, so `invoked-unmanaged` remains a sound claim about the project install and the
 * adoption signal survives.
 */
export const managedVerdictDescribesInstall = (
  row: Pick<SkillObservationRow, 'managed'>,
  installScope: SkillInstallScope,
): boolean => installScope === 'global' || !row.managed;

/**
 * What is said instead of a managed-derived verdict when the selected project install shares its
 * name with a managed skill.
 *
 * Naming the collision rather than silently dropping the sentence: an absent verdict reads as
 * "nothing to say", which would hide the one thing the reader most needs to know before acting on
 * these counts.
 */
export const homonymNote = (
  row: Pick<SkillObservationRow, 'managed'>,
  installScope: SkillInstallScope,
): string | undefined =>
  managedVerdictDescribesInstall(row, installScope)
    ? undefined
    : 'A managed skill of this name also exists, so these counts cover both installations and no managed-or-unmanaged verdict is stated for this one.';

/**
 * The verdict sentence for one detail, or nothing when it would describe a different install.
 *
 * Only the managed-derived verdicts are withheld. `offered-only` and `never-observed` are claims
 * about the name's evidence rather than about which repository holds it, so a collision leaves them
 * true and they keep being said.
 */
export const installVerdictText = (
  row: Pick<SkillObservationRow, 'managed' | 'verdict' | 'verdictProvisional'>,
  installScope: SkillInstallScope,
): string | undefined =>
  managedVerdictDescribesInstall(row, installScope) || !MANAGED_DERIVED_VERDICTS.has(row.verdict)
    ? verdictText(row)
    : undefined;

/**
 * What a truncated resolved-path list says about itself.
 *
 * The list is a display aid with a ceiling, and a ceiling that says nothing reads as a complete
 * census — "this skill lives in these eight places" rather than "these are eight of the places it
 * lives". The retained set is the smallest paths in sort order, not the most recent or the most
 * frequent, so the sentence says *shown*, and does not imply a ranking it does not have.
 */
export const resolvedPathsNote = (
  row: Pick<SkillObservationRow, 'resolvedPaths' | 'resolvedPathsTruncated'>,
): string | undefined =>
  row.resolvedPathsTruncated
    ? `Showing ${row.resolvedPaths.length} of more directories this skill resolved to.`
    : undefined;

/**
 * The deletion sentence on the per-skill detail.
 *
 * It is an absence claim like any other verdict, so a bounded or partially unreadable read must
 * qualify it. The absolute wording states a fact the read did not establish — "still never invoked"
 * when the reader stopped at its bound means "not within what we looked at" — and a maintainer
 * acting on it deletes a skill on evidence that was never gathered.
 *
 * "Every *enabled* runtime" because that is the rule the verdict is actually computed with: a
 * disabled target is not a place the skill was expected to be, and the group heading already says
 * so. The two sentences describing one verdict must not describe two different ones.
 */
export const deletionCandidateText = (row: Pick<SkillObservationRow, 'verdictProvisional'>): string =>
  row.verdictProvisional
    ? 'Installed in every enabled runtime, with no invocation within the read bound — a provisional deletion candidate.'
    : 'Installed in every enabled runtime and still never invoked — a deletion candidate.';

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
    invocationEvidenceComplete: !observations.invocationLowerBound && observations.skipped === 0,
    lowerBound: observations.lowerBound,
    onlyExposureTruncated: observations.lowerBound && !(observations.invocationLowerBound || observations.skipped > 0),
    // Exclusive of the deletion group, so no skill is listed twice under two headings.
    offeredOnly: rows.filter((row) => row.verdict === 'offered-only' && !row.deletionCandidate),
    rows: [...rows.filter((row) => row.managed), ...rows.filter((row) => !row.managed)],
    skipped: observations.skipped,
  };
};

export const skillObservationRow = (view: SkillObservationsView, skillName: string): SkillObservationRow | undefined =>
  view.rows.find((row) => row.skillName === skillName);
