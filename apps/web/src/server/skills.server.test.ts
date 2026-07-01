import { describe, expect, test } from 'bun:test';
import {
  skillConfigInputFrom,
  skillNameInputFrom,
  skillTargetDirectoryInputFrom,
  skillToggleInputFrom,
} from './skills.server';

describe('skills server input validation', () => {
  test('accepts valid skill config inputs', () => {
    expect(skillConfigInputFrom({ sourceRepoPath: '/repo/source' })).toEqual({ sourceRepoPath: '/repo/source' });
  });

  test('rejects invalid skill names, target ids, and boolean toggles', () => {
    expect(() => skillNameInputFrom({ skillName: 'Example Skill' })).toThrow('skill name');
    expect(() => skillTargetDirectoryInputFrom({ targetId: 'codex/skills' })).toThrow('target id');
    expect(() => skillToggleInputFrom({ skillName: 'example-skill', enabled: 'false' })).toThrow('enabled');
  });

  test('rejects invalid config paths before workflow calls', () => {
    expect(() => skillConfigInputFrom({ sourceRepoPath: '' })).toThrow('sourceRepoPath');
  });
});
