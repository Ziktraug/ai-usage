import type { SkillObservationDataset } from '@ai-usage/report-core/skill-observation-summary';
import type { SkillObservations, SkillObservationVerdict } from '@ai-usage/web-contract/skills';

/**
 * The inventory↔observation join.
 *
 * It lives on the server because that is where the inventory is (plan 099 decision 3): the skills
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

const INVOCATION_TIERS: ReadonlySet<string> = new Set(['declared', 'inferred']);

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
  // A bounded or partially unreadable read cannot prove absence. Verdicts that rest on absence say
  // so, so the surface can qualify them instead of presenting a short read as proof.
  const absenceIsProvable = !input.observations.lowerBound && input.observations.skipped === 0;
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
      skillName,
      tallies: tallies.map((tally) => ({ ...tally })),
      verdict,
      // A positive verdict is not weakened by a short read: seeing an invocation proves use whether
      // or not more rows existed beyond the bound. Only claims of absence are provisional.
      verdictProvisional: !(absenceIsProvable || invoked),
    };
  });
  return {
    harnesses: input.observations.harnesses.map((harness) => ({ ...harness })),
    lowerBound: input.observations.lowerBound,
    skills,
    skipped: input.observations.skipped,
  };
};
