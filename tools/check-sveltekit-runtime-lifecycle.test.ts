import { afterEach, expect, test } from 'bun:test';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorHasCode } from '@ai-usage/usage-engine-control/node';
import {
  assertArtifactSnapshotUnchanged,
  checkSvelteKitRuntimeLifecycle,
  snapshotArtifactFiles,
  svelteKitRuntimeLifecycleBudget,
} from './check-sveltekit-runtime-lifecycle';

const COLD_FIXTURE_INSTALL_DEADLINE_MS = 180_000;
const FIXTURE_CHECK_DEADLINE_MS = 30_000;
const FIXTURE_BUILD_DEADLINE_MS = 30_000;
const FIXTURE_SETUP_OVERHEAD_MS = 10_000;
const ACTUAL_FIXTURE_TEST_TIMEOUT_MS =
  COLD_FIXTURE_INSTALL_DEADLINE_MS +
  FIXTURE_CHECK_DEADLINE_MS +
  FIXTURE_BUILD_DEADLINE_MS +
  FIXTURE_SETUP_OVERHEAD_MS +
  svelteKitRuntimeLifecycleBudget.totalMs;

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

const createTemporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  await chmod(root, 0o700);
  return root;
};

const signalProcessGroup = (processGroupId: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(process.platform === 'win32' ? processGroupId : -processGroupId, signal);
  } catch (error) {
    if (!errorHasCode(error, 'ESRCH')) {
      throw error;
    }
  }
};

const runFixtureCommand = async (
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  deadlineMs: number,
  label: string,
): Promise<void> => {
  const logsDirectory = path.join(cwd, '.fixture-logs');
  await mkdir(logsDirectory, { recursive: true });
  const stdoutPath = path.join(logsDirectory, `${label}-stdout.txt`);
  const stderrPath = path.join(logsDirectory, `${label}-stderr.txt`);
  const child = Bun.spawn([...command], {
    cwd,
    detached: process.platform !== 'win32',
    env: environment,
    stderr: Bun.file(stderrPath),
    stdout: Bun.file(stdoutPath),
  });
  const deadline = Date.now() + deadlineMs;
  while (child.exitCode === null && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  if (child.exitCode === null) {
    signalProcessGroup(child.pid, 'SIGKILL');
    await child.exited;
    const [stdout, stderr] = await Promise.all([readFile(stdoutPath, 'utf8'), readFile(stderrPath, 'utf8')]);
    throw new Error(`${label} exceeded its ${deadlineMs}ms deadline.\n${stdout}\n${stderr}`);
  }
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    const [stdout, stderr] = await Promise.all([readFile(stdoutPath, 'utf8'), readFile(stderrPath, 'utf8')]);
    throw new Error(`${label} exited ${exitCode}.\n${stdout}\n${stderr}`);
  }
};

const createFixtureEnvironment = async (root: string): Promise<Record<string, string>> => {
  const environment = {
    BUN_INSTALL_CACHE_DIR: path.join(root, 'cache', 'bun'),
    HOME: path.join(root, 'home'),
    PATH: process.env.PATH ?? '',
    TMPDIR: path.join(root, 'tmp'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
  };
  for (const directory of [
    environment.HOME,
    environment.TMPDIR,
    environment.XDG_CACHE_HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  return environment;
};

test(
  'builds and starts the selected SvelteKit adapter artifact for the full lifecycle',
  async () => {
    const root = await createTemporaryRoot('ai-usage-sveltekit-fixture-');
    const workspace = path.join(root, 'workspace');
    const fixtureSource = path.join(import.meta.dir, 'fixtures', 'sveltekit-runtime');
    await cp(fixtureSource, workspace, { recursive: true });
    const environment = await createFixtureEnvironment(root);
    await runFixtureCommand(
      [process.execPath, '--no-env-file', 'install', '--frozen-lockfile'],
      workspace,
      environment,
      COLD_FIXTURE_INSTALL_DEADLINE_MS,
      'fixture-install',
    );
    await runFixtureCommand(
      [process.execPath, '--no-env-file', 'run', 'check'],
      workspace,
      environment,
      FIXTURE_CHECK_DEADLINE_MS,
      'fixture-check',
    );
    await runFixtureCommand(
      [process.execPath, '--no-env-file', 'run', 'build'],
      workspace,
      environment,
      FIXTURE_BUILD_DEADLINE_MS,
      'fixture-build',
    );

    const artifactDirectory = path.join(workspace, 'build');
    const result = await checkSvelteKitRuntimeLifecycle({
      artifactDirectory,
      command: () => [process.execPath, '--no-env-file', '--no-install', path.join(artifactDirectory, 'index.js')],
      environment: { IDLE_TIMEOUT: '45' },
      ssrMarker: 'data-runtime-fixture="sveltekit-bun"',
    });
    expect(result.heldForMs).toBeGreaterThanOrEqual(svelteKitRuntimeLifecycleBudget.minimumSseHoldMs);
    expect(result.port).toBeGreaterThan(0);
    expect(result.startTimeTicks).not.toBe('');
    expect(() => process.kill(result.pid, 0)).toThrow();
  },
  ACTUAL_FIXTURE_TEST_TIMEOUT_MS,
);

test('detects an equal-size in-place artifact rewrite', async () => {
  const root = await createTemporaryRoot('ai-usage-sveltekit-artifact-');
  const artifactDirectory = path.join(root, 'artifact');
  const artifactFile = path.join(artifactDirectory, 'index.js');
  await mkdir(artifactDirectory);
  await writeFile(artifactFile, 'before');
  const snapshot = await snapshotArtifactFiles(artifactDirectory);
  await writeFile(artifactFile, 'change');
  await expect(assertArtifactSnapshotUnchanged(artifactDirectory, snapshot)).rejects.toThrow(
    'Runtime rewrote artifact path index.js.',
  );
});

test('removes its owned root when command construction fails', async () => {
  const root = await createTemporaryRoot('ai-usage-sveltekit-cleanup-');
  const artifactDirectory = path.join(root, 'artifact');
  await mkdir(artifactDirectory);
  await writeFile(path.join(artifactDirectory, 'index.js'), 'fixture');
  await expect(
    checkSvelteKitRuntimeLifecycle({
      artifactDirectory,
      command: () => {
        throw new Error('fixture command failure');
      },
      ssrMarker: 'unreachable',
      temporaryBaseDirectory: root,
    }),
  ).rejects.toThrow('fixture command failure');
  expect(await readdir(root)).toEqual(['artifact']);
});
