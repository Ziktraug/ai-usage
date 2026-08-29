import { HARNESS_METADATA, harnessKeys } from './harness-metadata';
import {
  SKILL_OBSERVATION_TIERS,
  type SkillObservability,
  type SkillObservation,
  type SkillObservationTier,
  skillObservabilityFor,
} from './skill-observation';

/**
 * The presented shape of the skill-observation fact family: what every consumer
 * of ADR 0022 is allowed to render.
 *
 * Two properties are the whole point of this module, and both are structural
 * rather than advisory:
 *
 * - **A count cannot exist without its tier and its harness.** There is no
 *   per-skill total here, and no per-harness total either. The smallest thing
 *   this module can hand a caller is a `SkillObservationTally`, which carries
 *   both. A consumer that wants "how many times was this used" has to pick a
 *   tier and a harness first, which is the friction ADR 0022 asks for.
 * - **Harness coverage is enumerated, not inferred from the data.** Every
 *   harness this product knows about appears in `harnesses` with its
 *   observability, whether or not it contributed a single observation. A
 *   harness that cannot report is therefore visible as `not-observable` rather
 *   than as an absence a renderer would be free to draw as `0`.
 */

/**
 * Distinct resolved directories kept per skill; a display aid, not a census.
 *
 * When a skill resolves to more than this, the retained set is the
 * lexicographically **smallest** paths, not the first ones seen. That rule is
 * what keeps the fold order-independent: "first eight" makes the retained set a
 * function of the order the reader happened to return rows in, so the same
 * store could render two different path lists. The bound is applied while
 * accumulating rather than at the end, so a skill observed thousands of times
 * never holds thousands of paths in memory to throw all but eight away.
 */
const MAX_RESOLVED_PATHS_PER_SKILL = 8;

const TIER_ORDER: ReadonlyMap<SkillObservationTier, number> = new Map(
  SKILL_OBSERVATION_TIERS.map((tier, index) => [tier, index]),
);

const HARNESS_ORDER: ReadonlyMap<string, number> = new Map(harnessKeys.map((key, index) => [key, index]));

/** One count, inseparable from the tier and the harness that produced it. */
export interface SkillObservationTally {
  count: number;
  harnessKey: string;
  harnessLabel: string;
  /** The most recent observation behind this count. */
  lastObservedAt: string;
  tier: SkillObservationTier;
}

export interface SkillObservationSummary {
  /** The most recent observation of this skill across every tier and harness. */
  lastObservedAt: string;
  /**
   * Distinct on-disk directories the harnesses disclosed for this skill. Empty
   * is a state, not a gap: harness-bundled and plugin skills resolve to nothing
   * and are exactly the "invoked but unmanaged" population (ADR 0022).
   */
  resolvedPaths: readonly string[];
  /** The skill name exactly as the harness wrote it, before any resolution. */
  skillName: string;
  tallies: readonly SkillObservationTally[];
}

export interface SkillObservationHarnessCoverage {
  harnessKey: string;
  label: string;
  observability: SkillObservability;
}

export interface SkillObservationDataset {
  /**
   * Every harness, including the ones with no collector. Derived from the
   * harness catalogue rather than from what this read returned, so a failed
   * sweep of an observable harness never demotes it to `not-observable`.
   */
  harnesses: readonly SkillObservationHarnessCoverage[];
  /**
   * The bounded read stopped short, so every count below is a lower bound
   * rather than a number. Reported one past the bound by the reader, because a
   * list that stops exactly at the limit is indistinguishable from a complete
   * one.
   */
  lowerBound: boolean;
  skills: readonly SkillObservationSummary[];
  /** Persisted rows the reader could not re-validate. Counted, never hidden. */
  skipped: number;
}

interface TallyAccumulator {
  count: number;
  harnessKey: string;
  lastObservedAt: string;
  tier: SkillObservationTier;
}

interface SkillAccumulator {
  lastObservedAt: string;
  resolvedPaths: Set<string>;
  skillName: string;
  tallies: Map<string, TallyAccumulator>;
}

const harnessLabelFor = (harnessKey: string): string =>
  Object.hasOwn(HARNESS_METADATA, harnessKey)
    ? HARNESS_METADATA[harnessKey as keyof typeof HARNESS_METADATA].label
    : harnessKey;

const harnessRank = (harnessKey: string): number => HARNESS_ORDER.get(harnessKey) ?? HARNESS_ORDER.size;

const tierRank = (tier: SkillObservationTier): number => TIER_ORDER.get(tier) ?? TIER_ORDER.size;

const later = (left: string, right: string): string => (right > left ? right : left);

/**
 * Keeps the `maximum` smallest paths, by the same ordering the output is sorted
 * with. Adding then evicting the largest is order-independent by construction:
 * whatever sequence the paths arrive in, the survivors are the same set.
 */
