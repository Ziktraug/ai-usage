import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  defaultTokenThresholds,
  parseSkillConfigInput,
  parseSkillFilePath,
  parseSkillMutationInput,
  parseSkillName,
  parseSkillTargetDirectoryInput,
  parseSkillToggleInput,
  parseTargetId,
} from '.';

describe('skill management domain validation', () => {
  test('accepts valid config input without defaulting project scan roots', () => {
    const config = parseSkillConfigInput({
      sourceRepoPath: '/repo/skills',
      projectPaths: ['/work/app'],
      targets: {
        codex: {
          enabled: true,
          kind: 'standard-interop',
          path: '/home/user/.codex/skills',
          scope: 'system',
        },
      },
      tokenThresholds: defaultTokenThresholds,
    });

    expect(config.sourceRepoPath).toBe('/repo/skills');
    expect(config.projectPaths).toEqual(['/work/app']);
    expect(config.projectsRootPath).toBeUndefined();
    expect(config.targets?.codex?.enabled).toBe(true);
  });

  test('rejects non-boolean skill config flags', () => {
    expect(() =>
      parseSkillConfigInput({
        targets: {
          codex: {
            enabled: 'true',
            kind: 'standard-interop',
            path: '/home/user/.codex/skills',
            scope: 'system',
          },
        },
      }),
    ).toThrow('enabled');
    expect(() => parseSkillConfigInput({ projectPaths: [''] })).toThrow('projectPaths');
  });

  test('validates skill names and target ids', () => {
    expect(parseSkillName('example-skill')).toBe('example-skill');
    expect(parseTargetId('codex')).toBe('codex');
    expect(() => parseSkillName('Example Skill')).toThrow('skill name');
    expect(() => parseTargetId('codex/skills')).toThrow('target id');
  });

  test('keeps server-facing file paths inside the selected skill directory', () => {
    const skillDirectory = path.join('/repo', 'skills', 'example-skill');

    expect(parseSkillFilePath('references/guide.md', skillDirectory)).toBe('references/guide.md');
    expect(() => parseSkillFilePath('/tmp/guide.md', skillDirectory)).toThrow('relative');
    expect(() => parseSkillFilePath('../other/SKILL.md', skillDirectory)).toThrow('inside');
  });

  test('validates mutation inputs strictly', () => {
    expect(
      parseSkillMutationInput({
        skillName: 'example-skill',
        targetId: 'codex',
        enabled: false,
      }),
    ).toEqual({
      enabled: false,
      skillName: 'example-skill',
      targetId: 'codex',
    });

    expect(() =>
      parseSkillMutationInput({
        skillName: 'example-skill',
        targetId: 'codex',
        enabled: 'false',
      }),
    ).toThrow('enabled');
  });

  test('validates toggle and target directory inputs strictly', () => {
    expect(parseSkillToggleInput({ skillName: 'example-skill', enabled: true })).toEqual({
      enabled: true,
      skillName: 'example-skill',
    });
    expect(parseSkillTargetDirectoryInput({ targetId: 'codex' })).toEqual({ targetId: 'codex' });

    expect(() => parseSkillToggleInput({ skillName: 'example-skill', enabled: 'true' })).toThrow('enabled');
    expect(() => parseSkillTargetDirectoryInput({ targetId: 'codex/skills' })).toThrow('target id');
  });
});
