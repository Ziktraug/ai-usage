import { describe, expect, test } from 'bun:test';
import type { ProjectSkillInventory, SkillManagementSnapshot } from '@ai-usage/skills';
import {
  parseProjectInventoriesResult,
  parseSkillReconcileResult,
  parseSkillSnapshotResult,
} from './skills-client-contracts';

const snapshot = (): SkillManagementSnapshot => ({
  config: { sourceRepoPath: '/skills' },
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
});

const inventory = (): ProjectSkillInventory => ({
  diagnostics: [],
  observations: [
    {
      description: 'Example skill',
      diagnostics: [],
      invocation: 'auto',
      markdownReadable: true,
      name: 'example-skill',
      path: '/project/.agents/skills/example-skill',
      placement: 'owned-directory',
      runtimeDirId: 'agents-project',
      skillMdPath: '/project/.agents/skills/example-skill/SKILL.md',
      tokenCount: { approximate: true, references: 1, skillMd: 2, total: 3 },
      validationStatus: 'valid',
    },
  ],
  projectPath: '/project',
});

describe('browser-safe Skills contracts', () => {
  test('rejects malformed nested snapshots and reconciliation actions', () => {
    const malformedSnapshots = [
      { ...snapshot(), config: { sourceRepoPath: 42 } },
      { ...snapshot(), diagnostics: [1] },
      { ...snapshot(), skills: [{ bad: true }] },
      { ...snapshot(), summary: {} },
      { ...snapshot(), targets: [false] },
    ];

    for (const malformed of malformedSnapshots) {
      expect(() => parseSkillSnapshotResult({ data: malformed, ok: true })).toThrow('Invalid skills snapshot response');
    }
    expect(() =>
      parseSkillReconcileResult({ data: { actions: [{ bad: true }], snapshot: snapshot() }, ok: true }),
    ).toThrow('Invalid skills reconcile response');
  });

  test('rejects incomplete project inventory observations before they reach UI state', () => {
    const valid = inventory();
    expect(parseProjectInventoriesResult({ data: [valid], ok: true })).toEqual({ data: [valid], ok: true });

    const observation = valid.observations[0];
    if (!observation) {
      throw new Error('Expected the test inventory to contain one observation');
    }
    const { placement: _placement, ...incomplete } = observation;
    expect(() =>
      parseProjectInventoriesResult({
        data: [{ ...valid, observations: [incomplete] }],
        ok: true,
      }),
    ).toThrow('Invalid skill inventories response');
  });
});
