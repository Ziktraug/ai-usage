import { describe, expect, test } from 'bun:test';
import type { SkillObservation } from '@ai-usage/report-core/skill-observation';
import {
  applySkillObservationEvidenceLoss,
  COMPLETE_SKILL_OBSERVATION_EVIDENCE,
  resolveSkillObservationEvidence,
} from '@ai-usage/report-core/skill-observation-evidence';
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
  test('preserves the producer proof deadline through the inventory join', () => {
    const result = join({
      observations: createSkillObservationDataset([], COMPLETE_SKILL_OBSERVATION_EVIDENCE, '2026-08-01T10:01:00.000Z'),
    });

    expect(result.producerProofValidUntil).toBe('2026-08-01T10:01:00.000Z');
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });

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
    const evidence = applySkillObservationEvidenceLoss(COMPLETE_SKILL_OBSERVATION_EVIDENCE, {
      counts: true,
      invocation: true,
    });
    const bounded = createSkillObservationDataset(
      [observation({ harnessKey: 'claude', skillName: 'used', tier: 'declared' })],
      evidence,
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
    const evidence = applySkillObservationEvidenceLoss(COMPLETE_SKILL_OBSERVATION_EVIDENCE, {
      counts: true,
      invocation: false,
    });
    const exposureBounded = createSkillObservationDataset(
      [
        observation({ harnessKey: 'claude', skillName: 'used', tier: 'declared' }),
        observation({ harnessKey: 'codex', skillName: 'catalogued', tier: 'exposed' }),
      ],
      evidence,
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
    const evidence = resolveSkillObservationEvidence({
      collection: {
        exposureIncomplete: false,
        invocationIncomplete: false,
        producerCompletenessMissing: false,
      },
      read: { invocationTruncated: false, truncated: false },
      refusedRows: [{ exposure: 0, invocation: 0, unknown: 3 }],
    });
    const skipped = createSkillObservationDataset([], evidence);

    const result = join({
      observations: skipped,
      projections: [{ skillName: 'unused', state: 'linked', targetId: 'claude' }],
      skills: [managedSkill('unused')],
    });

    expect(skillNamed(result, 'unused')?.verdictProvisional).toBe(true);
    expect(result.skipped).toBe(3);
    // A row that failed re-validation could have been an invocation, so the shared evidence policy
    // weakens the invocation bound before the join decides the absence verdict.
    expect(result.invocationLowerBound).toBe(true);
  });

  test('counts an exposure refusal without making invocation absence provisional', () => {
    const evidence = resolveSkillObservationEvidence({
      collection: {
        exposureIncomplete: false,
        invocationIncomplete: false,
        producerCompletenessMissing: false,
      },
      read: { invocationTruncated: false, truncated: false },
      refusedRows: [{ exposure: 2, invocation: 0, unknown: 0 }],
    });

    const result = join({
      observations: createSkillObservationDataset([], evidence),
      skills: [managedSkill('unused')],
    });

    expect(skillNamed(result, 'unused')?.verdictProvisional).toBe(false);
    expect(result).toMatchObject({ invocationLowerBound: false, lowerBound: true, skipped: 2 });
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

  test('classifies where an unmanaged name lives, and never classifies a managed one', () => {
    const result = join({
      observations: createSkillObservationDataset([
        // A hand-installed copy in a runtime skills directory: the adoptable backlog.
        observation({ harnessKey: 'opencode', skillName: 'agent-memory', tier: 'declared' }),
        // Owned by a project the scan already knows: deliberately scoped, not an omission.
        observation({
          harnessKey: 'opencode',
          resolvedPath: '/home/alex/Projects/nixos/.agents/skills/nix-modules',
          skillName: 'nix-modules',
          tier: 'declared',
        }),
        // Harness-bundled: no runtime entry, no project directory, still real.
        observation({ harnessKey: 'claude', skillName: 'artifact-design', tier: 'declared' }),
        observation({ harnessKey: 'opencode', skillName: 'pr-review', tier: 'declared' }),
      ]),
      projectPathPrefixes: ['/home/alex/Projects/nixos'],
      skills: [managedSkill('pr-review')],
      unmanagedEntryNames: ['agent-memory'],
    });

    expect(skillNamed(result, 'agent-memory')?.unmanagedResidence).toBe('runtime-installed');
    expect(skillNamed(result, 'nix-modules')?.unmanagedResidence).toBe('project-owned');
    expect(skillNamed(result, 'artifact-design')?.unmanagedResidence).toBe('external');
    // Managed names have a home already; classifying them would state a second, competing one.
    expect(skillNamed(result, 'pr-review')?.unmanagedResidence).toBeNull();
  });

  test('keeps an unobserved project skill as a server-decided project-owned row', () => {
    const result = join({
      observations: createSkillObservationDataset([]),
      projectSkillNames: ['project-review'],
    });

    expect(skillNamed(result, 'project-review')).toMatchObject({
      deletionCandidate: false,
      managed: false,
      projectedEverywhere: false,
      tallies: [],
      unmanagedResidence: 'project-owned',
      verdict: 'never-observed',
    });
  });

  test('a runtime-directory entry outranks a project directory when a name has both', () => {
    const result = join({
      observations: createSkillObservationDataset([
        observation({
          harnessKey: 'opencode',
          resolvedPath: '/home/alex/Projects/nixos/.agents/skills/dotfiles-management',
          skillName: 'dotfiles-management',
          tier: 'declared',
        }),
      ]),
      projectPathPrefixes: ['/home/alex/Projects/nixos'],
      // The same name also sits as a stray copy in a runtime skills directory — that copy is the
      // thing adoption would act on, so the runtime residence wins.
      unmanagedEntryNames: ['dotfiles-management'],
    });

    expect(skillNamed(result, 'dotfiles-management')?.unmanagedResidence).toBe('runtime-installed');
  });

  test('a project prefix matches whole path segments, not string prefixes', () => {
    const result = join({
      observations: createSkillObservationDataset([
        observation({
          harnessKey: 'opencode',
          resolvedPath: '/home/alex/Projects/nixos-exaprint/.agents/skills/printer',
          skillName: 'printer',
          tier: 'declared',
        }),
      ]),
      projectPathPrefixes: ['/home/alex/Projects/nixos'],
    });

    // `/home/alex/Projects/nixos-exaprint` is a different project, not a subdirectory of `nixos`.
    expect(skillNamed(result, 'printer')?.unmanagedResidence).toBe('external');
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
    // These inventory-only rows carried no observation evidence. The response is shorter, but its
    // invocation evidence remains complete.
    expect(result.invocationLowerBound).toBe(false);
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });

  test('a whole-row clamp keeps exposure-only loss out of the invocation bound', () => {
    const result = join({
      observations: createSkillObservationDataset(
        observedSkillNames(MAX_SKILL_OBSERVATION_SKILLS + 1).map((skillName, index) =>
          observation({ harnessKey: 'codex', observationKey: `exposed-${index}`, skillName, tier: 'exposed' }),
        ),
      ),
    });

    expect(result.skills).toHaveLength(MAX_SKILL_OBSERVATION_SKILLS);
    expect(result.lowerBound).toBe(true);
    expect(result.invocationLowerBound).toBe(false);
  });

  const joinUnknownHarnesses = (unknownCount: number, tier: SkillObservation['tier'] = 'declared') =>
    join({
      observations: createSkillObservationDataset(
        Array.from({ length: unknownCount }, (_value, index) =>
          observation({ harnessKey: `future-harness-${index}`, skillName: 'improve', tier }),
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

  test('a roster clamp that drops a declared tally reports the invocation bound, not just the pooled one', () => {
    const result = joinUnknownHarnesses(MAX_SKILL_OBSERVATION_HARNESS_ROSTER - CATALOGUE_HARNESSES + 1, 'declared');

    // The dropped tally was invocation evidence. Reporting that through `lowerBound` alone is not a
    // smaller claim than the truth, it is the opposite one: the surface reads an exposure-only
    // truncation as "the counts are floors and every invocation was served", so this payload would
    // have asserted completeness of the very evidence the clamp threw away.
    expect(result.lowerBound).toBe(true);
    expect(result.invocationLowerBound).toBe(true);
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });

  test('a roster clamp that drops only exposed tallies leaves the invocation bound alone', () => {
    const result = joinUnknownHarnesses(MAX_SKILL_OBSERVATION_HARNESS_ROSTER - CATALOGUE_HARNESSES + 1, 'exposed');

    // A catalogue injection nothing can render is a count lost, not evidence lost. Setting the
    // invocation bound here would hedge every absence verdict for a reason none of them rest on.
    expect(result.lowerBound).toBe(true);
    expect(result.invocationLowerBound).toBe(false);
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });

  test('the per-skill tally cap obeys the same rule as the roster cap', () => {
    // The other tally-dropping site. Which bound moves is decided by the tier of what was dropped,
    // never by which clamp did the dropping — so the invariant holds wherever a tally can be lost.
    //
    // Tallies arrive sorted by harness then tier, so what falls past the cap is the last tier of the
    // lexicographically last harness. `zz` carries invocation tiers only, which puts an `inferred`
    // tally at the end; 21 harnesses of three tiers each fill the 63 places before it.
    const fullHarnesses = ['declared', 'inferred', 'exposed'] as const;
    const invocationDropped = join({
      observations: createSkillObservationDataset([
        ...Array.from({ length: 21 }, (_value, index) =>
          fullHarnesses.map((tier) =>
            observation({ harnessKey: `h-${String(index).padStart(2, '0')}`, skillName: 'improve', tier }),
          ),
        ).flat(),
        observation({ harnessKey: 'zz', skillName: 'improve', tier: 'declared' }),
        observation({ harnessKey: 'zz', skillName: 'improve', tier: 'inferred' }),
      ]),
    });

    expect(invocationDropped.skills[0]?.tallies).toHaveLength(MAX_SKILL_OBSERVATION_SKILL_TALLIES);
    expect(invocationDropped.invocationLowerBound).toBe(true);

    // And when the cap happens to bite an `exposed` tally instead, the invocation bound stays put.
    const exposureDropped = joinTallies(MAX_SKILL_OBSERVATION_SKILL_TALLIES + 1);
    expect(exposureDropped.skills[0]?.tallies).toHaveLength(MAX_SKILL_OBSERVATION_SKILL_TALLIES);
    expect(exposureDropped.lowerBound).toBe(true);
    expect(exposureDropped.invocationLowerBound).toBe(false);
  });

  const responseWithSkills = (count: number, nameLength: number): SkillObservations => ({
    harnesses: [{ harnessKey: 'claude', label: 'Claude Code', observability: 'observable' }],
    invocationLowerBound: false,
    lowerBound: false,
    producerCompletenessMissing: false,
    producerProofValidUntil: null,
    skills: Array.from({ length: count }, (_value, index) => ({
      deletionCandidate: false,
      lastObservedAt: null,
      managed: true,
      projectedEverywhere: false,
      resolvedPaths: [],
      resolvedPathsTruncated: false,
      skillName: `${index}`.padStart(nameLength, 'n'),
      tallies: [],
      unmanagedResidence: null,
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
    expect(clamped.invocationLowerBound).toBe(false);
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
    expect(result.invocationLowerBound).toBe(true);
    expect(safeParse(skillObservationsSchema, result).success).toBe(true);
  });
});
