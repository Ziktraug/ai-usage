import { describe, expect, test } from 'bun:test';
import type { SkillObservation } from '@ai-usage/report-core/skill-observation';
import { createSkillObservationDataset } from '@ai-usage/report-core/skill-observation-summary';
import {
  MAX_SKILL_OBSERVATION_HARNESS_ROSTER,
  MAX_SKILL_OBSERVATION_SKILL_TALLIES,
  MAX_SKILL_OBSERVATION_SKILLS,
  MAX_SKILL_OBSERVATIONS_RESPONSE_BYTES,
  type SkillObservations,
  skillObservationsSchema,
} from '@ai-usage/web-contract/skills';
import { safeParse } from 'valibot';
import {
  clampSkillObservationsResponse,
  joinSkillObservations,
  type SkillObservationJoinInput,
} from './skill-observation-join';

const observation = (
  overrides: Pick<SkillObservation, 'harnessKey' | 'skillName' | 'tier'> & Partial<SkillObservation>,
): SkillObservation => ({
  argsPresent: null,
  observationKey: `${overrides.harnessKey}-${overrides.tier}-${overrides.skillName}`,
  observedAt: '2026-08-01T09:00:00.000Z',
  projectPath: '/home/alex/Projects/report',
  resolvedPath: null,
  sessionId: 'session-1',
  success: null,
  ...overrides,
});

const managedSkill = (name: string) => ({ enabled: true, name, validationStatus: 'valid' });

const join = (input: Partial<SkillObservationJoinInput> & Pick<SkillObservationJoinInput, 'observations'>) =>
  joinSkillObservations({
    projections: [],
    skills: [],
    targets: [{ enabled: true, id: 'claude' }],
    ...input,
  });

const skillNamed = (result: ReturnType<typeof join>, skillName: string) =>
  result.skills.find((skill) => skill.skillName === skillName);

