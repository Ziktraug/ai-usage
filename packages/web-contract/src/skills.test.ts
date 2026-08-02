import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import {
  projectSkillMarkdownInputSchema,
  saveSkillMarkdownInputSchema,
  skillManagementSnapshotSchema,
  skillMarkdownSaveResultSchema,
  skillNameInputSchema,
  skillsContract,
  skillsErrorMap,
  skillsProcedureIntents,
} from './skills';

const emptySnapshot = {
  config: { sourceRepoPath: '/synthetic/source' },
  configured: true,
  diagnostics: [],
  nativeRuleFindings: [],
  projections: [],
  skills: [],
  sourceState: { skillEnabledByName: {}, version: 1 },
  summary: {
    activeSkillCount: 0,
    diagnosticCount: 0,
    healthyProjectionCount: 0,
    skillCount: 0,
    targetCount: 0,
    unhealthyProjectionCount: 0,
    unmanagedEntryCount: 0,
  },
  targets: [],
  unmanagedEntries: [],
};

const procedureNames = [
  'createTargetDirectory',
  'knownProjectPaths',
  'managedMarkdown',
  'previewReconcileAll',
  'projectInventories',
  'projectMarkdown',
  'reconcileAll',
  'reconcileOne',
  'refreshSnapshot',
  'saveConfig',
  'saveManagedMarkdown',
  'snapshot',
  'toggleProjection',
];

describe('Skills oRPC contract', () => {
  test('declares all thirteen operations and the frozen semantic intents', () => {
    expect(Object.keys(skillsContract).sort()).toEqual(procedureNames);
    expect(skillsProcedureIntents).toEqual({
      createTargetDirectory: 'mutation',
      projectInventories: 'query',
      knownProjectPaths: 'query',
      managedMarkdown: 'query',
      previewReconcileAll: 'query',
      projectMarkdown: 'query',
      reconcileAll: 'mutation',
      reconcileOne: 'mutation',
      refreshSnapshot: 'mutation',
      saveConfig: 'mutation',
      saveManagedMarkdown: 'mutation',
      snapshot: 'query',
      toggleProjection: 'mutation',
    });
  });

  test('preserves the frozen HTTP methods independently of semantic query intent', () => {
    expect(
      Object.fromEntries(
        Object.entries(skillsContract).map(([name, procedure]) => [name, procedure['~orpc'].route.method]),
      ),
    ).toEqual({
      createTargetDirectory: 'POST',
      knownProjectPaths: 'GET',
      managedMarkdown: 'POST',
      previewReconcileAll: 'GET',
      projectInventories: 'GET',
      projectMarkdown: 'GET',
      reconcileAll: 'POST',
      reconcileOne: 'POST',
      refreshSnapshot: 'POST',
      saveConfig: 'POST',
      saveManagedMarkdown: 'POST',
      snapshot: 'GET',
      toggleProjection: 'POST',
    });
  });

  test('exposes only the approved sanitized error families', () => {
    expect(Object.keys(skillsErrorMap).sort()).toEqual([
      'ForbiddenDemo',
      'InvalidInput',
      'SkillsConflict',
      'Unavailable',
    ]);
    expect(skillsErrorMap.SkillsConflict).toMatchObject({ status: 409 });
    expect(JSON.stringify(skillsErrorMap)).not.toContain('/synthetic');
  });

  test('validates a complete synthetic snapshot and rejects unknown wire fields', () => {
    expect(safeParse(skillManagementSnapshotSchema, emptySnapshot).success).toBe(true);
    expect(
      safeParse(skillManagementSnapshotSchema, {
        ...emptySnapshot,
        privatePath: '/real/user/state',
      }).success,
    ).toBe(false);
  });

  test('uses strict validated names and project markdown inputs', () => {
    expect(safeParse(skillNameInputSchema, { skillName: 'valid-skill' }).success).toBe(true);
    expect(safeParse(skillNameInputSchema, { skillName: '../escape' }).success).toBe(false);
    expect(safeParse(skillNameInputSchema, { extra: true, skillName: 'valid-skill' }).success).toBe(false);

    const parsed = safeParse(projectSkillMarkdownInputSchema, {
      projectPath: '  /synthetic/project  ',
      runtimeDirId: 'agents-project',
      skillName: 'valid-skill',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.projectPath).toBe('/synthetic/project');
    }
    expect(
      safeParse(projectSkillMarkdownInputSchema, {
        projectPath: ' ',
        runtimeDirId: 'agents-project',
        skillName: 'valid-skill',
      }).success,
    ).toBe(false);
  });

  test('enforces the markdown limit in UTF-8 bytes and a lowercase SHA-256', () => {
    const baseSha256 = 'a'.repeat(64);
    expect(
      safeParse(saveSkillMarkdownInputSchema, {
        baseSha256,
        content: 'a'.repeat(262_144),
        skillName: 'valid-skill',
      }).success,
    ).toBe(true);
    expect(
      safeParse(saveSkillMarkdownInputSchema, {
        baseSha256,
        content: 'é'.repeat(131_073),
        skillName: 'valid-skill',
      }).success,
    ).toBe(false);
    expect(
      safeParse(saveSkillMarkdownInputSchema, {
        baseSha256: 'A'.repeat(64),
        content: '',
        skillName: 'valid-skill',
      }).success,
    ).toBe(false);
  });

  test('keeps dirty-draft save outcomes in the successful output channel', () => {
    for (const reason of ['conflict', 'not-found', 'too-large'] as const) {
      expect(safeParse(skillMarkdownSaveResultSchema, { reason }).success).toBe(true);
    }
    expect(safeParse(skillMarkdownSaveResultSchema, { reason: 'raw-filesystem-error' }).success).toBe(false);
    expect(
      safeParse(skillMarkdownSaveResultSchema, {
        document: {
          content: '# Skill',
          path: '/synthetic/source/valid-skill/SKILL.md',
          sha256: 'b'.repeat(64),
          skillName: 'valid-skill',
        },
        snapshot: emptySnapshot,
      }).success,
    ).toBe(true);
  });
});
