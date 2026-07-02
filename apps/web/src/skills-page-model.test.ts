import { describe, expect, test } from 'bun:test';
import type {
  Projection,
  ProjectionAction,
  ProjectSkillInventory,
  ProjectSkillObservation,
  SkillManagementSnapshot,
  SkillTarget,
  SourceSkill,
} from '@ai-usage/skills';
import {
  buildGlobalSkillExposure,
  buildSkillHealthSummary,
  buildSkillMatrix,
  buildSkillTree,
  canReconcileAll,
  defaultSkillSelection,
  describeReconcileActions,
  filterMatrixRows,
  findProjectSkillRow,
  groupUnmanagedEntries,
  projectionStateLabel,
  selectionKey,
  skillInvocation,
} from './skills-page-model';

const target = (id: string, label: string, enabled = true): SkillTarget => ({
  enabled,
  id,
  kind: 'standard-interop',
  label,
  missing: false,
  observed: true,
  path: `/targets/${id}`,
  scope: 'system',
});

const skill = (name: string, overrides: Partial<SourceSkill> = {}): SourceSkill => ({
  description: `${name} description`,
  diagnostics: [],
  enabled: true,
  manifest: { description: `${name} description`, fields: [], markdown: '# Skill\n', name },
  name,
  path: `/source/skills/${name}`,
  skillMdPath: `/source/skills/${name}/SKILL.md`,
  tokenCount: { approximate: true, references: 1, skillMd: 2, total: 3 },
  validationStatus: 'valid',
  ...overrides,
});

const projection = (skillName: string, targetId: string, state: Projection['state']): Projection => ({
  diagnostics: [],
  expectedPath: `/targets/${targetId}/${skillName}`,
  skillName,
  state,
  targetId,
});

const projectObservation = (
  name: string,
  runtimeDirId: ProjectSkillObservation['runtimeDirId'],
  overrides: Partial<ProjectSkillObservation> = {},
): ProjectSkillObservation => ({
  description: `${name} project description`,
  diagnostics: [],
  invocation: 'auto',
  name,
  path: `/project/.claude/skills/${name}`,
  placement: 'owned-directory',
  runtimeDirId,
  skillMdPath: `/project/.claude/skills/${name}/SKILL.md`,
  tokenCount: { approximate: true, references: 1, skillMd: 2, total: 3 },
  validationStatus: 'valid',
  ...overrides,
});

const projectInventory = (
  projectPath: string,
  observations: readonly ProjectSkillObservation[],
  overrides: Partial<ProjectSkillInventory> = {},
): ProjectSkillInventory => ({
  diagnostics: [],
  observations,
  projectPath,
  ...overrides,
});

const makeSnapshot = (overrides: Partial<SkillManagementSnapshot> = {}): SkillManagementSnapshot => ({
  config: { sourceRepoPath: '/source' },
  configured: true,
  diagnostics: [],
  nativeRuleFindings: [],
  projections: [],
  skills: [],
  sourceState: { version: 1, skillEnabledByName: {} },
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
  ...overrides,
});

