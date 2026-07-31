import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  collectionPathMutationsAreAttributable,
  copyWorktreeSource,
  createUsageRuntimeMeasurementEnvironment,
  evaluateUsageRuntimeMeasurementAcceptance,
  isSourceControlSettled,
  measureLegacySessionQueryLeases,
  parseRuntimeMeasurementOptions,
  parseRuntimeProcessStat,
  type ScenarioMeasurement,
  usageRuntimeSessionQueryBudgets,
  validateContainedSourceSymlinks,
  warmIdleWriteLoopIsAbsent,
} from './measure-usage-runtime-io';

const emptyLeaseMeasurement = { bytes: 0, count: 0 } as const;

const scenarioMeasurement = (name: string, processes: ScenarioMeasurement['processes'] = []): ScenarioMeasurement => ({
  blockDeviceWriteBytes: 0,
  cpuTicksDelta: 0,
  deletedDevOutputDescriptors: 0,
  durationMs: 1,
  leaseAfter: emptyLeaseMeasurement,
  leaseBefore: emptyLeaseMeasurement,
  leasePeak: emptyLeaseMeasurement,
  name,
  peakResidentBytes: 0,
  peakThreads: 0,
  pathMutations: [],
  processes,
  totalWriteBytes: 0,
  writeTrace: [],
});

