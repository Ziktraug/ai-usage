import { describe, expect, test } from 'bun:test';
import type { SkillManagementSnapshot, SourceSkill } from '@ai-usage/skills';
import { snapshotRemovesDirtySkill } from './skills-route-model';

const skill = (name: string): SourceSkill => ({
  description: `${name} description`,
  diagnostics: [],
  enabled: true,
  manifest: { description: `${name} description`, fields: [], markdown: '# Skill\n', name },
  name,
  path: `/source/skills/${name}`,
  skillMdPath: `/source/skills/${name}/SKILL.md`,
  tokenCount: { approximate: true, references: 0, skillMd: 2, total: 2 },
  validationStatus: 'valid',
});

const snapshot = (skills: readonly SourceSkill[]): SkillManagementSnapshot => ({
  config: { sourceRepoPath: '/source' },
  configured: true,
  diagnostics: [],
  nativeRuleFindings: [],
  projections: [],
  skills,
  sourceState: { version: 1, skillEnabledByName: {} },
  summary: {
    activeSkillCount: skills.length,
    diagnosticCount: 0,
    healthyProjectionCount: 0,
    skillCount: skills.length,
    targetCount: 0,
    unhealthyProjectionCount: 0,
    unmanagedEntryCount: 0,
  },
  targets: [],
  unmanagedEntries: [],
});

describe('skills route snapshot replacement', () => {
  test('defers replacement only when it would remove the dirty skill', () => {
    const dirtyDraft = { dirty: true, skillName: 'alpha' };

    expect(snapshotRemovesDirtySkill(snapshot([skill('alpha')]), dirtyDraft)).toBe(false);
    expect(snapshotRemovesDirtySkill(snapshot([skill('beta')]), dirtyDraft)).toBe(true);
    expect(snapshotRemovesDirtySkill(snapshot([]), { dirty: false, skillName: 'alpha' })).toBe(false);
    expect(snapshotRemovesDirtySkill(snapshot([]), undefined)).toBe(false);
  });
});