const retainSmallestPath = (paths: Set<string>, candidate: string, maximum: number): void => {
  if (paths.has(candidate)) {
    return;
  }
  paths.add(candidate);
  if (paths.size <= maximum) {
    return;
  }
  const largest = [...paths].sort().at(-1);
  if (largest !== undefined) {
    paths.delete(largest);
  }
};

/**
 * Observability for one harness key.
 *
 * For a key in the catalogue this is `skillObservabilityFor`: the marker is a property of the
 * harness, so a sweep that happened to return nothing never demotes an observable harness.
 *
 * For a key this build does not know, there is no harness definition to derive a marker from, and
 * the only fact available is that the store holds observations under it. Calling that
 * `not-observable` would assert the opposite of the evidence in hand and would make the renderer
 * suppress real history, so evidence decides: a key that produced observations is `observable`.
 * An unknown key with no observations cannot appear here at all.
 */
const observabilityForKey = (harnessKey: string, observed: boolean): SkillObservability => {
  if (HARNESS_ORDER.has(harnessKey)) {
    return skillObservabilityFor(harnessKey);
  }
  return observed ? 'observable' : 'not-observable';
};

const coverageFor = (observedHarnessKeys: ReadonlySet<string>): readonly SkillObservationHarnessCoverage[] => {
  // Catalogue order first, then any harness key the store carried that this
  // build does not know about. An unrecognised key is still real history, so it
  // is appended rather than dropped.
  const keys = [...harnessKeys, ...[...observedHarnessKeys].filter((key) => !HARNESS_ORDER.has(key)).sort()];
  return keys.map((harnessKey) => ({
    harnessKey,
    label: harnessLabelFor(harnessKey),
    observability: observabilityForKey(harnessKey, observedHarnessKeys.has(harnessKey)),
  }));
};

export interface CreateSkillObservationDatasetOptions {
  readonly lowerBound?: boolean;
  readonly skipped?: number;
}

/**
 * Folds raw observations into the presented dataset. Pure, order-independent,
 * and deterministic: the same observations in any order produce the same
 * dataset, so a renderer never sees a count move because a read came back
 * sorted differently.
 */
export const createSkillObservationDataset = (
  observations: readonly SkillObservation[],
  options: CreateSkillObservationDatasetOptions = {},
): SkillObservationDataset => {
  const skills = new Map<string, SkillAccumulator>();
  const observedHarnessKeys = new Set<string>();
  for (const observation of observations) {
    observedHarnessKeys.add(observation.harnessKey);
    const skill = skills.get(observation.skillName) ?? {
      lastObservedAt: observation.observedAt,
      resolvedPaths: new Set<string>(),
      skillName: observation.skillName,
      tallies: new Map<string, TallyAccumulator>(),
    };
    skill.lastObservedAt = later(skill.lastObservedAt, observation.observedAt);
    if (observation.resolvedPath !== null) {
      retainSmallestPath(skill.resolvedPaths, observation.resolvedPath, MAX_RESOLVED_PATHS_PER_SKILL);
    }
    // JSON rather than a delimiter, matching `skillObservationIdentity`: a harness key is an open
    // vocabulary, so any separator character could also appear inside one.
    const tallyKey = JSON.stringify([observation.harnessKey, observation.tier]);
    const tally = skill.tallies.get(tallyKey) ?? {
      count: 0,
      harnessKey: observation.harnessKey,
      lastObservedAt: observation.observedAt,
      tier: observation.tier,
    };
    tally.count += 1;
    tally.lastObservedAt = later(tally.lastObservedAt, observation.observedAt);
    skill.tallies.set(tallyKey, tally);
    skills.set(observation.skillName, skill);
  }
  return {
    harnesses: coverageFor(observedHarnessKeys),
    lowerBound: options.lowerBound ?? false,
    skills: [...skills.values()]
      .map((skill) => ({
        lastObservedAt: skill.lastObservedAt,
        resolvedPaths: [...skill.resolvedPaths].sort(),
        skillName: skill.skillName,
        tallies: [...skill.tallies.values()]
          .map((tally) => ({
            count: tally.count,
            harnessKey: tally.harnessKey,
            harnessLabel: harnessLabelFor(tally.harnessKey),
            lastObservedAt: tally.lastObservedAt,
            tier: tally.tier,
          }))
          .sort(
            (left, right) =>
              harnessRank(left.harnessKey) - harnessRank(right.harnessKey) ||
              left.harnessKey.localeCompare(right.harnessKey) ||
              tierRank(left.tier) - tierRank(right.tier),
          ),
      }))
      .sort((left, right) => left.skillName.localeCompare(right.skillName)),
    skipped: options.skipped ?? 0,
  };
};

export const EMPTY_SKILL_OBSERVATION_DATASET: SkillObservationDataset = createSkillObservationDataset([]);