describe('skill observation join', () => {
  test('an exposed-only skill is never an adoption candidate', () => {
    const result = join({
      observations: createSkillObservationDataset([
        observation({ harnessKey: 'codex', skillName: 'imagegen', tier: 'exposed' }),
        observation({ harnessKey: 'codex', skillName: 'pr-review', tier: 'inferred' }),
      ]),
    });

    // A Codex catalogue lists every skill it has. "It was offered" is a fact about the harness, not
    // about the operator, and proposing adoption on that basis would propose adopting the catalogue.
    expect(skillNamed(result, 'imagegen')?.verdict).toBe('offered-only');
    // A weaker trace of an actual read is still evidence of use, so it does carry the verdict.
    expect(skillNamed(result, 'pr-review')?.verdict).toBe('invoked-unmanaged');
  });

  test('a declared invocation of an unmanaged skill is the adoption candidate', () => {
    const result = join({
      observations: createSkillObservationDataset([
        observation({ harnessKey: 'claude', skillName: 'artifact-design', tier: 'declared' }),
      ]),
    });

    expect(skillNamed(result, 'artifact-design')).toMatchObject({
      deletionCandidate: false,
      managed: false,
      verdict: 'invoked-unmanaged',
    });
  });

  test('deletion needs the skill to be installed everywhere, not merely managed', () => {
    const targets = [
      { enabled: true, id: 'claude' },
      { enabled: true, id: 'codex' },
    ];
    const observations = createSkillObservationDataset([]);
    const skills = [managedSkill('everywhere'), managedSkill('half-linked')];
    const projections = [
      { skillName: 'everywhere', state: 'linked', targetId: 'claude' },
      { skillName: 'everywhere', state: 'linked', targetId: 'codex' },
      { skillName: 'half-linked', state: 'linked', targetId: 'claude' },
      { skillName: 'half-linked', state: 'missing', targetId: 'codex' },
    ];

    const result = join({ observations, projections, skills, targets });

    // Both are managed and neither was ever invoked, but only one of them is actually installed in
    // every runtime. The other has a mundane reason to be unused, so it is not evidence of anything.
    expect(skillNamed(result, 'everywhere')).toMatchObject({ deletionCandidate: true, projectedEverywhere: true });
    expect(skillNamed(result, 'half-linked')).toMatchObject({ deletionCandidate: false, projectedEverywhere: false });
    expect(skillNamed(result, 'half-linked')?.verdict).toBe('never-observed');
  });

  test('a skill that is only offered still counts as never invoked for deletion', () => {
    const result = join({
      observations: createSkillObservationDataset([
        observation({ harnessKey: 'codex', skillName: 'offered', tier: 'exposed' }),
      ]),
      projections: [{ skillName: 'offered', state: 'linked', targetId: 'claude' }],
      skills: [managedSkill('offered')],
    });

    expect(skillNamed(result, 'offered')).toMatchObject({ deletionCandidate: true, verdict: 'offered-only' });
  });

  test('a disabled or invalid skill is not projected everywhere and so is not proposed for deletion', () => {
    const projections = [{ skillName: 'candidate', state: 'linked', targetId: 'claude' }];
    const observations = createSkillObservationDataset([]);

    for (const skill of [
      { enabled: false, name: 'candidate', validationStatus: 'valid' },
      { enabled: true, name: 'candidate', validationStatus: 'invalid' },
    ]) {
      const result = join({ observations, projections, skills: [skill] });
      expect(skillNamed(result, 'candidate')?.deletionCandidate).toBe(false);
    }
  });

  test('marks only absence claims provisional when the invocation read was bounded', () => {
    const bounded = createSkillObservationDataset(
      [observation({ harnessKey: 'claude', skillName: 'used', tier: 'declared' })],
      { invocationLowerBound: true, lowerBound: true },
    );

    const result = join({
      observations: bounded,
      projections: [{ skillName: 'unused', state: 'linked', targetId: 'claude' }],
      skills: [managedSkill('used'), managedSkill('unused')],
    });

    // Absence is what a bounded read cannot establish, so the never-observed verdict says so.
    expect(skillNamed(result, 'unused')?.verdictProvisional).toBe(true);
    // Presence is not weakened by a short read: an invocation seen is an invocation that happened.
    expect(skillNamed(result, 'used')?.verdictProvisional).toBe(false);
    expect(result.invocationLowerBound).toBe(true);
  });

  test('a truncated exposure catalogue does not make an absence verdict provisional', () => {
    // The condition every real store is permanently in: Codex writes one exposure row per catalogue
    // entry per session, so the catalogue always outruns the budget while the invocation tiers fit
    // comfortably. Keying provisionality on the pooled bound hedged every verdict forever — and
    // hedged them for a reason that has nothing to do with what the verdicts claim.
    const exposureBounded = createSkillObservationDataset(
      [
        observation({ harnessKey: 'claude', skillName: 'used', tier: 'declared' }),
        observation({ harnessKey: 'codex', skillName: 'catalogued', tier: 'exposed' }),
      ],
      { invocationLowerBound: false, lowerBound: true },
    );

    const result = join({
      observations: exposureBounded,
      projections: [
        { skillName: 'unused', state: 'linked', targetId: 'claude' },
        { skillName: 'catalogued', state: 'linked', targetId: 'claude' },
      ],
      skills: [managedSkill('used'), managedSkill('unused'), managedSkill('catalogued')],
    });

    // Every invocation ever recorded is in hand, so "never invoked" is a claim this read supports.
    expect(skillNamed(result, 'unused')).toMatchObject({
      deletionCandidate: true,
      verdict: 'never-observed',
      verdictProvisional: false,
    });
    expect(skillNamed(result, 'catalogued')).toMatchObject({
      verdict: 'offered-only',
      verdictProvisional: false,
    });
    expect(skillNamed(result, 'used')?.verdictProvisional).toBe(false);
    // The counts are still floors, and the response still says so — just not through the flag that
    // governs verdicts.
    expect(result.lowerBound).toBe(true);
    expect(result.invocationLowerBound).toBe(false);
  });

  test('treats unreadable stored rows the same way as a bounded read', () => {
    const skipped = createSkillObservationDataset([], { skipped: 3 });

    const result = join({
      observations: skipped,
      projections: [{ skillName: 'unused', state: 'linked', targetId: 'claude' }],
      skills: [managedSkill('unused')],
    });

    expect(skillNamed(result, 'unused')?.verdictProvisional).toBe(true);
    expect(result.skipped).toBe(3);
    // A row that failed re-validation could have been an invocation, so it counts against absence
    // regardless of which bound the read reported.
    expect(result.invocationLowerBound).toBe(false);
  });

  test('keeps a managed skill with no observations in the payload rather than dropping it', () => {
    const result = join({
      observations: createSkillObservationDataset([]),
      skills: [managedSkill('never-used')],
    });

    // Dropping it would erase the deletion verdict this family exists to produce.
    expect(result.skills.map(({ skillName }) => skillName)).toEqual(['never-used']);
    expect(skillNamed(result, 'never-used')).toMatchObject({
      lastObservedAt: null,
      managed: true,
      tallies: [],
      verdict: 'never-observed',
    });
  });

  test('refuses a blanket deletion recommendation when no runtime is enabled', () => {
    // With every target disabled there is nothing for a skill to be installed in, so "installed
    // everywhere" is vacuously true of every managed skill. Reading it that way would propose
    // deleting the whole inventory on the strength of a configuration the operator turned off.
    const result = join({
      observations: createSkillObservationDataset([]),
      projections: [{ skillName: 'candidate', state: 'linked', targetId: 'claude' }],
      skills: [managedSkill('candidate')],
      targets: [{ enabled: false, id: 'claude' }],
    });

    expect(skillNamed(result, 'candidate')).toMatchObject({
      deletionCandidate: false,
      projectedEverywhere: false,
      verdict: 'never-observed',
    });
  });

  test('carries the resolved-path ceiling through as a fact, not as an absence', () => {
    const observations = createSkillObservationDataset(
      Array.from({ length: 9 }, (_value, index) =>
        observation({
          harnessKey: 'claude',
          observationKey: `path-${index}`,
          resolvedPath: `/home/alex/.claude/skills/improve-${index}`,
          skillName: 'improve',
          tier: 'declared',
        }),
      ),
    );

    const truncated = join({ observations });
    expect(skillNamed(truncated, 'improve')?.resolvedPathsTruncated).toBe(true);

    // A skill the read never resolved anywhere is not truncated — it is unresolved, which is a
    // different state and the one that carries the "invoked but unmanaged" verdict.
    const unresolved = join({
      observations: createSkillObservationDataset([
        observation({ harnessKey: 'claude', skillName: 'artifact-design', tier: 'declared' }),
      ]),
    });
    expect(skillNamed(unresolved, 'artifact-design')).toMatchObject({
      resolvedPaths: [],
      resolvedPathsTruncated: false,
    });
  });

  test('carries the harness roster through so Cursor stays not observable', () => {
    const result = join({ observations: createSkillObservationDataset([]) });

    expect(result.harnesses).toEqual([
      { harnessKey: 'claude', label: 'Claude Code', observability: 'observable' },
      { harnessKey: 'codex', label: 'Codex', observability: 'observable' },
      { harnessKey: 'opencode', label: 'OpenCode', observability: 'observable' },
      { harnessKey: 'cursor', label: 'Cursor', observability: 'not-observable' },
    ]);
  });
});

