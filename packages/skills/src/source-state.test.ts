import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkillSourceState, setSkillEnabled, skillSourceStatePath, writeSkillSourceState } from '.';

describe('skill source state', () => {
  test('missing state defaults to version 1 with no toggles', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-'));
    try {
      const result = await loadSkillSourceState(sourceRepoPath);

      expect(result.state).toEqual({ version: 1, skillEnabledByName: {} });
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('invalid state returns diagnostics instead of importing executable files', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-'));
    try {
      await mkdir(path.dirname(skillSourceStatePath(sourceRepoPath)), { recursive: true });
      await writeFile(skillSourceStatePath(sourceRepoPath), 'export default {};\n', 'utf8');

      const result = await loadSkillSourceState(sourceRepoPath);

      expect(result.state).toEqual({ version: 1, skillEnabledByName: {} });
      expect(result.diagnostics[0]?.code).toBe('InvalidSourceState');
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('toggles persist to JSON state', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-'));
    try {
      await writeSkillSourceState(sourceRepoPath, { version: 1, skillEnabledByName: { old: true } });
      const state = await setSkillEnabled(sourceRepoPath, 'example-skill', false);

      expect(state.skillEnabledByName).toEqual({
        'example-skill': false,
        old: true,
      });
      await expect(Bun.file(skillSourceStatePath(sourceRepoPath)).json()).resolves.toEqual({
        version: 1,
        skillEnabledByName: {
          'example-skill': false,
          old: true,
        },
      });
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });
});
