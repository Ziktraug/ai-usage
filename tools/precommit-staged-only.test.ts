import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temporaryDirectories = new Set<string>();
const repositoryRoot = path.resolve(import.meta.dir, '..');

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })));
  temporaryDirectories.clear();
});

const run = async (cwd: string, command: string[]): Promise<string> => {
  const child = Bun.spawn(command, { cwd, env: process.env, stderr: 'pipe', stdout: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed (${exitCode}): ${stderr}`);
  }
  return stdout;
};

describe('staged-only pre-commit formatting', () => {
  test('formats the index while preserving unstaged and untracked bytes', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'ai-usage-lint-staged-'));
    temporaryDirectories.add(fixture);
    await run(fixture, ['git', 'init', '--quiet']);
    await run(fixture, ['git', 'config', 'user.email', 'fixture@example.invalid']);
    await run(fixture, ['git', 'config', 'user.name', 'Fixture']);
    await writeFile(path.join(fixture, '.gitignore'), 'node_modules/\n');
    await symlink(path.join(repositoryRoot, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
    await writeFile(path.join(fixture, 'biome.json'), await readFile(path.join(repositoryRoot, 'biome.json')));
    await writeFile(path.join(fixture, 'staged.ts'), 'export const staged = 1;\n');
    await writeFile(path.join(fixture, 'partial.ts'), 'export const partial = 1;\n');
    await writeFile(path.join(fixture, 'unstaged.ts'), 'export const unstaged = 1;\n');
    await run(fixture, ['git', 'add', '.']);
    await run(fixture, ['git', 'commit', '--quiet', '-m', 'baseline']);

    await writeFile(path.join(fixture, 'staged.ts'), 'export const staged={value:1};\n');
    await writeFile(path.join(fixture, 'partial.ts'), 'export const partial={value:1};\n');
    await run(fixture, ['git', 'add', 'staged.ts', 'partial.ts']);
    const suffix = '// preserved-unstaged-suffix\n';
    await appendFile(path.join(fixture, 'partial.ts'), suffix);
    await writeFile(path.join(fixture, 'unstaged.ts'), 'export const unstaged={leave:1};\n');
    await writeFile(path.join(fixture, 'untracked.ts'), 'export const untracked={leave:1};\n');
    const unstagedBytes = await readFile(path.join(fixture, 'unstaged.ts'));
    const untrackedBytes = await readFile(path.join(fixture, 'untracked.ts'));

    const lintStaged = path.join(repositoryRoot, 'node_modules/.bin/lint-staged');
    await run(repositoryRoot, [
      lintStaged,
      '--config',
      path.join(repositoryRoot, '.lintstagedrc.json'),
      '--cwd',
      fixture,
    ]);

    const stagedBlob = await run(fixture, ['git', 'show', ':staged.ts']);
    const partialBlob = await run(fixture, ['git', 'show', ':partial.ts']);
    expect(stagedBlob).toBe('export const staged = { value: 1 };\n');
    expect(await readFile(path.join(fixture, 'partial.ts'), 'utf8')).toBe(`${partialBlob}${suffix}`);
    expect(await readFile(path.join(fixture, 'unstaged.ts'))).toEqual(unstagedBytes);
    expect(await readFile(path.join(fixture, 'untracked.ts'))).toEqual(untrackedBytes);
    expect(await run(fixture, ['git', 'status', '--porcelain=v1'])).toContain('?? untracked.ts');

    await run(fixture, ['git', 'add', '.']);
    await run(fixture, ['git', 'commit', '--quiet', '-m', 'formatted']);
    await run(repositoryRoot, [
      lintStaged,
      '--config',
      path.join(repositoryRoot, '.lintstagedrc.json'),
      '--cwd',
      fixture,
    ]);
  });
});
