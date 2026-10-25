import { describe, expect, test } from 'bun:test';
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { formatLocalHistoryError } from '@ai-usage/local-machine/errors';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import './machine-config.campaign-label.test';
import {
  aiUsageConfigPath,
  machineConfigPath,
  readAiUsageConfig,
  readMergedAiUsageConfigFrom,
  updateAiUsageConfig,
} from '@ai-usage/local-machine/machine-config';
import { type CollectionSourceId, updateSourcePolicyOverrides } from '@ai-usage/report-core/source-control';
import { Effect } from 'effect';

const setSourcePolicyOverride = (sourceId: CollectionSourceId, enabled: boolean | undefined) =>
  updateAiUsageConfig((config) => {
    const sourcePolicies = updateSourcePolicyOverrides(config.sourcePolicies, sourceId, enabled);
    if (sourcePolicies === undefined) {
      const { sourcePolicies: _, ...rest } = config;
      return rest;
    }
    return { ...config, sourcePolicies };
  });

describe('machine config', () => {
  test('creates one machine identity across concurrent first-start processes', async () => {
    const home = await mkdtemp('ai-usage-machine-identity-process-');
    try {
      const workerPath = path.join(import.meta.dir, 'testing', 'machine-identity-subprocess.ts');
      const barrierPath = path.join(home, 'go');
      const workerIndexes = Array.from({ length: 8 }, (_, index) => index);
      const workers = workerIndexes.map((index) =>
        Bun.spawn(
          [
            process.execPath,
            workerPath,
            home,
            path.join(home, `ready-${index}`),
            barrierPath,
            path.join(home, `result-${index}.json`),
          ],
          { stderr: 'pipe', stdout: 'pipe' },
        ),
      );
      while ((await Array.fromAsync(new Bun.Glob('ready-*').scan({ cwd: home }))).length < workers.length) {
        await Bun.sleep(5);
      }
      await writeFile(barrierPath, 'go', 'utf8');
      expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual(workerIndexes.map(() => 0));
      const machines = await Promise.all(
        workerIndexes.map(async (index) => JSON.parse(await Bun.file(path.join(home, `result-${index}.json`)).text())),
      );
      expect(new Set(machines.map((machine) => machine.id)).size).toBe(1);
      const stored = JSON.parse(await Bun.file(machineConfigPath(createLocalHistoryStorage(home))).text());
      expect(stored).toEqual(machines[0]);
      if (process.platform !== 'win32') {
        expect(lstatSync(machineConfigPath(createLocalHistoryStorage(home))).mode % 0o1000).toBe(0o600);
        expect(lstatSync(path.dirname(machineConfigPath(createLocalHistoryStorage(home)))).mode % 0o1000).toBe(0o700);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('preserves concurrent config updates', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      let releaseFirstUpdate: (() => void) | undefined;
      const firstUpdateCanFinish = new Promise<void>((resolve) => {
        releaseFirstUpdate = resolve;
      });
      let firstUpdateStarted: (() => void) | undefined;
      const firstUpdateHasStarted = new Promise<void>((resolve) => {
        firstUpdateStarted = resolve;
      });
      const runUpdate = (update: Parameters<typeof updateAiUsageConfig>[0]) =>
        Effect.runPromise(updateAiUsageConfig(update).pipe(Effect.provideService(LocalHistoryStorage, storage)));

      const projectAliasesUpdate = runUpdate(async (current) => {
        firstUpdateStarted?.();
        await firstUpdateCanFinish;
        return {
          ...current,
          projectAliases: [{ match: ['/work/alpha'], name: 'alpha' }],
        };
      });
      await firstUpdateHasStarted;
      const cursorUpdate = runUpdate((current) => ({
        ...current,
        cursor: { ...(current.cursor ?? {}), clusterGapMs: 1234 },
      }));

      releaseFirstUpdate?.();
      await Promise.all([projectAliasesUpdate, cursorUpdate]);

      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(config.projectAliases).toEqual([{ match: ['/work/alpha'], name: 'alpha' }]);
      expect(config.cursor?.clusterGapMs).toBe(1234);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('preserves concurrent config updates across processes', async () => {
    const home = await mkdtemp('ai-usage-machine-config-process-');
    try {
      const readyDirectory = path.join(home, 'ready');
      const barrierPath = path.join(home, 'go');
      await mkdir(readyDirectory);
      const workerPath = path.join(import.meta.dir, 'testing', 'machine-config-subprocess.ts');
      const groupIds = Array.from({ length: 6 }, (_, index) => `process-group-${index}`);
      const workers = groupIds.map((groupId) =>
        Bun.spawn([process.execPath, workerPath, home, groupId, readyDirectory, barrierPath], {
          stderr: 'pipe',
          stdout: 'pipe',
        }),
      );
      while ((await Array.fromAsync(new Bun.Glob('*').scan({ cwd: readyDirectory }))).length < groupIds.length) {
        await Bun.sleep(5);
      }
      await writeFile(barrierPath, 'go', 'utf8');

      const exitCodes = await Promise.all(workers.map((worker) => worker.exited));
      expect(exitCodes).toEqual(groupIds.map(() => 0));
      const storage = createLocalHistoryStorage(home);
      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(config.projectGroups?.map((group) => group.id).sort()).toEqual(groupIds);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('recovers a config lock left by an exited local process', async () => {
    const home = await mkdtemp('ai-usage-machine-config-stale-lock-');
    try {
      const storage = createLocalHistoryStorage(home);
      const configPath = aiUsageConfigPath(storage);
      mkdirSync(path.dirname(configPath), { recursive: true });
      const exitedWorker = Bun.spawn([process.execPath, '-e', 'process.exit(0)']);
      const exitedPid = exitedWorker.pid;
      await exitedWorker.exited;
      writeFileSync(
        `${configPath}.lock`,
        `${JSON.stringify({
          createdAt: new Date().toISOString(),
          hostname: hostname(),
          ownerId: 'exited-fixture',
          pid: exitedPid,
          version: 1,
        })}\n`,
      );

      await Effect.runPromise(
        updateAiUsageConfig(() => ({ cursor: { clusterGapMs: 1234 } })).pipe(
          Effect.provideService(LocalHistoryStorage, storage),
        ),
      );

      expect(readdirSync(path.dirname(configPath))).toEqual(['config.json']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects a multiply-linked authoritative config without changing its alias', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      const runUpdate = (update: Parameters<typeof updateAiUsageConfig>[0]) =>
        Effect.runPromise(updateAiUsageConfig(update).pipe(Effect.provideService(LocalHistoryStorage, storage)));
      await runUpdate(() => ({ cursor: { clusterGapMs: 1234 } }));
      const configPath = aiUsageConfigPath(storage);
      const previousConfigPath = path.join(path.dirname(configPath), 'previous-config.json');
      linkSync(configPath, previousConfigPath);

      await expect(
        runUpdate((config) => ({
          ...config,
          projectAliases: [{ match: ['/work/beta'], name: 'beta' }],
        })),
      ).rejects.toThrow();

      expect(JSON.parse(readFileSync(previousConfigPath, 'utf8'))).toEqual({ cursor: { clusterGapMs: 1234 } });
      expect(readdirSync(path.dirname(configPath)).sort()).toEqual(['config.json', 'previous-config.json']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reads valid project groups from user config', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({
          projectGroups: [
            {
              id: 'group-1',
              name: 'exalibur',
              sources: [{ machineId: 'machine-a', sourcePath: '/work/exalibur' }],
            },
          ],
        }),
      );

      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(config.projectGroups?.[0]?.name).toBe('exalibur');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects invalid project groups', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({
          projectGroups: [{ id: 'group-1', name: 'exalibur', sources: [{}] }],
        }),
      );

      await expect(
        Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
      ).rejects.toThrow('Invalid ai-usage config');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reads valid skills config from user config', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({
          skills: {
            sourceRepoPath: '/repo/agent-skills',
            targets: {
              codex: {
                enabled: true,
                kind: 'standard-interop',
                path: '/home/user/.codex/skills',
                scope: 'system',
              },
            },
          },
        }),
      );

      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(config.skills).toEqual({
        sourceRepoPath: '/repo/agent-skills',
        targets: {
          codex: {
            enabled: true,
            kind: 'standard-interop',
            path: '/home/user/.codex/skills',
            scope: 'system',
          },
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects invalid skills config', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({
          skills: {
            projectsRootPath: '',
          },
        }),
      );

      await expect(
        Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
      ).rejects.toThrow('Invalid ai-usage config');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects duplicate ids and overlapping selectors across project groups', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({
          projectGroups: [
            {
              id: 'group-1',
              name: 'broad',
              sources: [{ machineId: 'machine-a', project: 'Exalibur' }],
            },
            {
              id: 'group-2',
              name: 'precise',
              sources: [{ machineId: 'machine-a', sourcePath: '/work/exalibur' }],
            },
          ],
        }),
      );

      await expect(
        Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
      ).rejects.toThrow('Invalid ai-usage config');

      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({
          projectGroups: [
            { id: 'group-1', name: 'one', sources: [{ sourcePath: '/work/one' }] },
            { id: 'group-1', name: 'two', sources: [{ sourcePath: '/work/two' }] },
          ],
        }),
      );

      await expect(
        Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
      ).rejects.toThrow('Invalid ai-usage config');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('preserves home project groups when repo config omits them', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    const repo = await mkdtemp('ai-usage-repo-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({
          projectGroups: [
            {
              id: 'group-1',
              name: 'exalibur',
              sources: [{ machineId: 'machine-a', sourcePath: '/work/exalibur' }],
            },
          ],
        }),
      );

      writeFileSync(
        path.join(repo, 'ai-usage.config.ts'),
        'export default { cursor: { clusterGapMs: 1234 }, projectGroups: undefined };\n',
      );

      const config = await Effect.runPromise(
        readMergedAiUsageConfigFrom(repo).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(config.projectGroups?.[0]?.name).toBe('exalibur');
      expect(config.cursor?.clusterGapMs).toBe(1234);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('keeps legacy sync config inert and preserves it during unrelated updates', async () => {
    const home = await mkdtemp('ai-usage-machine-config-legacy-sync-');
    try {
      const storage = createLocalHistoryStorage(home);
      const configPath = aiUsageConfigPath(storage);
      const legacySync = {
        remotes: [
          {
            enabled: true,
            name: 'old-macbook',
            tokenEnv: 'AI_USAGE_OLD_TOKEN',
            url: 'http://192.0.2.1:3847/snapshot',
          },
        ],
        unknownNestedState: { lastPulledAt: '2026-01-01T00:00:00.000Z' },
      };
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ cursor: { clusterGapMs: 1234 }, sync: legacySync }));

      const read = await Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)));
      await Effect.runPromise(
        updateAiUsageConfig((config) => ({
          ...config,
          projectAliases: [{ match: ['/work/alpha'], name: 'alpha' }],
        })).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;

      expect((read as Record<string, unknown>).sync).toEqual(legacySync);
      expect(persisted.sync).toEqual(legacySync);
      expect(persisted.projectAliases).toEqual([{ match: ['/work/alpha'], name: 'alpha' }]);
      expect(persisted.cursor).toEqual({ clusterGapMs: 1234 });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('merges skills config without inventing a projects root', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    const repo = await mkdtemp('ai-usage-repo-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({
          skills: {
            targets: {
              codex: {
                enabled: true,
                kind: 'standard-interop',
                path: '/home/user/.codex/skills',
                scope: 'system',
              },
            },
            projectPaths: ['/work/home-project'],
          },
        }),
      );

      writeFileSync(
        path.join(repo, 'ai-usage.config.ts'),
        "export default { skills: { sourceRepoPath: '/repo/agent-skills' } };\n",
      );

      const config = await Effect.runPromise(
        readMergedAiUsageConfigFrom(repo).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(config.skills).toEqual({
        projectPaths: ['/work/home-project'],
        sourceRepoPath: '/repo/agent-skills',
        targets: {
          codex: {
            enabled: true,
            kind: 'standard-interop',
            path: '/home/user/.codex/skills',
            scope: 'system',
          },
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('persists only non-default home source policy overrides', async () => {
    const home = await mkdtemp('ai-usage-source-policy-');
    try {
      const storage = createLocalHistoryStorage(home);
      const runSetPolicy = (enabled: boolean | undefined) =>
        Effect.runPromise(
          setSourcePolicyOverride('codex.sessions', enabled).pipe(Effect.provideService(LocalHistoryStorage, storage)),
        );

      await runSetPolicy(false);
      expect(JSON.parse(readFileSync(aiUsageConfigPath(storage), 'utf8')).sourcePolicies).toEqual({
        'codex.sessions': { enabled: false },
      });

      await runSetPolicy(true);
      const resetConfig = JSON.parse(readFileSync(aiUsageConfigPath(storage), 'utf8')) as Record<string, unknown>;
      expect(Object.hasOwn(resetConfig, 'sourcePolicies')).toBe(false);
      if (process.platform !== 'win32') {
        expect(lstatSync(aiUsageConfigPath(storage)).mode % 0o1000).toBe(0o600);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('preserves unrelated config across concurrent source policy mutations', async () => {
    const home = await mkdtemp('ai-usage-source-policy-concurrent-');
    try {
      const storage = createLocalHistoryStorage(home);
      await Effect.runPromise(
        updateAiUsageConfig(() => ({
          cursor: { clusterGapMs: 1234 },
          projectAliases: [{ match: ['/work/alpha'], name: 'alpha' }],
        })).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      await Promise.all([
        Effect.runPromise(
          setSourcePolicyOverride('codex.sessions', false).pipe(Effect.provideService(LocalHistoryStorage, storage)),
        ),
        Effect.runPromise(
          setSourcePolicyOverride('rtk.savings', false).pipe(Effect.provideService(LocalHistoryStorage, storage)),
        ),
      ]);

      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(config.sourcePolicies).toEqual({
        'codex.sessions': { enabled: false },
        'rtk.savings': { enabled: false },
      });
      expect(config.cursor?.clusterGapMs).toBe(1234);
      expect(config.projectAliases).toEqual([{ match: ['/work/alpha'], name: 'alpha' }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects source policy in repository configuration', async () => {
    const home = await mkdtemp('ai-usage-source-policy-home-');
    const repo = await mkdtemp('ai-usage-source-policy-repo-');
    try {
      const storage = createLocalHistoryStorage(home);
      writeFileSync(
        path.join(repo, 'ai-usage.config.ts'),
        "export default { sourcePolicies: { 'codex.sessions': { enabled: false } } };\n",
      );

      const error = await Effect.runPromise(
        readMergedAiUsageConfigFrom(repo).pipe(Effect.provideService(LocalHistoryStorage, storage), Effect.flip),
      );
      expect(formatLocalHistoryError(error)).toContain('sourcePolicies may only be configured in the user home config');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('rejects unknown source policy ids in home configuration', async () => {
    const home = await mkdtemp('ai-usage-source-policy-invalid-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({ sourcePolicies: { 'cursor.sqlite': { enabled: false } } }),
      );

      await expect(
        Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
      ).rejects.toThrow('Invalid ai-usage config');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reads a routing section whose entries are validated later and rejects a malformed section', async () => {
    const home = await mkdtemp('ai-usage-routing-home-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      // One entry is wrong on purpose: the section still reads, and the entry is reported by the
      // routing parser instead of making the whole configuration unreadable.
      const routing = { executors: [{ harness: 'claude-code', authorization: 'maybe' }] };
      writeFileSync(aiUsageConfigPath(storage), JSON.stringify({ routing }));
      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(config.routing).toEqual(routing);

      writeFileSync(aiUsageConfigPath(storage), JSON.stringify({ routing: { executors: 'all' } }));
      await expect(
        Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
      ).rejects.toThrow('Invalid ai-usage config');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects routing declarations in repository configuration', async () => {
    const home = await mkdtemp('ai-usage-routing-home-only-');
    const repo = await mkdtemp('ai-usage-routing-repo-');
    try {
      const storage = createLocalHistoryStorage(home);
      writeFileSync(path.join(repo, 'ai-usage.config.ts'), 'export default { routing: { executors: [] } };\n');

      const error = await Effect.runPromise(
        readMergedAiUsageConfigFrom(repo).pipe(Effect.provideService(LocalHistoryStorage, storage), Effect.flip),
      );
      expect(formatLocalHistoryError(error)).toContain('routing may only be configured in the user home config');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

const mkdtemp = async (prefix: string) => {
  const { mkdtemp: makeTemporaryDirectory } = await import('node:fs/promises');
  return makeTemporaryDirectory(path.join(tmpdir(), prefix));
};

describe('github config', () => {
  const writeHomeConfig = (home: string, value: unknown): ReturnType<typeof createLocalHistoryStorage> => {
    const storage = createLocalHistoryStorage(home);
    mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
    writeFileSync(aiUsageConfigPath(storage), `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return storage;
  };

  test('reads a strict github section from the user home config', async () => {
    const home = await mkdtemp('ai-usage-github-config-');
    try {
      const storage = writeHomeConfig(home, {
        github: { accounts: [{ ghUser: 'alice', host: 'github.com', owner: 'fixture' }], enabled: true },
      });
      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(config.github).toEqual({
        accounts: [{ ghUser: 'alice', host: 'github.com', owner: 'fixture' }],
        enabled: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects a malformed github section instead of ignoring it', async () => {
    const invalid: unknown[] = [
      { enabled: 'yes' },
      { accounts: [{ ghUser: 'alice', host: 'ghe.example.com', owner: 'fixture' }] },
      { accounts: [{ ghUser: '', host: 'github.com', owner: 'fixture' }] },
      { accounts: [{ ghUser: 'alice', host: 'github.com', owner: 'fixture/project' }] },
      { accounts: [{ ghUser: 'alice', host: 'github.com', owner: 'fixture', token: 'never' }] },
      { enabled: false, hostOwnerPattern: 'fixture/*' },
      [],
    ];
    for (const github of invalid) {
      const home = await mkdtemp('ai-usage-github-config-invalid-');
      try {
        const storage = writeHomeConfig(home, { github });
        await expect(
          Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
        ).rejects.toThrow('Invalid ai-usage config');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  test('refuses a github section in repository config', async () => {
    const home = await mkdtemp('ai-usage-github-config-repo-');
    const repo = await mkdtemp('ai-usage-github-config-repo-cwd-');
    try {
      const storage = createLocalHistoryStorage(home);
      writeFileSync(path.join(repo, 'ai-usage.config.ts'), 'export default { github: { enabled: false } };\n');
      const failure = await Effect.runPromise(
        Effect.flip(readMergedAiUsageConfigFrom(repo).pipe(Effect.provideService(LocalHistoryStorage, storage))),
      );
      expect(formatLocalHistoryError(failure)).toContain('github may only be configured in the user home config');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('jira config', () => {
  const writeHomeConfig = (home: string, value: unknown): ReturnType<typeof createLocalHistoryStorage> => {
    const storage = createLocalHistoryStorage(home);
    mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
    writeFileSync(aiUsageConfigPath(storage), `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return storage;
  };

  test('reads a strict jira section from the user home config', async () => {
    const home = await mkdtemp('ai-usage-jira-config-');
    try {
      const storage = writeHomeConfig(home, { jira: { enabled: false, site: 'example.atlassian.net' } });
      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(config.jira).toEqual({ enabled: false, site: 'example.atlassian.net' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects a malformed jira section instead of ignoring it', async () => {
    const invalid: unknown[] = [
      { enabled: 'yes' },
      { site: 'https://example.atlassian.net' },
      { site: 'not a host' },
      { enabled: true, token: 'never' },
      [],
    ];
    for (const jira of invalid) {
      const home = await mkdtemp('ai-usage-jira-config-invalid-');
      try {
        const storage = writeHomeConfig(home, { jira });
        await expect(
          Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
        ).rejects.toThrow('Invalid ai-usage config');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  test('refuses a jira section in repository config', async () => {
    const home = await mkdtemp('ai-usage-jira-config-repo-');
    const repo = await mkdtemp('ai-usage-jira-config-repo-cwd-');
    try {
      const storage = createLocalHistoryStorage(home);
      writeFileSync(path.join(repo, 'ai-usage.config.ts'), 'export default { jira: { enabled: false } };\n');
      const failure = await Effect.runPromise(
        Effect.flip(readMergedAiUsageConfigFrom(repo).pipe(Effect.provideService(LocalHistoryStorage, storage))),
      );
      expect(formatLocalHistoryError(failure)).toContain('jira may only be configured in the user home config');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
