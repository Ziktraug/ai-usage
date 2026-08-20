import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import {
  knownSkillProjectPathsSchema,
  projectSkillInventoriesSchema,
  projectSkillMarkdownDocumentSchema,
  projectSkillMarkdownInputSchema,
  saveSkillMarkdownInputSchema,
  skillManagementConfigSchema,
  skillManagementSnapshotSchema,
  skillMarkdownDocumentSchema,
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

  test('accepts discovered entry names a managed skill could never carry', () => {
    // A runtime target holds whatever is on disk. Codex writes a `.system` directory of its own, and
    // validating that name like a managed skill name rejected the entire snapshot, taking every valid
    // entry with it.
    const withDiscoveredEntry = (entryName: string) => ({
      ...emptySnapshot,
      unmanagedEntries: [
        {
          diagnostics: [],
          entryName,
          expectedPath: '/synthetic/target/entry',
          state: 'unmanaged-copy',
          targetId: 'codex',
        },
      ],
    });

    for (const accepted of ['.system', 'Legacy_Skill', 'skill.backup', 'réviseur']) {
      expect(safeParse(skillManagementSnapshotSchema, withDiscoveredEntry(accepted)).success).toBe(true);
    }

    for (const rejected of [
      '',
      '.',
      '..',
      'nested/name',
      'nested\\name',
      'bell\u0007',
      'next-line\u0085',
      'application-command\u009f',
      'a'.repeat(256),
    ]) {
      expect(safeParse(skillManagementSnapshotSchema, withDiscoveredEntry(rejected)).success).toBe(false);
    }

    // Managed projections keep the strict identifier pattern.
    expect(
      safeParse(skillManagementSnapshotSchema, {
        ...emptySnapshot,
        projections: withDiscoveredEntry('.system').unmanagedEntries,
      }).success,
    ).toBe(false);
  });

  test('performs non-invoking JSON-wire preflight before transforms', () => {
    let reads = 0;
    const rootAccessor: Record<string, unknown> = {};
    Object.defineProperty(rootAccessor, 'skillName', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'valid-skill';
      },
    });
    expect(safeParse(skillNameInputSchema, rootAccessor).success).toBe(false);

    const nestedAccessor: Record<string, unknown> = {};
    Object.defineProperty(nestedAccessor, 'sourceRepoPath', {
      enumerable: true,
      get: () => {
        reads += 1;
        return '/synthetic/source';
      },
    });
    expect(
      safeParse(skillManagementSnapshotSchema, {
        ...emptySnapshot,
        config: nestedAccessor,
      }).success,
    ).toBe(false);
    expect(reads).toBe(0);

    expect(safeParse(skillManagementConfigSchema, { nested: { value: Number.POSITIVE_INFINITY } }).success).toBe(false);
    expect(safeParse(skillManagementConfigSchema, { nested: new Date(0) }).success).toBe(false);
    expect(safeParse(skillManagementConfigSchema, { nested: new Blob(['synthetic']) }).success).toBe(false);
  });

  test('uses the authoritative pure Skills config parser and bounded config collections', () => {
    const parsed = safeParse(skillManagementConfigSchema, {
      connectors: {
        'agents-project': { consumesTargets: ['codex', 'claude'], enabled: true },
      },
      ignoredTargetFindings: ['synthetic-finding'],
      projectPaths: ['/synthetic/project'],
      projectsRootPath: '/synthetic/projects',
      sourceRepoPath: '/synthetic/source',
      targets: {
        codex: {
          enabled: true,
          kind: 'standard-interop',
          path: '/synthetic/target',
          scope: 'system',
        },
      },
      tokenThresholds: {
        referenceFile: { high: 2, warn: 1 },
        skillMd: { high: 2, warn: 1 },
        totalSkill: { high: 2, warn: 1 },
      },
    });
    expect(parsed.success).toBe(true);
    expect(safeParse(skillManagementConfigSchema, { sourceRepoPath: '   ' }).success).toBe(false);
    expect(
      safeParse(skillManagementConfigSchema, {
        connectors: { 'Bad Connector': { consumesTargets: [], enabled: true } },
      }).success,
    ).toBe(false);
    expect(
      safeParse(skillManagementConfigSchema, {
        connectors: { valid: { consumesTargets: ['bad/target'], enabled: true } },
      }).success,
    ).toBe(false);
    expect(
      safeParse(skillManagementConfigSchema, {
        targets: {
          valid: { enabled: true, kind: 'custom', path: ' ', scope: 'project' },
        },
      }).success,
    ).toBe(false);
    expect(safeParse(skillManagementConfigSchema, { sourceRepoPath: `/${'a'.repeat(4096)}` }).success).toBe(false);
    expect(
      safeParse(skillManagementConfigSchema, {
        ignoredTargetFindings: Array.from({ length: 4097 }, () => 'synthetic'),
      }).success,
    ).toBe(false);
  });

  test('enforces explicit collection and aggregate output budgets', () => {
    const knownPath = {
      label: 'Synthetic',
      path: '/synthetic/project',
      project: 'synthetic',
      sessions: 1,
    };
    expect(
      safeParse(
        knownSkillProjectPathsSchema,
        Array.from({ length: 4097 }, () => knownPath),
      ).success,
    ).toBe(false);
    expect(
      safeParse(
        knownSkillProjectPathsSchema,
        Array.from({ length: 2050 }, () => ({ ...knownPath, path: `/${'a'.repeat(4095)}` })),
      ).success,
    ).toBe(false);

    const inventory = { diagnostics: [], observations: [], projectPath: '/synthetic/project' };
    expect(
      safeParse(
        projectSkillInventoriesSchema,
        Array.from({ length: 4097 }, () => inventory),
      ).success,
    ).toBe(false);
    expect(
      safeParse(skillManagementSnapshotSchema, {
        ...emptySnapshot,
        diagnostics: Array.from({ length: 4096 }, () => ({
          code: 'synthetic',
          message: 'a'.repeat(2050),
          severity: 'warning',
        })),
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
    const snapshotWithManifestMarkdown = (markdown: string) => ({
      ...emptySnapshot,
      skills: [
        {
          description: 'Synthetic skill',
          diagnostics: [],
          enabled: true,
          manifest: { fields: [], markdown },
          name: 'valid-skill',
          path: '/synthetic/source/valid-skill',
          skillMdPath: '/synthetic/source/valid-skill/SKILL.md',
          validationStatus: 'valid',
        },
      ],
    });
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

    expect(
      safeParse(skillMarkdownDocumentSchema, {
        content: 'é'.repeat(131_073),
        path: '/synthetic/source/valid-skill/SKILL.md',
        sha256: baseSha256,
        skillName: 'valid-skill',
      }).success,
    ).toBe(false);
    expect(
      safeParse(projectSkillMarkdownDocumentSchema, {
        content: 'é'.repeat(32_769),
        path: '/synthetic/project/.agents/skills/valid-skill/SKILL.md',
        skillName: 'valid-skill',
        truncated: true,
      }).success,
    ).toBe(false);

    expect(safeParse(skillManagementSnapshotSchema, snapshotWithManifestMarkdown('a'.repeat(262_144))).success).toBe(
      true,
    );
    expect(safeParse(skillManagementSnapshotSchema, snapshotWithManifestMarkdown('a'.repeat(262_145))).success).toBe(
      false,
    );
    expect(safeParse(skillManagementSnapshotSchema, snapshotWithManifestMarkdown('é'.repeat(131_073))).success).toBe(
      false,
    );
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
