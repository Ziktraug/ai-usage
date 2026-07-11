import { expect, test } from 'bun:test';
import { parseSkillConfigInput } from '@ai-usage/skills/config';
import { skillNameInputForClient, targetIdInputForClient } from './skill-input-validation';

test('client skill-name validation rejects numeric-leading names consistently with the domain', () => {
  expect(() => skillNameInputForClient('1-example-skill')).toThrow('skill name');
  expect(skillNameInputForClient('example-skill-1')).toBe('example-skill-1');
});

test('client target-id validation rejects numeric-leading ids consistently with the domain', () => {
  expect(() => targetIdInputForClient('1-codex')).toThrow('target id');
  expect(targetIdInputForClient('codex-1')).toBe('codex-1');
});

test('client skill config validation narrows every supported nested field', () => {
  const config = {
    connectors: { bridge: { consumesTargets: ['codex'], enabled: true } },
    ignoredTargetFindings: ['native-rule'],
    projectPaths: ['/work/project'],
    projectsRootPath: '/work',
    sourceRepoPath: '/work/skills',
    targets: {
      codex: { enabled: true, kind: 'standard-interop', path: '/home/user/.codex/skills', scope: 'system' },
    },
    tokenThresholds: {
      referenceFile: { high: 2000, warn: 1000 },
      skillMd: { high: 4000, warn: 2000 },
      totalSkill: { high: 8000, warn: 4000 },
    },
  } as const;

  expect(parseSkillConfigInput(config)).toEqual(config);
  expect(() => parseSkillConfigInput({ targets: { codex: { ...config.targets.codex, enabled: 'yes' } } })).toThrow(
    'targets.codex.enabled',
  );
  expect(() =>
    parseSkillConfigInput({ tokenThresholds: { ...config.tokenThresholds, skillMd: { high: 0, warn: 1 } } }),
  ).toThrow('tokenThresholds.skillMd.high');
});
