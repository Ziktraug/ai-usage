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

  test('preserves strict structured token measurements and rejects malformed measurements', () => {
    const diagnostic = {
      code: 'SkillMarkdownTokenWarning',
      message: 'SKILL.md token warning',
      severity: 'warning' as const,
      tokenMeasurement: { observed: 1240, threshold: 1000, unit: 'tokens' as const },
    };
    const parsed = parseSkillSnapshotResult({
      data: { ...snapshot(), diagnostics: [diagnostic] },
      ok: true,
    });
    expect(parsed).toMatchObject({ data: { diagnostics: [diagnostic] }, ok: true });

    expect(() =>
      parseSkillSnapshotResult({
        data: {
          ...snapshot(),
          diagnostics: [{ ...diagnostic, tokenMeasurement: { observed: 1240, threshold: 1000, unit: 'bytes' } }],
        },
        ok: true,
      }),
    ).toThrow('Invalid skills snapshot response');
  });

  test('keeps unmanaged runtime entry names distinct from managed skill names', () => {
    const entry = {
      diagnostics: [],
      entryName: '.system',
      expectedPath: '/runtime/.system',
      state: 'unmanaged-copy' as const,
      targetId: 'codex',
    };
    const parsed = parseSkillSnapshotResult({
      data: { ...snapshot(), unmanagedEntries: [entry] },
      ok: true,
    });

    expect(parsed).toMatchObject({ data: { unmanagedEntries: [entry] }, ok: true });
    const { entryName: _entryName, ...legacyEntry } = entry;
    expect(() =>
      parseSkillSnapshotResult({
        data: { ...snapshot(), unmanagedEntries: [{ ...legacyEntry, skillName: '.system' }] },
        ok: true,
      }),
    ).toThrow('Invalid skills snapshot response');
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