/**
 * The bounds that matter are the ones on the *response*. The read is clamped before the join, and
 * the join then re-injects the managed inventory and widens every row, so these cases all pass an
 * upstream bound and would still be refused by the contract.
 */
describe('skill observation response bounds', () => {
  const CATALOGUE_HARNESSES = 4;

  const observedSkillNames = (count: number, prefix = 'skill'): readonly string[] =>
    Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);

  const joinManagedSkills = (count: number) =>
    join({
      observations: createSkillObservationDataset([]),
      skills: observedSkillNames(count).map((name) => managedSkill(name)),
    });

  test('a managed inventory exactly at the row cap survives the join intact', () => {
    const result = joinManagedSkills(MAX_SKILL_OBSERVATION_SKILLS);

    expect(result.skills).toHaveLength(MAX_SKILL_OBSERVATION_SKILLS);
    expect(result.lowerBound).toBe(false);
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });

  test('one managed skill past the row cap is clamped and says so rather than failing the contract', () => {
    const result = joinManagedSkills(MAX_SKILL_OBSERVATION_SKILLS + 1);

    // The read that produced this returned nothing at all; the extra rows are the inventory the
    // join added. Clamping only upstream would have let exactly this payload reach the schema.
    expect(result.skills).toHaveLength(MAX_SKILL_OBSERVATION_SKILLS);
    expect(result.lowerBound).toBe(true);
    // Dropping whole rows drops whatever invocation evidence they carried, so the response no
    // longer claims complete invocation coverage — even though each surviving row's own verdict was
    // decided before the clamp and stands.
    expect(result.invocationLowerBound).toBe(true);
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });

  const joinUnknownHarnesses = (unknownCount: number) =>
    join({
      observations: createSkillObservationDataset(
        Array.from({ length: unknownCount }, (_value, index) =>
          observation({ harnessKey: `future-harness-${index}`, skillName: 'improve', tier: 'declared' }),
        ),
      ),
    });

  test('a harness roster exactly at the cap keeps every key', () => {
    const result = joinUnknownHarnesses(MAX_SKILL_OBSERVATION_HARNESS_ROSTER - CATALOGUE_HARNESSES);

    expect(result.harnesses).toHaveLength(MAX_SKILL_OBSERVATION_HARNESS_ROSTER);
    expect(result.lowerBound).toBe(false);
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });

  test('one harness key past the roster cap is clamped, and no unrenderable tally is shipped', () => {
    const result = joinUnknownHarnesses(MAX_SKILL_OBSERVATION_HARNESS_ROSTER - CATALOGUE_HARNESSES + 1);

    expect(result.harnesses).toHaveLength(MAX_SKILL_OBSERVATION_HARNESS_ROSTER);
    expect(result.lowerBound).toBe(true);
    // The surface renders a skill's counts by walking the roster, so a tally under a dropped key is
    // a number nothing can present. It leaves with the key rather than travelling invisibly.
    const rosterKeys = new Set(result.harnesses.map(({ harnessKey }) => harnessKey));
    for (const tally of result.skills.flatMap(({ tallies }) => tallies)) {
      expect(rosterKeys.has(tally.harnessKey)).toBe(true);
    }
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });

  const responseWithSkills = (count: number, nameLength: number): SkillObservations => ({
    harnesses: [{ harnessKey: 'claude', label: 'Claude Code', observability: 'observable' }],
    invocationLowerBound: false,
    lowerBound: false,
    skills: Array.from({ length: count }, (_value, index) => ({
      deletionCandidate: false,
      lastObservedAt: null,
      managed: true,
      projectedEverywhere: false,
      resolvedPaths: [],
      resolvedPathsTruncated: false,
      skillName: `${index}`.padStart(nameLength, 'n'),
      tallies: [],
      verdict: 'never-observed' as const,
      verdictProvisional: false,
    })),
    skipped: 0,
  });

  const joinTallies = (tallyCount: number) => {
    const tiers = ['declared', 'inferred', 'exposed'] as const;
    return join({
      observations: createSkillObservationDataset(
        Array.from({ length: tallyCount }, (_value, index) =>
          observation({
            harnessKey: `future-harness-${Math.floor(index / tiers.length)}`,
            skillName: 'improve',
            tier: tiers[index % tiers.length] ?? 'declared',
          }),
        ),
      ),
    });
  };

  test('a skill exactly at the tally cap keeps every count', () => {
    const result = joinTallies(MAX_SKILL_OBSERVATION_SKILL_TALLIES);

    expect(result.skills[0]?.tallies).toHaveLength(MAX_SKILL_OBSERVATION_SKILL_TALLIES);
    expect(result.lowerBound).toBe(false);
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });

  test('one tally past the cap is clamped rather than rejected — harness × tier can outgrow it', () => {
    const result = joinTallies(MAX_SKILL_OBSERVATION_SKILL_TALLIES + 1);

    expect(result.skills[0]?.tallies).toHaveLength(MAX_SKILL_OBSERVATION_SKILL_TALLIES);
    expect(result.lowerBound).toBe(true);
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });

  // Long names, because a byte budget is not a row count: names and resolved paths are
  // open-vocabulary, so the row cap alone can never bound the serialized size.
  const LONG_NAME_LENGTH = 512;
  const responseBytes = (response: SkillObservations): number =>
    new TextEncoder().encode(JSON.stringify(response)).byteLength;

  /** The largest row count that still serializes inside the budget, found without a linear scan. */
  const rowsAtByteBudget = (): number => {
    let low = 1;
    let high = MAX_SKILL_OBSERVATION_SKILLS;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (responseBytes(responseWithSkills(middle, LONG_NAME_LENGTH)) <= MAX_SKILL_OBSERVATIONS_RESPONSE_BYTES) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  };

  test('a response exactly at the byte budget is not trimmed', () => {
    const atBudget = responseWithSkills(rowsAtByteBudget(), LONG_NAME_LENGTH);

    // The row cap is not what is being tested here, so it must not be the bound that binds.
    expect(atBudget.skills.length).toBeLessThan(MAX_SKILL_OBSERVATION_SKILLS);
    expect(clampSkillObservationsResponse(atBudget)).toEqual(atBudget);
    expect(safeParse(skillObservationsSchema, atBudget).success).toBe(true);
  });

  test('one row past the byte budget is trimmed until it fits and reports the bound', () => {
    const oversized = responseWithSkills(rowsAtByteBudget() + 1, LONG_NAME_LENGTH);
    expect(responseBytes(oversized)).toBeGreaterThan(MAX_SKILL_OBSERVATIONS_RESPONSE_BYTES);

    const clamped = clampSkillObservationsResponse(oversized);

    expect(responseBytes(clamped)).toBeLessThanOrEqual(MAX_SKILL_OBSERVATIONS_RESPONSE_BYTES);
    expect(clamped.skills.length).toBeGreaterThan(0);
    expect(clamped.lowerBound).toBe(true);
    expect(safeParse(skillObservationsSchema, clamped).success).toBe(true);
  });

  test('the reviewer repro — a full observation read joined against a full inventory — still answers', () => {
    const observations = createSkillObservationDataset(
      observedSkillNames(MAX_SKILL_OBSERVATION_SKILLS, 'unknown').map((skillName) =>
        observation({ harnessKey: 'claude', skillName, tier: 'declared' }),
      ),
    );
    const result = join({
      observations,
      skills: observedSkillNames(MAX_SKILL_OBSERVATION_SKILLS, 'managed').map((name) => managedSkill(name)),
    });

    // 8192 joined rows against a 4096-row cap. Before the post-join clamp this parsed as a failure
    // and the whole procedure answered `Unavailable` for a store that was entirely valid.
    expect(result.skills.length).toBeLessThanOrEqual(MAX_SKILL_OBSERVATION_SKILLS);
    expect(result.lowerBound).toBe(true);
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });
});