describe('usage runtime I/O measurement helpers', () => {
  test('constructs an allowlisted child environment rooted in the owned fixture', () => {
    const environment = createUsageRuntimeMeasurementEnvironment({
      inheritedEnvironment: {
        PATH: '/fixture/bin',
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/fixture/chromium',
        SECRET_VALUE: 'must-not-leak',
      },
      repositoryDirectory: '/repo',
      runtimeRoot: '/runtime',
    });

    expect(environment).toEqual({
      AI_USAGE_DATABASE_PATH: '/runtime/store/usage.sqlite',
      AI_USAGE_ENGINE_STATE_DIR: '/runtime/engine-state',
      AI_USAGE_HOME: '/runtime/home',
      AI_USAGE_LOG_DIR: '/runtime/logs',
      AI_USAGE_ROOT_DIR: '/repo',
      AI_USAGE_TEMP_ROOT: '/runtime/tmp',
      BROWSER: 'none',
      CI: '1',
      HOME: '/runtime/home',
      NITRO_DEV_RUNNER: 'self',
      NO_COLOR: '1',
      PATH: '/fixture/bin',
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/fixture/chromium',
      TMPDIR: '/runtime/tmp',
      TURBO_CACHE_DIR: '/runtime/cache/turbo',
      TURBO_DAEMON: 'false',
      TURBO_TELEMETRY_DISABLED: '1',
      TZ: 'Europe/Paris',
      VITE_AI_USAGE_DEMO: '0',
      VITE_AI_USAGE_E2E: '0',
      XDG_CACHE_HOME: '/runtime/cache',
      XDG_CONFIG_HOME: '/runtime/config',
      XDG_DATA_HOME: '/runtime/data',
    });
    expect(environment).not.toHaveProperty('SECRET_VALUE');
  });

  test('distinguishes sparse attributable activity from a repeated warm-idle write loop', () => {
    expect(
      warmIdleWriteLoopIsAbsent([
        { elapsedMs: 10_000, totalWriteBytes: 0 },
        { elapsedMs: 20_000, totalWriteBytes: 4096 },
        { elapsedMs: 30_000, totalWriteBytes: 4096 },
        { elapsedMs: 40_000, totalWriteBytes: 8192 },
      ]),
    ).toBe(true);
    expect(
      warmIdleWriteLoopIsAbsent([
        { elapsedMs: 10_000, totalWriteBytes: 4096 },
        { elapsedMs: 20_000, totalWriteBytes: 8192 },
      ]),
    ).toBe(false);
  });

  test('accepts only durable engine-owned collection path mutations', () => {
    expect(
      collectionPathMutationsAreAttributable(['logs/wide-events-2026-07-31.ndjson', 'store/usage.sqlite-wal']),
    ).toBe(true);
    expect(
      collectionPathMutationsAreAttributable(['source/apps/web/.output-dev/server.js', 'store/usage.sqlite-wal']),
    ).toBe(false);
    expect(collectionPathMutationsAreAttributable(['logs/wide-events-2026-07-31.ndjson'])).toBe(false);
  });

  test('rejects a Bun process born below the measured Web development group during a Sessions query', () => {
    const processMeasurement = {
      bornDuringScenario: true,
      command: 'bun',
      cpuTicksDelta: 1,
      parentPid: 101,
      peakResidentBytes: 1,
      peakThreads: 1,
      pid: 102,
      role: 'dev',
      startTimeTicks: 1000,
      writeBytesDelta: 0,
    };
    const acceptance = evaluateUsageRuntimeMeasurementAcceptance(
      [scenarioMeasurement('sessions-query', [processMeasurement])],
      {
        engineRestartPreservedWebProcess: true,
        hmrPreservedEngineInstance: true,
        hmrPreservedPublication: true,
      },
    );

    expect(acceptance.perQueryBunProcessesAbsent).toBe(false);
  });

  test('lets Playwright report each bounded Sessions stage before the supervisor deadline', () => {
    const actionBudget =
      usageRuntimeSessionQueryBudgets.navigationMs +
      usageRuntimeSessionQueryBudgets.hydrationMs +
      usageRuntimeSessionQueryBudgets.proofMs;

    expect(usageRuntimeSessionQueryBudgets.supervisorMs).toBeGreaterThan(actionBudget);
  });

  test('parses Linux identity and cumulative process counters', () => {
    const parsed = parseRuntimeProcessStat(
      '123 (bun worker (fixture)) S 1 123 123 0 -1 0 0 0 0 0 101 11 0 0 20 0 3 0 9001 777 0 0',
    );

    expect(parsed).toEqual({
      cpuTicks: 112,
      parentPid: 1,
      processGroupId: 123,
      startTimeTicks: 9001,
    });
  });

  test('recognizes only a fully settled collection and publication snapshot', () => {
    const settled = {
      publication: {
        acknowledgedRequestGeneration: 4,
        pendingDemand: false,
        queued: false,
        requestedGeneration: 4,
        running: false,
      },
      queueDepth: 0,
      runningCount: 0,
      sources: [{ lifecycle: 'scheduled' }],
    };

    expect(isSourceControlSettled(settled)).toBe(true);
    expect(isSourceControlSettled({ ...settled, queueDepth: 1 })).toBe(false);
    expect(
      isSourceControlSettled({
        ...settled,
        publication: { ...settled.publication, acknowledgedRequestGeneration: 3 },
      }),
    ).toBe(false);
    expect(isSourceControlSettled({ ...settled, sources: [{ lifecycle: 'running' }] })).toBe(false);
  });

  test('counts regular files below exact private legacy lease directories', async () => {
    const fixtureRoot = await mkdtemp('/tmp/plan052-lease-measurement-test-');
    const temporaryDirectory = path.join(fixtureRoot, 'tmp');
    const leaseDirectory = path.join(temporaryDirectory, 'ai-usage-session-query-lease-owned');
    const unrelatedDirectory = path.join(temporaryDirectory, 'not-a-lease');
    const outsideFile = path.join(fixtureRoot, 'outside.sqlite');
    try {
      await mkdir(leaseDirectory, { recursive: true });
      await mkdir(unrelatedDirectory, { recursive: true });
      await chmod(leaseDirectory, 0o700);
      await writeFile(path.join(leaseDirectory, 'session.sqlite'), '1234');
      await writeFile(path.join(unrelatedDirectory, 'ignored.sqlite'), '12345678');
      expect(await measureLegacySessionQueryLeases(temporaryDirectory)).toEqual({ bytes: 4, count: 1 });
      await writeFile(outsideFile, 'must-not-be-read');
      await symlink(outsideFile, path.join(leaseDirectory, 'outside-link'));
      await expect(measureLegacySessionQueryLeases(temporaryDirectory)).rejects.toThrow('symbolic link');
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  test('rejects source symlinks that resolve outside the private snapshot', async () => {
    const fixtureRoot = await mkdtemp('/tmp/plan052-source-symlink-test-');
    const sourceDirectory = path.join(fixtureRoot, 'source');
    const outsideFile = path.join(fixtureRoot, 'outside.ts');
    try {
      await mkdir(sourceDirectory);
      await writeFile(outsideFile, 'private fixture');
      await symlink(outsideFile, path.join(sourceDirectory, 'escape.ts'));

      await expect(validateContainedSourceSymlinks(sourceDirectory)).rejects.toThrow('escapes');
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  test('accepts an explicit output mode for an immutable revision measurement', () => {
    const options = parseRuntimeMeasurementOptions([
      '--revision=0123456789abcdef0123456789abcdef01234567',
      '--concurrent-mode=isolated',
    ]);

    expect(options.concurrentMode).toBe('isolated');
    expect(options.source).toEqual({ kind: 'revision', value: '0123456789abcdef0123456789abcdef01234567' });
  });

  test('copies only tracked worktree files into the private source snapshot', async () => {
    const fixtureRoot = await mkdtemp('/tmp/plan052-tracked-source-test-');
    const repositoryDirectory = path.join(fixtureRoot, 'repository');
    const sourceDirectory = path.join(fixtureRoot, 'snapshot');
    const environment = {
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: path.join(fixtureRoot, 'empty-home'),
      PATH: process.env.PATH ?? '',
    };
    const runGit = async (...arguments_: string[]): Promise<void> => {
      const child = Bun.spawn(['git', ...arguments_], {
        cwd: repositoryDirectory,
        env: environment,
        stderr: 'ignore',
        stdin: 'ignore',
        stdout: 'ignore',
      });
      expect(await child.exited).toBe(0);
    };
    try {
      await Promise.all([mkdir(repositoryDirectory), mkdir(sourceDirectory), mkdir(environment.HOME)]);
      await writeFile(path.join(repositoryDirectory, 'tracked.ts'), 'export const tracked = true;\n');
      await writeFile(path.join(repositoryDirectory, '.env.local'), 'PRIVATE_VALUE=must-not-copy\n');
      await runGit('init', '--quiet');
      await runGit('add', 'tracked.ts');

      await copyWorktreeSource(repositoryDirectory, sourceDirectory, environment);

      expect(await Bun.file(path.join(sourceDirectory, 'tracked.ts')).exists()).toBe(true);
      expect(await Bun.file(path.join(sourceDirectory, '.env.local')).exists()).toBe(false);
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });
});
