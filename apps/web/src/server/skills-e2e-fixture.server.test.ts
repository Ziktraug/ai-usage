import { describe, expect, test } from 'bun:test';
import {
  createE2ESkillTargetDirectory,
  previewE2EReconcileAllSkills,
  reconcileAllE2ESkills,
  reconcileE2ESkill,
  toggleE2ESkill,
  writeE2ESkillManagementConfig,
  writeE2ESkillMarkdown,
} from './skills-e2e-fixture.server';

describe('Skills E2E mutation backend', () => {
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
