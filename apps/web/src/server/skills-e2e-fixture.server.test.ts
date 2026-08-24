import { describe, expect, test } from 'bun:test';
import {
  createE2ESkillTargetDirectory,
  previewE2EReconcileAllSkills,
  readE2EKnownSkillProjectPaths,
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
