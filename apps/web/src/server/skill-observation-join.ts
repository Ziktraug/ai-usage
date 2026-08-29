import type { SkillObservationDataset } from '@ai-usage/report-core/skill-observation-summary';
import {
  MAX_SKILL_OBSERVATION_HARNESS_ROSTER,
  MAX_SKILL_OBSERVATION_SKILL_RESOLVED_PATHS,
  MAX_SKILL_OBSERVATION_SKILL_TALLIES,
  MAX_SKILL_OBSERVATION_SKILLS,
  MAX_SKILL_OBSERVATIONS_RESPONSE_BYTES,
  type ObservedSkill,
  type SkillObservations,
  type SkillObservationVerdict,
} from '@ai-usage/web-contract/skills';

/**
 * The inventory↔observation join.
 *
 * It lives on the server because that is where the inventory is (plan 111 decision 3): the skills
 * domain is a filesystem projection and must never learn to read the usage store, and the browser
 * must not be handed two half-answers to reconcile. Everything that needs both sides — managed-ness,
 * projection completeness, and therefore every verdict — is decided here, once, and travels as a
 * fact. The browser's remaining job is to render words.
 *
 * This module is pure: it takes the two already-read inputs and returns the wire shape. That is what
 * makes the verdict rules testable without a filesystem or a store.
 */

/** The projection facts this join needs, as `SkillManagementSnapshot` supplies them. */
export interface SkillObservationJoinProjection {
  readonly skillName: string;
  readonly state: string;
  readonly targetId: string;
}

export interface SkillObservationJoinSkill {
  readonly enabled: boolean;
  readonly name: string;
  readonly validationStatus: string;
}

export interface SkillObservationJoinTarget {
  readonly enabled: boolean;
  readonly id: string;
}

export interface SkillObservationJoinInput {
  readonly observations: SkillObservationDataset;
  readonly projections: readonly SkillObservationJoinProjection[];
  readonly skills: readonly SkillObservationJoinSkill[];
  readonly targets: readonly SkillObservationJoinTarget[];
}

/**
 * Whether every runtime that should hold this skill actually holds it, using the same rule the
 * health summary counts with: an enabled, valid skill is projected everywhere when every enabled
 * target resolves to a `linked` projection.
 *
 * The deletion verdict depends on this rather than on managed-ness, because "managed but never
 * observed" has a mundane explanation — it may simply not be installed anywhere. Only a skill that
 * genuinely installed everywhere and still goes unused is evidence of anything.
 */
const projectedEverywhereFor = (skill: SkillObservationJoinSkill, input: SkillObservationJoinInput): boolean => {
  if (!skill.enabled || skill.validationStatus === 'invalid') {
    return false;
  }
  const activeTargets = input.targets.filter((target) => target.enabled);
  if (activeTargets.length === 0) {
    return false;
  }
  return activeTargets.every((target) =>
    input.projections.some(
      (projection) =>
        projection.skillName === skill.name && projection.targetId === target.id && projection.state === 'linked',
    ),
  );
};

const textEncoder = new TextEncoder();

const responseBytes = (response: SkillObservations): number => textEncoder.encode(JSON.stringify(response)).byteLength;

const INVOCATION_TIERS: ReadonlySet<string> = new Set(['declared', 'inferred']);

/**
 * Bounds the response the procedure actually returns.
 *
 * The read is clamped before this join, and that clamp is not enough: the join re-injects the whole
 * managed inventory, so a store with few observations and many managed skills produces more rows
 * than it read, and it merges the store's harness keys into the catalogue roster, so unknown keys
 * can push the roster past its cap. Every row it emits is also wider than the row it folded. A cap
 * checked only upstream is therefore a cap the assembled payload can still exceed — and exceeding
 * one is not a soft failure: the contract refuses the whole response and a valid store becomes
 * "skill observations are unavailable".
 *
 * So the final shape is clamped against the contract's own published caps, and every clamp reports
 * itself through `lowerBound`, which every renderer already reads as "these counts are floors". A
 * shorter honest answer beats a 503.
 */
