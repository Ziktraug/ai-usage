import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

  test('bounds source-state reads before parsing JSON', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-large-'));
    try {
      await mkdir(path.dirname(skillSourceStatePath(sourceRepoPath)), { recursive: true });
      await writeFile(skillSourceStatePath(sourceRepoPath), `{"padding":"${'x'.repeat(1_048_576)}"}`, 'utf8');

      const result = await loadSkillSourceState(sourceRepoPath);

      expect(result.state).toEqual({ version: 1, skillEnabledByName: {} });
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['InvalidSourceState']);
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

  test('concurrent toggles serialize their read-modify-write updates', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-'));
    try {
      await Promise.all([
        setSkillEnabled(sourceRepoPath, 'alpha-skill', false),
        setSkillEnabled(sourceRepoPath, 'beta-skill', false),
      ]);

      await expect(Bun.file(skillSourceStatePath(sourceRepoPath)).json()).resolves.toEqual({
        version: 1,
        skillEnabledByName: {
          'alpha-skill': false,
          'beta-skill': false,
        },
      });
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('serializes read-modify-write updates across processes and canonical path aliases', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-process-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const sourceAliasPath = path.join(root, 'source-alias');
      const barrierPath = path.join(root, 'go');
      const readyPath = path.join(root, 'ready');
      await mkdir(sourceRepoPath);
      await mkdir(readyPath);
      await symlink(sourceRepoPath, sourceAliasPath);
      const names = Array.from({ length: 8 }, (_, index) => `process-skill-${index}`);
      const subprocessPath = path.join(import.meta.dir, 'test-fixtures', 'skills-subprocess.ts');
      const processes = names.map((skillName, index) =>
        Bun.spawn(
          [
            process.execPath,
            subprocessPath,
            'toggle',
            index % 2 === 0 ? sourceRepoPath : sourceAliasPath,
            skillName,
            readyPath,
            barrierPath,
          ],
          { stderr: 'pipe', stdout: 'pipe' },
        ),
      );
      while ((await Array.fromAsync(new Bun.Glob('*').scan({ cwd: readyPath }))).length < names.length) {
        await Bun.sleep(5);
      }
      await writeFile(barrierPath, 'go', 'utf8');

      const exitCodes = await Promise.all(processes.map((subprocess) => subprocess.exited));
      expect(exitCodes).toEqual(names.map(() => 0));
      const loaded = await loadSkillSourceState(sourceRepoPath);
      expect(loaded.state.skillEnabledByName).toEqual(Object.fromEntries(names.map((name) => [name, false])));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('creates state with owner-only permissions', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-mode-'));
    try {
      await setSkillEnabled(sourceRepoPath, 'example-skill', false);

      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX modes are bitmasks.
      expect((await stat(skillSourceStatePath(sourceRepoPath))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('refuses a source-state directory symlink that escapes the source repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-link-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const externalTrackerPath = path.join(root, 'external-tracker');
      await mkdir(sourceRepoPath);
      await mkdir(externalTrackerPath);
      await symlink(externalTrackerPath, path.join(sourceRepoPath, '.skill-tracker'));

      await expect(setSkillEnabled(sourceRepoPath, 'example-skill', false)).rejects.toThrow('symlink');
      await expect(readFile(path.join(externalTrackerPath, 'state.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a source-state file symlink instead of replacing or following it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-link-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const trackerPath = path.join(sourceRepoPath, '.skill-tracker');
      const externalStatePath = path.join(root, 'external-state.json');
      const externalContent = '{"outside":true}\n';
      await mkdir(trackerPath, { recursive: true });
      await writeFile(externalStatePath, externalContent, 'utf8');
      await symlink(externalStatePath, skillSourceStatePath(sourceRepoPath));

      await expect(
        writeSkillSourceState(sourceRepoPath, { version: 1, skillEnabledByName: { 'example-skill': false } }),
      ).rejects.toThrow('symlink');
      await expect(readFile(externalStatePath, 'utf8')).resolves.toBe(externalContent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('origin metadata round-trips and drops invalid entries with diagnostics', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-'));
    try {
      await mkdir(path.join(sourceRepoPath, '.skill-tracker'), { recursive: true });
      await writeFile(
        skillSourceStatePath(sourceRepoPath),
        JSON.stringify({
          skillEnabledByName: { 'example-skill': true },
          skillOriginByName: { 'bad-skill': false, 'example-skill': 'github' },
          version: 1,
        }),
        'utf8',
      );

      const loaded = await loadSkillSourceState(sourceRepoPath);
      expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['InvalidSkillOriginMetadata']);
      expect(loaded.state.skillOriginByName).toEqual({ 'example-skill': 'github' });

      await setSkillEnabled(sourceRepoPath, 'example-skill', false);
      const roundTripped = await loadSkillSourceState(sourceRepoPath);
      expect(roundTripped.state.skillOriginByName).toEqual({ 'example-skill': 'github' });
      expect(roundTripped.state.skillEnabledByName).toEqual({ 'example-skill': false });
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('writer rejects invalid origin metadata', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-state-'));
    try {
      await expect(
        writeSkillSourceState(sourceRepoPath, {
          skillEnabledByName: {},
          skillOriginByName: { 'example-skill': false },
          version: 1,
        } as never),
      ).rejects.toThrow('source skill state');
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });
});