describe('skills page model', () => {
  test('labels missing as not linked', () => {
    expect(projectionStateLabel('missing')).toBe('Not linked');
  });

  test('derives manual invocation from the known frontmatter extension', () => {
    expect(skillInvocation(skill('auto-skill'))).toBe('auto');
    expect(
      skillInvocation(
        skill('manual-skill', {
          manifest: {
            description: 'Manual',
            fields: [{ key: 'disable-model-invocation', kind: 'known-extension', value: true }],
            markdown: '# Manual\n',
            name: 'manual-skill',
          },
        }),
      ),
    ).toBe('manual');
  });

  test('builds a matrix with active targets and disabled skills last', () => {
    const snapshot = makeSnapshot({
      projections: [projection('alpha-skill', 'codex', 'linked'), projection('disabled-skill', 'codex', 'linked')],
      skills: [
        skill('disabled-skill', { enabled: false }),
        skill('alpha-skill', {
          diagnostics: [{ code: 'SkillFileTooLarge', message: 'large', severity: 'warning', skillName: 'alpha-skill' }],
          tokenCount: { approximate: true, references: 4, skillMd: 5, total: 9 },
        }),
      ],
      sourceState: { version: 1, skillEnabledByName: {}, skillOriginByName: { 'alpha-skill': 'github' } },
      targets: [target('codex', 'Codex'), target('cursor', 'Cursor', false)],
    });

    const matrix = buildSkillMatrix(snapshot);

    expect(matrix.targets.map((entry) => entry.id)).toEqual(['codex']);
    expect(matrix.rows.map((row) => row.name)).toEqual(['alpha-skill', 'disabled-skill']);
    expect(matrix.rows[0]).toMatchObject({ origin: 'github', tokenFlag: true, tokenTotal: 9 });
    expect(matrix.rows[1]?.cells[0]).toEqual({ label: 'Disabled', state: 'not-applicable', targetId: 'codex' });
  });

  test('builds a scope tree with global and project skills sorted by attention', () => {
    const snapshot = makeSnapshot({
      projections: [projection('healthy-skill', 'codex', 'linked'), projection('repair-skill', 'codex', 'broken-link')],
      skills: [skill('healthy-skill'), skill('repair-skill')],
      targets: [target('codex', 'Codex')],
    });
    const inventories = [
      projectInventory('/work/ai-usage', [
        projectObservation('project-owned', 'claude-project'),
        projectObservation('external-helper', 'agents-project', { placement: 'external-symlink' }),
      ]),
    ];

    const tree = buildSkillTree(snapshot, inventories);

    expect(tree.scopes.map((scope) => scope.label)).toEqual(['Global', 'ai-usage']);
    expect(tree.scopes[0]?.skills.map((node) => node.name)).toEqual(['repair-skill', 'healthy-skill']);
    expect(tree.scopes[0]?.attentionCount).toBe(1);
    expect(tree.scopes[1]?.skills.map((node) => node.name)).toEqual(['external-helper', 'project-owned']);
    expect(tree.scopes[1]?.attentionCount).toBe(1);
  });

  test('chooses the first global skill needing attention as the default selection', () => {
    const snapshot = makeSnapshot({
      projections: [projection('alpha-skill', 'codex', 'linked'), projection('beta-skill', 'codex', 'missing')],
      skills: [skill('alpha-skill'), skill('beta-skill')],
      targets: [target('codex', 'Codex')],
    });

    expect(defaultSkillSelection(snapshot, [])).toEqual({ skillName: 'beta-skill', type: 'global-skill' });
    expect(selectionKey({ skillName: 'beta-skill', type: 'global-skill' })).toBe('global:beta-skill');
  });

  test('builds global exposure rows with synthetic missing projections', () => {
    const snapshot = makeSnapshot({
      projections: [projection('alpha-skill', 'codex', 'linked')],
      skills: [skill('alpha-skill')],
      targets: [target('codex', 'Codex'), target('opencode', 'OpenCode')],
    });

    expect(buildGlobalSkillExposure(snapshot, 'alpha-skill')).toEqual([
      {
        canReconcile: false,
        expectedPath: '/targets/codex/alpha-skill',
        label: 'Linked',
        state: 'linked',
        targetId: 'codex',
      },
      {
        canReconcile: true,
        expectedPath: '/targets/opencode/alpha-skill',
        label: 'Not linked',
        state: 'missing',
        targetId: 'opencode',
      },
    ]);
  });

  test('groups project skill observations by name', () => {
    const inventory = projectInventory('/work/ai-usage', [
      projectObservation('shared-skill', 'claude-project', { invocation: 'manual', validationStatus: 'warning' }),
      projectObservation('shared-skill', 'agents-project'),
    ]);

    const row = findProjectSkillRow([inventory], '/work/ai-usage', 'shared-skill');

    expect(row).toMatchObject({
      invocation: 'manual',
      name: 'shared-skill',
      tokenTotal: 3,
      validationStatus: 'warning',
    });
    expect(row?.observations.map((observation) => observation.runtimeDirId)).toEqual([
      'agents-project',
      'claude-project',
    ]);
  });

  test('counts every health bucket against countable skills and active targets', () => {
    const snapshot = makeSnapshot({
      projections: [
        projection('linked-skill', 'codex', 'linked'),
        projection('linked-skill', 'claude-code', 'missing'),
        projection('repair-skill', 'codex', 'broken-link'),
        projection('repair-skill', 'claude-code', 'unmanaged-copy'),
        projection('invalid-skill', 'codex', 'wrong-target'),
      ],
      skills: [
        skill('linked-skill'),
        skill('repair-skill'),
        skill('disabled-skill', { enabled: false }),
        skill('invalid-skill', { validationStatus: 'invalid' }),
      ],
      targets: [target('codex', 'Codex'), target('claude-code', 'Claude Code'), target('cursor', 'Cursor', false)],
      unmanagedEntries: [projection('local-copy', 'codex', 'unmanaged-copy')],
    });

    expect(buildSkillHealthSummary(snapshot)).toEqual({
      blockedCount: 1,
      consolidateCopies: 1,
      consolidateCount: 1,
      consolidateSymlinks: 0,
      disabledCount: 1,
      expectedLinkCount: 4,
      healthyLinkCount: 1,
      toLinkCount: 1,
      toRepairCount: 1,
    });
  });

  test('groups unmanaged entries by runtime', () => {
    const snapshot = makeSnapshot({
      targets: [target('codex', 'Codex'), target('claude-code', 'Claude Code')],
      unmanagedEntries: [
        projection('copy-one', 'codex', 'unmanaged-copy'),
        projection('copy-two', 'codex', 'unmanaged-copy'),
        projection('link-one', 'codex', 'unmanaged-symlink'),
      ],
    });

    expect(groupUnmanagedEntries(snapshot)).toEqual([
      {
        copies: 2,
        entries: [
          {
            name: 'copy-one',
            path: '/targets/codex/copy-one',
            state: 'unmanaged-copy',
          },
          {
            name: 'copy-two',
            path: '/targets/codex/copy-two',
            state: 'unmanaged-copy',
          },
          {
            name: 'link-one',
            path: '/targets/codex/link-one',
            state: 'unmanaged-symlink',
          },
        ],
        symlinks: 1,
        targetId: 'codex',
        targetLabel: 'Codex',
        targetPath: '/targets/codex',
        total: 3,
      },
    ]);
  });

  test('filters rows by invocation and description query', () => {
    const rows = buildSkillMatrix(
      makeSnapshot({
        projections: [
          projection('alpha-skill', 'codex', 'linked'),
          projection('beta-skill', 'codex', 'unmanaged-copy'),
          projection('missing-skill', 'codex', 'missing'),
        ],
        skills: [
          skill('alpha-skill', { description: 'Reviews pull requests' }),
          skill('beta-skill', {
            description: 'Manual release helper',
            manifest: {
              description: 'Manual release helper',
              fields: [{ key: 'disable-model-invocation', kind: 'known-extension', value: true }],
              markdown: '# Beta\n',
              name: 'beta-skill',
            },
          }),
          skill('missing-skill'),
        ],
        targets: [target('codex', 'Codex')],
      }),
    ).rows;

    expect(filterMatrixRows(rows, { invocation: 'manual' }).map((row) => row.name)).toEqual(['beta-skill']);
    expect(filterMatrixRows(rows, { origin: 'github' }).map((row) => row.name)).toEqual([]);
    expect(filterMatrixRows(rows, { query: 'pull' }).map((row) => row.name)).toEqual(['alpha-skill']);
    expect(filterMatrixRows(rows, { cellState: 'blocked' }).map((row) => row.name)).toEqual(['beta-skill']);
    expect(filterMatrixRows(rows, { cellState: 'linked' }).map((row) => row.name)).toEqual(['alpha-skill']);
    expect(filterMatrixRows(rows, { cellState: 'not-linked' }).map((row) => row.name)).toEqual(['missing-skill']);
  });

  test('allows reconcile all with unmanaged entries present when a safe action exists', () => {
    const snapshot = makeSnapshot({
      projections: [projection('alpha-skill', 'codex', 'missing')],
      skills: [skill('alpha-skill')],
      targets: [target('codex', 'Codex')],
      unmanagedEntries: [projection('local-copy', 'codex', 'unmanaged-copy')],
    });

    expect(canReconcileAll(snapshot)).toBe(true);
    expect(
      canReconcileAll({
        ...snapshot,
        projections: [projection('alpha-skill', 'codex', 'linked')],
      }),
    ).toBe(false);
  });

  test('keeps warning skills reconciliable and excludes invalid ones', () => {
    const base = makeSnapshot({
      projections: [projection('warned-skill', 'codex', 'broken-link')],
      skills: [skill('warned-skill', { validationStatus: 'warning' })],
      targets: [target('codex', 'Codex')],
    });

    expect(canReconcileAll(base)).toBe(true);
    expect(
      canReconcileAll({
        ...base,
        skills: [skill('warned-skill', { validationStatus: 'invalid' })],
      }),
    ).toBe(false);
  });

  test('describes planned reconcile actions with runtime labels and skip reasons', () => {
    const actions: ProjectionAction[] = [
      {
        path: '/home/user/.codex/skills/alpha-skill',
        skillName: 'alpha-skill',
        sourcePath: '/repo/skills/alpha-skill',
        targetId: 'codex',
        type: 'create-symlink',
      },
      {
        path: '/home/user/.claude/skills/alpha-skill',
        skillName: 'alpha-skill',
        sourcePath: '/repo/skills/alpha-skill',
        targetId: 'claude-code',
        type: 'repair-symlink',
      },
      {
        path: '/home/user/.agents/skills/beta-skill',
        reason: 'refusing to modify unmanaged copy',
        skillName: 'beta-skill',
        targetId: 'standard-agents',
        type: 'refuse-unmanaged-mutation',
      },
    ];
    const targets = [target('codex', 'Codex'), target('claude-code', 'Claude Code')];

    const summary = describeReconcileActions(actions, targets);

    expect(summary.apply).toEqual([
      'link alpha-skill @ Codex → /home/user/.codex/skills/alpha-skill',
      'repair alpha-skill @ Claude Code → /home/user/.claude/skills/alpha-skill',
    ]);
    expect(summary.skipped).toEqual(['beta-skill @ standard-agents — refusing to modify unmanaged copy']);
  });
});