export const clampSkillObservationsResponse = (response: SkillObservations): SkillObservations => {
  let lowerBound = response.lowerBound;
  /**
   * One invariant, enforced at every clamp site below: **anything this function drops that carried
   * `declared` or `inferred` evidence sets the invocation bound.**
   *
   * It is not enough to set the pooled `lowerBound`. That flag no longer governs the verdicts — the
   * surface reads an exposure-only truncation as "the counts are floors and the verdicts stand", so
   * a dropped invocation tally reported through `lowerBound` alone would render as a positive
   * claim that every invocation was served.
   */
  let droppedInvocationEvidence = false;
  let harnesses = response.harnesses;
  if (harnesses.length > MAX_SKILL_OBSERVATION_HARNESS_ROSTER) {
    harnesses = harnesses.slice(0, MAX_SKILL_OBSERVATION_HARNESS_ROSTER);
    lowerBound = true;
  }
  // The surface renders a skill's counts by walking the roster, so a tally under a harness the
  // roster no longer carries is a count nothing can present. Dropping it keeps the payload to what
  // is renderable instead of shipping invisible numbers.
  const rosterKeys = new Set(harnesses.map((harness) => harness.harnessKey));
  const skills: ObservedSkill[] = response.skills.map((skill) => {
    const rosteredTallies = skill.tallies.filter((tally) => rosterKeys.has(tally.harnessKey));
    const tallies = rosteredTallies.slice(0, MAX_SKILL_OBSERVATION_SKILL_TALLIES);
    const resolvedPaths = skill.resolvedPaths.slice(0, MAX_SKILL_OBSERVATION_SKILL_RESOLVED_PATHS);
    const pathsClamped = resolvedPaths.length !== skill.resolvedPaths.length;
    if (tallies.length !== skill.tallies.length || pathsClamped) {
      lowerBound = true;
    }
    // A harness key falling off the roster, or a tally falling past the per-skill cap, drops a real
    // count. Which bound that is depends on the tier it held: losing a catalogue injection costs
    // the verdicts nothing, losing an invocation costs them their evidence.
    const retained = new Set(tallies);
    if (skill.tallies.some((tally) => !retained.has(tally) && INVOCATION_TIERS.has(tally.tier))) {
      droppedInvocationEvidence = true;
    }
    return {
      ...skill,
      resolvedPaths,
      // Clamping here truncates the same list the fold's own ceiling truncates, so it sets the same
      // per-skill flag rather than relying on the response-wide `lowerBound` to speak for it.
      resolvedPathsTruncated: skill.resolvedPathsTruncated || pathsClamped,
      tallies,
    };
  });
  let droppedSkillRows = skills.length > MAX_SKILL_OBSERVATION_SKILLS;
  let clamped: SkillObservations = droppedSkillRows
    ? { ...response, harnesses, lowerBound: true, skills: skills.slice(0, MAX_SKILL_OBSERVATION_SKILLS) }
    : { ...response, harnesses, lowerBound, skills };
  // Halving rather than estimating, because skill names and resolved paths are open-vocabulary: the
  // serialized size of a row is not derivable from a row count. It always terminates — an empty
  // skill list leaves only a roster that is orders of magnitude inside the budget.
  while (clamped.skills.length > 0 && responseBytes(clamped) > MAX_SKILL_OBSERVATIONS_RESPONSE_BYTES) {
    droppedSkillRows = true;
    clamped = {
      ...clamped,
      lowerBound: true,
      skills: clamped.skills.slice(0, Math.floor(clamped.skills.length / 2)),
    };
  }
  // Dropping whole rows drops whatever invocation evidence they carried, so the response says its
  // invocation evidence is incomplete. The per-skill `verdictProvisional` flags are untouched, and
  // correctly so: they were decided before this clamp, and a surviving skill's own evidence is not
  // weakened by another skill being left out. The two answer different questions.
  return droppedSkillRows || droppedInvocationEvidence ? { ...clamped, invocationLowerBound: true } : clamped;
};

const verdictFor = (managed: boolean, invoked: boolean, offered: boolean): SkillObservationVerdict => {
  if (invoked) {
    return managed ? 'invoked' : 'invoked-unmanaged';
  }
  // Exposure is evidence that a catalogue listed the skill, not that a model used it. Promoting it
  // to an adoption verdict would propose adopting whatever a harness happens to inject.
  return offered ? 'offered-only' : 'never-observed';
};

export const joinSkillObservations = (input: SkillObservationJoinInput): SkillObservations => {
  const skillsByName = new Map(input.skills.map((skill) => [skill.name, skill]));
  const observedByName = new Map(input.observations.skills.map((skill) => [skill.skillName, skill]));
  /**
   * Whether this read can prove that a skill went uninvoked.
   *
   * Keyed on the *invocation* bound, not the pooled one. Every absence verdict here — never
   * observed, offered-only, deletion candidate — is a claim about `declared` and `inferred`
   * evidence, and nothing else. A read that carried every recorded invocation and stopped short of
   * the exposure catalogue has proved exactly what those verdicts assert; marking them provisional
   * would hedge a claim the data fully supports, and on a real store exposure truncation is the
   * permanent condition, so the hedge would never come off.
   *
   * The converse still holds: if the invocation read trips its own budget, or rows failed
   * re-validation, absence is unproven and every such verdict says so.
   */
  const absenceIsProvable = !input.observations.invocationLowerBound && input.observations.skipped === 0;
  // Every managed skill appears, observed or not: a skill missing from the observation read is the
  // deletion candidate this family exists to name, and dropping it would erase the verdict.
  const names = [...new Set([...skillsByName.keys(), ...observedByName.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  const skills = names.map((skillName) => {
    const observed = observedByName.get(skillName);
    const inventorySkill = skillsByName.get(skillName);
    const managed = inventorySkill !== undefined;
    const tallies = observed?.tallies ?? [];
    const invoked = tallies.some((tally) => INVOCATION_TIERS.has(tally.tier));
    const offered = tallies.length > 0;
    const projectedEverywhere = inventorySkill === undefined ? false : projectedEverywhereFor(inventorySkill, input);
    const verdict = verdictFor(managed, invoked, offered);
    return {
      deletionCandidate: managed && projectedEverywhere && !invoked,
      lastObservedAt: observed?.lastObservedAt ?? null,
      managed,
      projectedEverywhere,
      resolvedPaths: [...(observed?.resolvedPaths ?? [])],
      resolvedPathsTruncated: observed?.resolvedPathsTruncated ?? false,
      skillName,
      tallies: tallies.map((tally) => ({ ...tally })),
      verdict,
      // A positive verdict is not weakened by a short read: seeing an invocation proves use whether
      // or not more rows existed beyond the bound. Only claims of absence are provisional.
      verdictProvisional: !(absenceIsProvable || invoked),
    };
  });
  return clampSkillObservationsResponse({
    harnesses: input.observations.harnesses.map((harness) => ({ ...harness })),
    invocationLowerBound: input.observations.invocationLowerBound,
    lowerBound: input.observations.lowerBound,
    skills,
    skipped: input.observations.skipped,
  });
};
