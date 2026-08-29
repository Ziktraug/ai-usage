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
  skillObservationsSchema,
  skillObservationVerdicts,
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
  'observations',
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
  test('declares all fourteen operations and the frozen semantic intents', () => {
    expect(Object.keys(skillsContract).sort()).toEqual(procedureNames);
    expect(skillsProcedureIntents).toEqual({
      createTargetDirectory: 'mutation',
      projectInventories: 'query',
      knownProjectPaths: 'query',
      observations: 'query',
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
      observations: 'GET',
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

  test('carries every observation tier with its harness and never a place to sum them', () => {
    const observations = {
      harnesses: [
        { harnessKey: 'claude', label: 'Claude Code', observability: 'observable' },
        { harnessKey: 'codex', label: 'Codex', observability: 'observable' },
        { harnessKey: 'opencode', label: 'OpenCode', observability: 'observable' },
        { harnessKey: 'cursor', label: 'Cursor', observability: 'not-observable' },
      ],
      lowerBound: false,
      skills: [
        {
          deletionCandidate: false,
          lastObservedAt: '2026-08-03T09:01:00.000Z',
          managed: true,
          projectedEverywhere: true,
          resolvedPaths: ['/home/alex/.agents/skills/pr-review'],
          resolvedPathsTruncated: false,
          skillName: 'pr-review',
          tallies: [
            {
              count: 2,
              harnessKey: 'claude',
              harnessLabel: 'Claude Code',
              lastObservedAt: '2026-08-01T09:00:00.000Z',
              tier: 'declared',
            },
            {
              count: 1,
              harnessKey: 'codex',
              harnessLabel: 'Codex',
              lastObservedAt: '2026-08-03T09:01:00.000Z',
              tier: 'inferred',
            },
            {
              count: 4,
              harnessKey: 'codex',
              harnessLabel: 'Codex',
              lastObservedAt: '2026-08-03T09:00:00.000Z',
              tier: 'exposed',
            },
          ],
          verdict: 'invoked',
          verdictProvisional: false,
        },
      ],
      skipped: 0,
    };

    expect(safeParse(skillObservationsSchema, observations).success).toBe(true);
    // A tally without its tier, or without its harness, is not a thing this wire shape can carry.
    expect(
      safeParse(skillObservationsSchema, {
        ...observations,
        skills: [
          {
            ...observations.skills[0],
            tallies: [{ count: 3, harnessLabel: 'Claude Code', lastObservedAt: '2026-08-01T09:00:00.000Z' }],
          },
        ],
      }).success,
    ).toBe(false);
    // And there is no field a sum of declared and inferred could be written into.
    expect(
      safeParse(skillObservationsSchema, {
        ...observations,
        skills: [{ ...observations.skills[0], total: 7 }],
      }).success,
    ).toBe(false);
    expect(safeParse(skillObservationsSchema, { ...observations, total: 7 }).success).toBe(false);
  });

  test('carries the verdict the server decided, and only the verdicts it may decide', () => {
    const base = {
      harnesses: [{ harnessKey: 'claude', label: 'Claude Code', observability: 'observable' }],
      lowerBound: false,
      skills: [
        {
          deletionCandidate: true,
          // A skill with no observation at all still travels: dropping it would erase the deletion
          // verdict this family exists to produce.
          lastObservedAt: null,
          managed: true,
          projectedEverywhere: true,
          resolvedPaths: [],
          resolvedPathsTruncated: false,
          skillName: 'never-used',
          tallies: [],
          verdict: 'never-observed',
          verdictProvisional: false,
        },
      ],
      skipped: 0,
    };

    expect(safeParse(skillObservationsSchema, base).success).toBe(true);
    for (const verdict of skillObservationVerdicts) {
      expect(safeParse(skillObservationsSchema, { ...base, skills: [{ ...base.skills[0], verdict }] }).success).toBe(
        true,
      );
    }
    // "observed" is not a verdict: it does not distinguish being used from being offered.
    for (const verdict of ['observed', 'unmanaged', 'exposed']) {
      expect(safeParse(skillObservationsSchema, { ...base, skills: [{ ...base.skills[0], verdict }] }).success).toBe(
        false,
      );
    }
    // The provisional marker is required, so a producer cannot omit the fact that an absence claim
    // rests on an incomplete read.
    const { verdictProvisional, ...withoutProvisional } = base.skills[0] as Record<string, unknown>;
    expect(verdictProvisional).toBe(false);
    expect(safeParse(skillObservationsSchema, { ...base, skills: [withoutProvisional] }).success).toBe(false);
  });

  test('accepts an unresolved observation and refuses to lose it to the managed-name pattern', () => {
    const unresolved = {
      harnesses: [{ harnessKey: 'claude', label: 'Claude Code', observability: 'observable' }],
      lowerBound: false,
      skills: [
        {
          deletionCandidate: false,
          lastObservedAt: '2026-08-01T09:05:00.000Z',
          managed: false,
          projectedEverywhere: false,
          // A harness-bundled skill: it resolves to no inventory entry and to no directory. Both
          // are states, and both must survive the presentation edge (ADR 0022).
          resolvedPaths: [],
          resolvedPathsTruncated: false,
          skillName: 'artifact-design',
          tallies: [
            {
              count: 1,
              harnessKey: 'claude',
              harnessLabel: 'Claude Code',
              lastObservedAt: '2026-08-01T09:05:00.000Z',
              tier: 'declared',
            },
          ],
          verdict: 'invoked-unmanaged',
          verdictProvisional: false,
        },
      ],
      skipped: 0,
    };

    expect(safeParse(skillObservationsSchema, unresolved).success).toBe(true);
    // Names the managed pattern would reject are still valid observed names.
    for (const skillName of ['Artifact_Design', 'plugin:code-review', 'skill.with.dots', 'ünïcødé']) {
      expect(
        safeParse(skillObservationsSchema, { ...unresolved, skills: [{ ...unresolved.skills[0], skillName }] }),
      ).toMatchObject({ success: true });
    }
    // Control characters are the one class that cannot be rendered as text.
    expect(
      safeParse(skillObservationsSchema, {
        ...unresolved,
        skills: [{ ...unresolved.skills[0], skillName: `bad${String.fromCodePoint(7)}name` }],
      }).success,
    ).toBe(false);
    expect(
      safeParse(skillObservationsSchema, { ...unresolved, skills: [{ ...unresolved.skills[0], skillName: '' }] })
        .success,
    ).toBe(false);
  });

  test('requires the harness roster and a canonical timestamp on every observation count', () => {
    const base = {
      harnesses: [{ harnessKey: 'cursor', label: 'Cursor', observability: 'not-observable' }],
      lowerBound: true,
      skills: [],
      skipped: 2,
    };

    expect(safeParse(skillObservationsSchema, base).success).toBe(true);
    // An empty roster would leave a consumer unable to tell "cannot observe" from "observed nothing".
    expect(safeParse(skillObservationsSchema, { ...base, harnesses: [] }).success).toBe(false);
    expect(
      safeParse(skillObservationsSchema, {
        ...base,
        harnesses: [{ harnessKey: 'cursor', label: 'Cursor', observability: 'partial' }],
      }).success,
    ).toBe(false);
    expect(
      safeParse(skillObservationsSchema, {
        ...base,
        skills: [
          {
            deletionCandidate: false,
            lastObservedAt: '2026-08-01',
            managed: true,
            projectedEverywhere: false,
            resolvedPaths: [],
            resolvedPathsTruncated: false,
            skillName: 'improve',
            tallies: [
              {
                count: 1,
                harnessKey: 'claude',
                harnessLabel: 'Claude Code',
                lastObservedAt: '2026-08-01T09:00:00.000Z',
                tier: 'declared',
              },
            ],
            verdict: 'invoked',
            verdictProvisional: false,
          },
        ],
      }).success,
    ).toBe(false);
    expect(safeParse(skillObservationsSchema, { ...base, skipped: -1 }).success).toBe(false);
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
