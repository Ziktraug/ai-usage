import { describe, expect, test } from 'bun:test';
import { FIXTURE_SKILL_NAMES } from '@ai-usage/local-machine/testing/harness-home';
import { skillObservationsSchema } from '@ai-usage/web-contract/skills';
import { safeParse } from 'valibot';
import {
  createE2ESkillTargetDirectory,
  e2eUnmanagedObservedSkillNames,
  previewE2EReconcileAllSkills,
  readE2EKnownSkillProjectPaths,
  readE2ESkillObservations,
  readE2ESkillProjectInventories,
  readExtendedE2EKnownSkillProjectPaths,
  readExtendedE2ESkillProjectInventories,
  reconcileAllE2ESkills,
  reconcileE2ESkill,
  toggleE2ESkill,
  writeE2ESkillManagementConfig,
  writeE2ESkillMarkdown,
} from './skills-e2e-fixture.server';

describe('Skills E2E mutation backend', () => {
  test('keeps the stable visual fixture free of opaque route data', () => {
    const knownPaths = readE2EKnownSkillProjectPaths();
    const inventories = readE2ESkillProjectInventories();
    expect(knownPaths.ok && knownPaths.data.some((entry) => entry.groupId === 'project/opaque')).toBe(false);
    expect(inventories.ok && inventories.data.some((entry) => entry.projectPath.includes('opaque'))).toBe(false);
  });

  test('keeps the opaque project routes backed by synthetic data', () => {
    const knownPaths = readExtendedE2EKnownSkillProjectPaths();
    const inventories = readExtendedE2ESkillProjectInventories();
    expect(knownPaths.ok && knownPaths.data[0]).toMatchObject({
      groupId: 'project/opaque',
      path: '/fixture/projects/opaque-project-source',
    });
    expect(inventories.ok && inventories.data[0]).toMatchObject({
      observations: [{ name: 'skill-name' }],
      projectPath: '/fixture/projects/opaque-project-source',
    });
    expect(knownPaths.ok && knownPaths.data).toContainEqual(
      expect.objectContaining({
        groupId: 'project/opaque-twin',
        groupLabel: 'Opaque project',
        path: '/fixture/work/opaque-project-source',
      }),
    );
    expect(inventories.ok && inventories.data).toContainEqual(
      expect.objectContaining({
        observations: [expect.objectContaining({ name: 'twin-skill' })],
        projectPath: '/fixture/work/opaque-project-source',
      }),
    );
  });

  test('serves an observation set covering all three tiers with Cursor not observable', () => {
    const result = readE2ESkillObservations();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // It must survive the same presentation edge the real read does.
    expect(safeParse(skillObservationsSchema, result.data).success).toBe(true);
    expect(result.data.harnesses).toEqual([
      { harnessKey: 'claude', label: 'Claude Code', observability: 'observable' },
      { harnessKey: 'codex', label: 'Codex', observability: 'observable' },
      { harnessKey: 'opencode', label: 'OpenCode', observability: 'observable' },
      { harnessKey: 'cursor', label: 'Cursor', observability: 'not-observable' },
    ]);
    const tiers = new Set(result.data.skills.flatMap((skill) => skill.tallies.map(({ tier }) => tier)));
    expect([...tiers].sort()).toEqual(['declared', 'exposed', 'inferred']);
    // Cursor contributes no tally at all, so nothing downstream can render it as a count.
    expect(result.data.skills.flatMap((skill) => skill.tallies).some(({ harnessKey }) => harnessKey === 'cursor')).toBe(
      false,
    );
    // A managed skill observed at more than one tier, and unmanaged names that resolve to nothing.
    expect(result.data.skills.find(({ skillName }) => skillName === 'alpha-skill')?.tallies.length).toBeGreaterThan(2);
    expect(result.data.skills.find(({ skillName }) => skillName === 'artifact-design')?.resolvedPaths).toEqual([]);
  });

  test('names the same unmanaged skills the shared synthetic home seeds', () => {
    // The e2e runtime serves a fixture rather than a collected store, so this keeps its vocabulary
    // pinned to what `seedHarnessHome({ skillSignals: true })` actually produces. If that fixture's
    // names change, the surface under test stops standing in for a real collection and this fails.
    const seededUnmanaged = [
      FIXTURE_SKILL_NAMES.claudeUnresolved,
      FIXTURE_SKILL_NAMES.codexExposed,
      FIXTURE_SKILL_NAMES.codexUnread,
    ];
    expect([...e2eUnmanagedObservedSkillNames()].sort()).toEqual([...seededUnmanaged].sort());
  });

  test('provides deterministic responses for every Skills mutation', () => {
    expect(writeE2ESkillManagementConfig({ sourceRepoPath: '/fixture/changed' }).ok).toBe(true);
    expect(toggleE2ESkill({ enabled: false, skillName: 'alpha-skill' }).ok).toBe(true);
    expect(reconcileE2ESkill('alpha-skill').ok).toBe(true);
    expect(reconcileAllE2ESkills().ok).toBe(true);
    expect(previewE2EReconcileAllSkills().ok).toBe(true);
    expect(createE2ESkillTargetDirectory({ targetId: 'codex' }).ok).toBe(true);
    expect(
      writeE2ESkillMarkdown({
        baseSha256: 'a'.repeat(64),
        content: '# Changed fixture\n',
        skillName: 'alpha-skill',
      }).ok,
    ).toBe(true);
  });
});
