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

const runBytes = async (
  cwd: string,
  command: string[],
  environment: Record<string, string | undefined> = process.env,
  input?: Uint8Array,
): Promise<Uint8Array> => {
  const child = Bun.spawn(command, { cwd, env: environment, stderr: 'pipe', stdin: 'pipe', stdout: 'pipe' });
  if (input) {
    child.stdin.write(input);
  }
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed (${exitCode}): ${stderr}`);
  }
  return new Uint8Array(stdout);
};

const run = async (
  cwd: string,
  command: string[],
  environment: Record<string, string | undefined> = process.env,
): Promise<string> => new TextDecoder().decode(await runBytes(cwd, command, environment));

const captureGitState = async (
  repositoryWorkingDirectory: string = repositoryRoot,
): Promise<{
  indexDiff: Uint8Array;
  status: Uint8Array;
  worktreeDiff: Uint8Array;
}> => {
  const [status, worktreeDiff, indexDiff] = await Promise.all([
    runBytes(repositoryWorkingDirectory, ['git', 'status', '--porcelain=v1', '-z']),
    runBytes(repositoryWorkingDirectory, ['git', 'diff', '--binary']),
    runBytes(repositoryWorkingDirectory, ['git', 'diff', '--cached', '--binary']),
  ]);
  return { indexDiff, status, worktreeDiff };
};

describe('staged-only pre-commit formatting', () => {
  test('distinguishes non-UTF-8 repository status bytes', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'ai-usage-git-state-'));
    temporaryDirectories.add(fixture);
    await run(fixture, ['git', 'init', '--quiet']);

    const blobHash = new TextDecoder()
      .decode(
        await runBytes(fixture, ['git', 'hash-object', '-w', '--stdin'], process.env, Buffer.from('export {};\n')),
      )
      .trim();
    const writeIndexPath = (filenameByte: number): Promise<Uint8Array> =>
      runBytes(
        fixture,
        ['git', 'update-index', '-z', '--index-info'],
        process.env,
        Buffer.concat([Buffer.from(`100644 ${blobHash}\t`), Buffer.from([filenameByte]), Buffer.from('.ts\0')]),
      );
    await writeIndexPath(0x80);
    const firstState = await captureGitState(fixture);
    await run(fixture, ['git', 'read-tree', '--empty']);
    await writeIndexPath(0x81);
    const secondState = await captureGitState(fixture);

    expect(firstState.status).not.toEqual(secondState.status);
  });

  test('formats the index while preserving unstaged and untracked bytes', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'ai-usage-lint-staged-'));
    temporaryDirectories.add(fixture);
    const runtimeBinaryDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-lint-staged-bin-'));
    temporaryDirectories.add(runtimeBinaryDirectory);
    await symlink(process.execPath, path.join(runtimeBinaryDirectory, 'node'));
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
    const repositoryBinaryDirectory = path.join(repositoryRoot, 'node_modules/.bin');
    const childBinaryPath = `${repositoryBinaryDirectory}${path.delimiter}${runtimeBinaryDirectory}`;
    const inheritedPath = process.env.PATH;
    const lintStagedEnvironment = {
      ...process.env,
      PATH: inheritedPath ? `${childBinaryPath}${path.delimiter}${inheritedPath}` : childBinaryPath,
    };
    const lintStagedCommand = [
      lintStaged,
      '--config',
      path.join(repositoryRoot, '.lintstagedrc.json'),
      '--cwd',
      fixture,
    ];
    const repositoryGitState = await captureGitState();
    await run(fixture, lintStagedCommand, lintStagedEnvironment);

    const stagedBlob = await run(fixture, ['git', 'show', ':staged.ts']);
    const partialBlob = await run(fixture, ['git', 'show', ':partial.ts']);
    expect(stagedBlob).toBe('export const staged = { value: 1 };\n');
    expect(await readFile(path.join(fixture, 'partial.ts'), 'utf8')).toBe(`${partialBlob}${suffix}`);
    expect(await readFile(path.join(fixture, 'unstaged.ts'))).toEqual(unstagedBytes);
    expect(await readFile(path.join(fixture, 'untracked.ts'))).toEqual(untrackedBytes);
    expect(await run(fixture, ['git', 'status', '--porcelain=v1'])).toContain('?? untracked.ts');

    await run(fixture, ['git', 'commit', '--quiet', '-m', 'formatted']);
    expect(await run(fixture, ['git', 'diff', '--cached', '--name-only'])).toBe('');
    const fixtureStatus = await run(fixture, ['git', 'status', '--porcelain=v1', '-z']);
    await run(fixture, lintStagedCommand, lintStagedEnvironment);
    expect(await run(fixture, ['git', 'status', '--porcelain=v1', '-z'])).toBe(fixtureStatus);
    expect(await captureGitState()).toEqual(repositoryGitState);
  });
});
