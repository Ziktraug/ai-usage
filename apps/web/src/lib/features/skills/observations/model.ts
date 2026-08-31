import type {
  ObservedSkill,
  SkillObservationHarness,
  SkillObservations,
  SkillObservationTally,
  SkillObservationTier,
  SkillObservationVerdict,
  SkillUnmanagedResidence,
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

/**
 * Listed in confidence order — declared, inferred, exposed — because that is the order the surface
 * ranks evidence in, and a legend that enumerates in a different order than the table sorts by
 * teaches the wrong model.
 */
export const SKILL_OBSERVATION_TIER_DESCRIPTIONS: Record<SkillObservationTier, string> = {
  declared: 'The harness recorded the invocation as a skill call.',
  inferred: 'Reconstructed from a weaker trace that was never meant to record an invocation.',
  exposed: 'The skill was offered to the model, with no evidence it was used.',
};

/** Confidence order, strongest first. The legend, the ranking, and the tables all follow it. */
export const SKILL_OBSERVATION_TIER_ORDER: readonly SkillObservationTier[] = ['declared', 'inferred', 'exposed'];

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

/** One sub-group of the adoption backlog: the residence, and its rows in evidence order. */
export interface SkillAdoptionGroup {
  residence: SkillUnmanagedResidence;
  rows: readonly SkillObservationRow[];
}

/**
 * One catalogue of exposed-only names, folded to a single row. A catalogue lists everything, so its
 * entries carry one shared fact — "this catalogue was offered N times" — and rendering each entry as
 * its own row repeats that fact once per entry.
 */
export interface SkillCatalogueRollup {
  /**
   * The exposure counts seen across entries, one phrase per harness: `Codex exposed ×96` when
   * uniform, `Codex exposed ×13–224` when they differ. A range over one tier and one harness,
   * never a sum across either axis.
   */
  exposureSummaries: readonly string[];
  /** The prefix before `:` in the skill names, or `standalone` for unprefixed names. */
  key: string;
  label: string;
  /** Most recent exposure across the catalogue's entries. */
  lastObservedAt: string | null;
  rows: readonly SkillObservationRow[];
}

export interface SkillObservationsView {
  /** Invoked, but resolving to no inventory entry: the adoption candidates. */
  adoptionCandidates: readonly SkillObservationRow[];
  /**
   * The adoption candidates segmented by where the name lives, in a fixed order: runtime-installed
   * (the adoptable backlog), then external (harness- and plugin-provided), then project-owned
   * (deliberately scoped). Three populations, three treatments — one flat list proposed the same
   * action for all of them. Groups with no rows are omitted.
   */
  adoptionGroups: readonly SkillAdoptionGroup[];
  /**
   * Exposed-only unmanaged names folded by catalogue. These rows appear here and nowhere else: a
   * catalogue entry in the main table would outweigh the invocation signal ~2:1 on a real store.
   */
  catalogueEntryCount: number;
  catalogueRollups: readonly SkillCatalogueRollup[];
  /** Managed, installed in every enabled runtime, and without invocation evidence: deletion candidates. */
  deletionCandidates: readonly SkillObservationRow[];
  harnesses: readonly SkillObservationHarness[];
  /**
   * Whether the read can prove an absence at all — which depends on the *invocation* evidence
   * alone, since every absence claim on this surface is a claim about `declared` and `inferred`
   * rows. Exposure is catalogue boilerplate: truncating it costs nothing a verdict rests on.
   */
  invocationEvidenceComplete: boolean;
  /** Whether declared/inferred populations and counts are floors. */
  invocationLowerBound: boolean;
  /**
   * The rows the main table shows: every managed name and every name with invocation evidence,
   * strongest evidence first, then most recent. Exposed-only unmanaged names live in
   * `catalogueRollups` instead.
   */
  invocationRows: readonly SkillObservationRow[];
  /** The read hit its bound, so every count below is a lower bound. */
  lowerBound: boolean;
  /** The roster minus the harnesses that cannot report — the only ones a count column can carry. */
  observableHarnesses: readonly SkillObservationHarness[];
  /** Offered to a model with no evidence of use, and not already a deletion candidate. */
  offeredOnly: readonly SkillObservationRow[];
  /**
   * The counts are floors but the invocation evidence behind the verdicts is whole — the ordinary
   * state of a store with real Codex history. The surface says which of the two it is rather than
   * flattening both into one hedge.
   */
  onlyExposureTruncated: boolean;
  /** At least one expected producer has missing, stale, disabled, or omitted collection state. */
  producerCompletenessMissing: boolean;
  /** Managed skills first, then the unmanaged names, each alphabetically. */
  rows: readonly SkillObservationRow[];
  /** Whether the combined invocation and availability signal history is complete. */
  signalsComplete: boolean;
  /** Persisted rows the reader could not re-validate. */
  skipped: number;
}

export type SkillObservationsPresentationState = 'loading' | 'ready' | 'unavailable';

/** Preserve the distinction between a pending read, a failed read, and a complete empty result. */
export const skillObservationsPresentationState = (
  observations: SkillObservations | undefined,
  errorMessage: string | undefined,
): SkillObservationsPresentationState => {
  if (errorMessage !== undefined) {
    return 'unavailable';
  }
  return observations === undefined ? 'loading' : 'ready';
};

export const NOT_OBSERVABLE_TEXT = 'not observable';
export const NO_SIGNALS_RECORDED_TEXT = 'no signals recorded';
export const NO_SIGNALS_IN_LOADED_HISTORY_TEXT = 'no signals in loaded history';
export const OBSERVATION_ROW_OMITTED_TEXT = 'Omitted from this observation response.';

export const noSignalsText = (signalsComplete: boolean): string =>
  signalsComplete ? NO_SIGNALS_RECORDED_TEXT : NO_SIGNALS_IN_LOADED_HISTORY_TEXT;

/** Render an aggregate retained population without making a bounded response look exact. */
export const formatObservationCount = (count: number, lowerBound: boolean): string =>
  `${lowerBound ? '≥' : ''}${count}`;

/** A bounded response can only identify the latest timestamp it retained, not the true latest one. */
export const observationSignalLabel = (lowerBound: boolean): 'Last signal' | 'Latest retained signal' =>
  lowerBound ? 'Latest retained signal' : 'Last signal';

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
type SkillObservationReadBounds = Pick<SkillObservations, 'invocationLowerBound' | 'lowerBound'>;

const COMPLETE_SKILL_OBSERVATION_READ: SkillObservationReadBounds = {
  invocationLowerBound: false,
  lowerBound: false,
};

const tallyIsLowerBound = (tally: SkillObservationTally, bounds: SkillObservationReadBounds): boolean =>
  tally.tier === 'exposed' ? bounds.lowerBound : bounds.invocationLowerBound;

export const tallySummary = (
  tallies: readonly SkillObservationTally[],
  bounds: SkillObservationReadBounds = COMPLETE_SKILL_OBSERVATION_READ,
): string =>
  tallies
    .map(
      (tally) =>
        `${SKILL_OBSERVATION_TIER_LABELS[tally.tier]} ${tallyIsLowerBound(tally, bounds) ? '≥' : ''}${tally.count}`,
    )
    .join(' · ');

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
  signalsComplete: boolean,
  bounds: SkillObservationReadBounds,
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
      summary: noSignalsText(signalsComplete),
      tallies: [],
    };
  }
  return {
    harnessKey: harness.harnessKey,
    label: harness.label,
    state: 'observed',
    summary: tallySummary(tallies, bounds),
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
export const verdictText = (
  row: Pick<SkillObservationRow, 'verdict' | 'verdictProvisional'> &
    Partial<Pick<SkillObservationRow, 'unmanagedResidence'>>,
): string => {
  if (row.verdict === 'invoked') {
    return 'Invocation evidence from at least one harness.';
  }
  if (row.verdict === 'invoked-unmanaged') {
    // The verdict is one fact — no managed entry carries this name — but the three residences it
    // can have call for three different sentences. Telling a deliberately project-scoped skill it
    // is "an adoption candidate for the source repository" prescribes a move nobody planned.
    if (row.unmanagedResidence === 'project-owned') {
      return 'Invocation evidence — owned by a project repository, outside the shared source. Adopt it only to make it global.';
    }
    if (row.unmanagedResidence === 'external') {
      return 'Invocation evidence, but unmanaged — it ships with a harness or plugin, outside the source repository.';
    }
    return 'Invocation evidence, but unmanaged — an adoption candidate for the source repository.';
  }
  if (row.verdict === 'offered-only') {
    return row.verdictProvisional
      ? 'Available to a model; no invocation in loaded history.'
      : 'Available to a model; no invocation recorded.';
  }
  return row.verdictProvisional
    ? 'No invocation in loaded history; invocation history is incomplete.'
    : 'No skill signal recorded by an observable harness.';
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
    ? `Showing ${row.resolvedPaths.length} directories — the name resolved to more than this list carries.`
    : undefined;

/**
 * The deletion sentence on the per-skill detail.
 *
 * It is an absence claim like any other verdict, so a bounded or partially unreadable read must
 * qualify it. Absolute absence wording states a fact the read did not establish when the reader
 * stopped at its bound — and a maintainer
 * acting on it deletes a skill on evidence that was never gathered.
 *
 * "Every *enabled* runtime" because that is the rule the verdict is actually computed with: a
 * disabled target is not a place the skill was expected to be, and the group heading already says
 * so. The two sentences describing one verdict must not describe two different ones.
 */
export const deletionCandidateText = (row: Pick<SkillObservationRow, 'verdictProvisional'>): string =>
  row.verdictProvisional
    ? 'Installed in every enabled runtime, with no invocation in loaded history — a provisional deletion candidate.'
    : 'Installed in every enabled runtime, with no invocation recorded — a deletion candidate.';

/**
 * How strong the evidence behind a row is: 2 for a declared invocation, 1 for an inferred read,
 * 0 for exposure or nothing. A ranking, not a merge — each tier keeps its own count everywhere.
 */
export const observationEvidenceRank = (row: Pick<ObservedSkill, 'tallies'>): number => {
  if (row.tallies.some((tally) => tally.tier === 'declared')) {
    return 2;
  }
  return row.tallies.some((tally) => tally.tier === 'inferred') ? 1 : 0;
};

/**
 * Strongest evidence first, then most recent, then the name. Alphabetical order made the most used
 * skill on the machine typographically identical to a catalogue entry forty rows away; evidence
 * order is what turns the table back into a ranking a maintainer can act on.
 */
export const compareObservationRows = (left: SkillObservationRow, right: SkillObservationRow): number => {
  const rankDifference = observationEvidenceRank(right) - observationEvidenceRank(left);
  if (rankDifference !== 0) {
    return rankDifference;
  }
  const leftObservedAt = left.lastObservedAt ?? '';
  const rightObservedAt = right.lastObservedAt ?? '';
  if (leftObservedAt !== rightObservedAt) {
    return rightObservedAt.localeCompare(leftObservedAt);
  }
  return left.skillName.localeCompare(right.skillName);
};

/** One canonical tier-and-harness summary for every joined inventory surface. */
export const observedHarnessSummary = (row: Pick<SkillObservationRow, 'harnesses'>): string =>
  row.harnesses
    .filter((cell) => cell.state === 'observed')
    .map((cell) => `${cell.label} ${cell.summary}`)
    .join(' · ');

/** Fixed presentation order: the actionable backlog first, the informational populations after. */
const ADOPTION_GROUP_ORDER: readonly SkillUnmanagedResidence[] = ['runtime-installed', 'external', 'project-owned'];

const buildAdoptionGroups = (adoptionCandidates: readonly SkillObservationRow[]): readonly SkillAdoptionGroup[] =>
  ADOPTION_GROUP_ORDER.flatMap((residence) => {
    // A row the join could not classify would only exist through a producer bug; treating it as
    // external keeps it visible rather than dropping the adoption signal on the floor.
    const rows = adoptionCandidates
      .filter((row) => (row.unmanagedResidence ?? 'external') === residence)
      .toSorted(compareObservationRows);
    return rows.length === 0 ? [] : [{ residence, rows }];
  });

/** The catalogue a plugin-namespaced name belongs to, or `standalone` for a bare name. */
const catalogueKeyFor = (skillName: string): string => {
  const separatorIndex = skillName.indexOf(':');
  return separatorIndex > 0 ? skillName.slice(0, separatorIndex) : 'standalone';
};

const exposureSummariesFor = (rows: readonly SkillObservationRow[], exposureLowerBound: boolean): readonly string[] => {
  const countsByHarness = new Map<string, { counts: number[]; label: string }>();
  for (const tally of rows.flatMap((row) => row.tallies.filter((candidate) => candidate.tier === 'exposed'))) {
    const current = countsByHarness.get(tally.harnessKey) ?? { counts: [], label: tally.harnessLabel };
    current.counts.push(tally.count);
    countsByHarness.set(tally.harnessKey, current);
  }
  return [...countsByHarness.values()]
    .toSorted((left, right) => left.label.localeCompare(right.label))
    .map(({ counts, label }) => {
      const sortedCounts = counts.toSorted((left, right) => left - right);
      const lowest = sortedCounts.at(0);
      const highest = sortedCounts.at(-1);
      const lowerBoundMark = exposureLowerBound ? '≥' : '';
      // A range over one tier and harness — the spread of per-entry exposure counts — never a sum.
      return lowest === highest
        ? `${label} exposed ×${lowerBoundMark}${lowest}`
        : `${label} exposed ×${lowerBoundMark}${lowest}–${lowerBoundMark}${highest}`;
    });
};

const buildCatalogueRollups = (
  exposedOnly: readonly SkillObservationRow[],
  exposureLowerBound: boolean,
): readonly SkillCatalogueRollup[] => {
  const rollups = new Map<string, SkillObservationRow[]>();
  for (const row of exposedOnly) {
    const key = catalogueKeyFor(row.skillName);
    rollups.set(key, [...(rollups.get(key) ?? []), row]);
  }
  return [...rollups.entries()]
    .map(([key, rows]) => ({
      exposureSummaries: exposureSummariesFor(rows, exposureLowerBound),
      key,
      label: key === 'standalone' ? 'Standalone entries' : key,
      lastObservedAt: rows.reduce<string | null>(
        (latest, row) =>
          row.lastObservedAt !== null && row.lastObservedAt > (latest ?? '') ? row.lastObservedAt : latest,
        null,
      ),
      rows: rows.toSorted((left, right) => left.skillName.localeCompare(right.skillName)),
    }))
    .toSorted((left, right) => right.rows.length - left.rows.length || left.label.localeCompare(right.label));
};

/** `2026-08-09`, for table cells where the full instant would push the column off screen. */
export const formatObservedDate = (isoTimestamp: string): string => {
  const formatted = formatObservedAt(isoTimestamp);
  return formatted.includes(' ') ? (formatted.split(' ').at(0) ?? formatted) : formatted;
};

export type SkillObservationRecency = 'aging' | 'fresh' | 'stale';

const UTC_DAY_MS = 86_400_000;

/**
 * Freshness bucket for a last-observed instant: `fresh` under 30 UTC days, `aging` under 90,
 * `stale` beyond. Computed from whole UTC days so a server paint and its hydration agree except
 * across a midnight boundary — the same tolerance `formatObservedAt` already accepts.
 */
export const observationRecency = (isoTimestamp: string, now: Date = new Date()): SkillObservationRecency => {
  const observed = new Date(isoTimestamp);
  if (!Number.isFinite(observed.getTime())) {
    return 'fresh';
  }
  const observedDate = Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth(), observed.getUTCDate());
  const currentDate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const elapsedDays = Math.floor((currentDate - observedDate) / UTC_DAY_MS);
  if (elapsedDays > 90) {
    return 'stale';
  }
  return elapsedDays >= 30 ? 'aging' : 'fresh';
};

/** The textual marker beside a stale date — recency is words first, tone second. */
export const observationRecencyNote = (isoTimestamp: string, now: Date = new Date()): string | undefined =>
  observationRecency(isoTimestamp, now) === 'stale' ? 'stale' : undefined;

export const ADOPTION_GROUP_COPY: Record<SkillUnmanagedResidence, { heading: string; description: string }> = {
  external: {
    description:
      'Ships with a harness or one of its plugins — it lives upstream. Re-create it in the source repository only to own a fork of it.',
    heading: 'Ships with a harness or plugin',
  },
  'project-owned': {
    description:
      'Owned by a project repository and observed in place — deliberately scoped, not missing. Adopt one only to make it global.',
    heading: 'Owned by a project repository',
  },
  'runtime-installed': {
    description:
      'Installed directly in a runtime skills directory, outside any source repository. This is the adoptable backlog.',
    heading: 'Installed in runtime directories',
  },
};

export const buildSkillObservationsView = (observations: SkillObservations): SkillObservationsView => {
  const signalsComplete = !observations.lowerBound;
  const rows = observations.skills.map((skill) => {
    const talliesByHarness = new Map<string, SkillObservationTally[]>();
    for (const tally of skill.tallies) {
      talliesByHarness.set(tally.harnessKey, [...(talliesByHarness.get(tally.harnessKey) ?? []), tally]);
    }
    return {
      ...skill,
      harnesses: observations.harnesses.map((harness) =>
        cellFor(harness, talliesByHarness.get(harness.harnessKey) ?? [], signalsComplete, observations),
      ),
    } satisfies SkillObservationRow;
  });
  const adoptionCandidates = rows.filter((row) => row.verdict === 'invoked-unmanaged');
  const offeredOnly = rows.filter((row) => row.verdict === 'offered-only' && !row.deletionCandidate);
  const catalogueRollups = buildCatalogueRollups(
    offeredOnly.filter((row) => !row.managed),
    observations.lowerBound,
  );
  return {
    adoptionCandidates,
    adoptionGroups: buildAdoptionGroups(adoptionCandidates),
    catalogueEntryCount: catalogueRollups.reduce((count, rollup) => count + rollup.rows.length, 0),
    catalogueRollups,
    deletionCandidates: rows.filter((row) => row.deletionCandidate),
    harnesses: observations.harnesses,
    invocationLowerBound: observations.invocationLowerBound,
    invocationEvidenceComplete: !observations.invocationLowerBound,
    invocationRows: rows
      .filter((row) => row.managed || observationEvidenceRank(row) > 0)
      .toSorted(compareObservationRows),
    lowerBound: observations.lowerBound,
    observableHarnesses: observations.harnesses.filter((harness) => harness.observability === 'observable'),
    onlyExposureTruncated: observations.lowerBound && !observations.invocationLowerBound,
    producerCompletenessMissing: observations.producerCompletenessMissing,
    // Exclusive of the deletion group, so no skill is listed twice under two headings.
    offeredOnly,
    rows: [...rows.filter((row) => row.managed), ...rows.filter((row) => !row.managed)],
    signalsComplete,
    skipped: observations.skipped,
  };
};

export const skillObservationRow = (view: SkillObservationsView, skillName: string): SkillObservationRow | undefined =>
  view.rows.find((row) => row.skillName === skillName);
