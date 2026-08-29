import { describe, expect, test } from 'bun:test';
import type { SkillObservation } from '@ai-usage/report-core/skill-observation';
import { createSkillObservationDataset } from '@ai-usage/report-core/skill-observation-summary';
import { joinSkillObservations, type SkillObservationJoinInput } from './skill-observation-join';

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

  test('marks only absence claims provisional when the read was bounded', () => {
    const bounded = createSkillObservationDataset(
      [observation({ harnessKey: 'claude', skillName: 'used', tier: 'declared' })],
      { lowerBound: true },
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
