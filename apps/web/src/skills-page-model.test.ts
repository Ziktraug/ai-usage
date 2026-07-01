import { describe, expect, test } from 'bun:test';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { buildSkillSummaryTiles, projectionStateLabel, skillProjectionSummary } from './skills-page-model';

const snapshot: SkillManagementSnapshot = {
  config: { sourceRepoPath: '/repo/source' },
  configured: true,
  diagnostics: [],
  nativeRuleFindings: [],
  projections: [
    {
      diagnostics: [],
      expectedPath: '/target/example-skill',
      skillName: 'example-skill',
      state: 'missing',
      targetId: 'codex',
    },
  ],
  skills: [
    {
      description: 'Helps with examples',
      diagnostics: [],
      enabled: true,
      manifest: { description: 'Helps with examples', fields: [], markdown: '# Example\n', name: 'example-skill' },
      name: 'example-skill',
      path: '/repo/source/skills/example-skill',
      skillMdPath: '/repo/source/skills/example-skill/SKILL.md',
      validationStatus: 'valid',
    },
  ],
  sourceState: { version: 1, skillEnabledByName: {} },
  summary: {
    activeSkillCount: 1,
    diagnosticCount: 0,
    healthyProjectionCount: 0,
    skillCount: 1,
    targetCount: 1,
    unhealthyProjectionCount: 1,
    unmanagedEntryCount: 0,
  },
  targets: [],
  unmanagedEntries: [],
};

describe('skills page model', () => {
  test('builds summary tiles from snapshot counts', () => {
    expect(buildSkillSummaryTiles(snapshot).map((tile) => [tile.label, tile.value])).toEqual([
      ['Source', '/repo/source'],
      ['Skills', '1'],
      ['Active', '1'],
      ['Needs attention', '1'],
      ['Diagnostics', '0'],
    ]);
  });

  test('labels missing as not linked', () => {
    expect(projectionStateLabel('missing')).toBe('Not linked');
  });

  test('summarizes skill projection states', () => {
    const skill = snapshot.skills[0];
    if (!skill) {
      throw new Error('Expected skill fixture');
    }
    expect(skillProjectionSummary(skill, snapshot.projections)).toBe('Not linked');
  });
});
