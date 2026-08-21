import { expect, test } from 'bun:test';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WideEventSnapshot } from '@ai-usage/effect-runtime';
import { parseUsageSnapshot } from '@ai-usage/report-core/snapshot';
import { createUsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import { loadUsageEngineRendezvous } from '@ai-usage/usage-engine-control/node';
import { withCliSandbox } from './test-support/run-cli';

type StoredWideEvent = Omit<WideEventSnapshot, 'resource' | 'schemaVersion'> &
  (
    | { readonly resource?: never; readonly schemaVersion: 1 }
    | { readonly resource: WideEventSnapshot['resource']; readonly schemaVersion: 2 }
  );

const codexHistory =
  JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'session_meta',
    payload: { cwd: '/work/fixture-project', id: 'fixture-thread' },
  }) +
  `\n${JSON.stringify({
    timestamp: '2026-01-01T00:04:00.000Z',
    payload: {
      info: { total_token_usage: { cached_input_tokens: 2, input_tokens: 12, output_tokens: 18, total_tokens: 30 } },
      type: 'token_count',
    },
  })}\n`;

const PROCESS_INTEGRATION_TEST_TIMEOUT_MS = 20_000;
const DAEMON_INTEGRATION_TEST_TIMEOUT_MS = 40_000;
const SETUP_URL_PATTERN = /Setup UI: (http:\/\/[^\s]+)/;
const usageEngineMainPath = path.resolve(import.meta.dir, '../../usage-engine/src/main.ts');

const spawnUsageEngineDaemon = (root: string, environment: Readonly<Record<string, string>>) => {
  const child = Bun.spawn([process.execPath, '--no-env-file', usageEngineMainPath, 'serve', '--port', '0'], {
    cwd: root,
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    child,
    stderr: new Response(child.stderr).text(),
    stdout: new Response(child.stdout).text(),
  };
};

const waitForUsageEngineDaemon = async (
  daemon: ReturnType<typeof spawnUsageEngineDaemon>,
  rendezvousPath: string,
): Promise<void> => {
  const deadline = Date.now() + PROCESS_INTEGRATION_TEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (daemon.child.exitCode !== null) {
      throw new Error(`Usage engine daemon exited before readiness: ${await daemon.stderr}`);
    }
    try {
      await loadUsageEngineRendezvous(rendezvousPath);
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error('Timed out waiting for the usage engine daemon.');
};

const stopUsageEngineDaemon = async (daemon: ReturnType<typeof spawnUsageEngineDaemon>): Promise<number> => {
  if (daemon.child.exitCode === null) {
    daemon.child.kill('SIGTERM');
  }
  const exitCode = await daemon.child.exited;
  await Promise.all([daemon.stderr, daemon.stdout]);
  return exitCode;
};

const parseWideEventLines = (body: string): StoredWideEvent[] =>
  body
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredWideEvent);

const readWideEvents = async (directory: string): Promise<StoredWideEvent[]> => {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.ndjson'));
  const bodies = await Promise.all(files.map((name) => readFile(path.join(directory, name), 'utf8')));
  return bodies.flatMap(parseWideEventLines);
};

test('wide-event analysis helper accepts historical schema v1 and current schema v2', () => {
  const common = {
    annotations: {},
    boundary: 'fixture.boundary',
    durationMs: 1,
    emittedAt: '2026-07-22T00:00:00.001Z',
    error: null,
    event: 'wide-event' as const,
    eventId: 'fixture-event',
    outcome: 'success' as const,
    services: [],
    spanId: 'span',
    startedAt: '2026-07-22T00:00:00.000Z',
    traceId: 'trace',
  };
  const records = parseWideEventLines(
    `${JSON.stringify({ ...common, schemaVersion: 1 })}\n${JSON.stringify({
      ...common,
      resource: {
        instanceId: 'fixture-instance',
        runtimeMode: 'test',
        serviceName: 'ai-usage',
        serviceVersion: '0.1.0-test',
        surface: 'cli',
      },
      schemaVersion: 2,
    })}\n`,
  );

  expect(records.map(({ schemaVersion }) => schemaVersion)).toEqual([1, 2]);
  expect(records[0]?.resource).toBeUndefined();
  expect(records[1]?.resource?.surface).toBe('cli');
});

test(
  'runs stateful machine and snapshot commands in an isolated profile',
  async () => {
    await withCliSandbox(async ({ root, runCli }) => {
      const first = await runCli(['machine']);
      const second = await runCli(['machine']);
      if (first.exitCode !== 0) {
        throw new Error(`Initial machine lookup failed: ${first.stderr}`);
      }
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toBe(second.stdout);
      const labelled = await runCli(['machine', 'set-label', 'Fixture Machine']);
      expect(labelled.exitCode).toBe(0);
      expect(labelled.stdout).toContain('Fixture Machine');
      const renamed = await runCli(['machine']);
      expect(renamed.stdout).toBe(labelled.stdout);

      const home = path.join(root, 'profile');
      await mkdir(path.join(home, '.codex', 'sessions', '2026', '01', '01'), { recursive: true });
      await writeFile(path.join(home, '.codex', 'sessions', '2026', '01', '01', 'fixture.jsonl'), codexHistory);
      const snapshotPath = path.join(root, 'snapshot.json');
      const snapshot = await runCli(['snapshot', '--no-cursor', '--out', snapshotPath]);
      expect(snapshot.exitCode).toBe(0);
      expect(snapshot.stdout).toContain(snapshotPath);
      expect(parseUsageSnapshot(await readFile(snapshotPath, 'utf8')).rows).toHaveLength(1);
    });
  },
  PROCESS_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  'keeps stored outputs byte-identical and fresh daemon/foreground rows identical under concurrency',
  async () => {
    await withCliSandbox(async ({ environment, root, runCli }) => {
      const home = path.join(root, 'profile');
      await mkdir(path.join(home, '.codex', 'sessions', '2026', '01', '01'), { recursive: true });
      await writeFile(path.join(home, '.codex', 'sessions', '2026', '01', '01', 'fixture.jsonl'), codexHistory);
      const selection = ['--harness', 'codex', '--no-cursor', '--no-color'];
      const initial = await runCli([...selection, '--json']);
      expect(initial.exitCode).toBe(0);

      const formats = [[], ['--json'], ['--csv'], ['--payload-json']];
      const rendezvousPath = path.join(root, 'state', 'rendezvous.json');
      const daemon = spawnUsageEngineDaemon(root, environment);
      let expected: Awaited<ReturnType<typeof runCli>>[] = [];
      try {
        await waitForUsageEngineDaemon(daemon, rendezvousPath);
        const daemonFresh = await runCli([...selection, '--json']);
        if (daemonFresh.exitCode !== 0) {
          const rendezvous = await loadUsageEngineRendezvous(rendezvousPath);
          const daemonStatus = await createUsageEngineControlClient({
            resolveRendezvous: () => Promise.resolve(rendezvous),
          }).getStatus();
          await stopUsageEngineDaemon(daemon);
          throw new Error(
            `Daemon fresh report failed: ${daemonFresh.stderr}\nDaemon status:\n${JSON.stringify(daemonStatus)}\nEngine diagnostics:\n${await daemon.stderr}`,
          );
        }
        expect(daemonFresh).toMatchObject({
          exitCode: 0,
          stderr: initial.stderr,
          stdout: initial.stdout,
        });

        const concurrent = await Promise.all([runCli([...selection, '--json']), runCli([...selection, '--json'])]);
        expect(concurrent.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
        expect(concurrent.map(({ stdout }) => stdout)).toEqual([initial.stdout, initial.stdout]);
        expect(concurrent.map(({ stderr }) => stderr)).toEqual([initial.stderr, initial.stderr]);
        await expect(Bun.file(rendezvousPath).exists()).resolves.toBe(true);

        expected = await Promise.all(
          formats.map(async (format) => await runCli([...selection, '--stored', ...format])),
        );
        expect(expected.every(({ exitCode }) => exitCode === 0)).toBe(true);
        expect(expected.every(({ stderr }) => stderr === '')).toBe(true);
      } finally {
        expect(await stopUsageEngineDaemon(daemon)).toBe(0);
      }

      const stopped = await Promise.all(
        formats.map(async (format) => await runCli([...selection, '--stored', ...format])),
      );
      expect(stopped.map(({ stdout }) => stdout)).toEqual(expected.map(({ stdout }) => stdout));
      expect(stopped.map(({ stderr }) => stderr)).toEqual(expected.map(({ stderr }) => stderr));
      await expect(Bun.file(rendezvousPath).exists()).resolves.toBe(false);
    });
  },
  DAEMON_INTEGRATION_TEST_TIMEOUT_MS,
);

test('fails an empty stored read without starting an engine and can then publish foreground', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const databasePath = path.join(root, 'store', 'usage.sqlite');
    const rendezvousPath = path.join(root, 'state', 'rendezvous.json');
    const stored = await runCli(['--stored', '--json', '--harness', 'codex', '--no-cursor']);
    expect(stored.exitCode).toBe(1);
    expect(stored.stdout).toBe('');
    expect(stored.stderr).toContain('Usage store');
    await expect(Bun.file(databasePath).exists()).resolves.toBe(false);
    await expect(Bun.file(rendezvousPath).exists()).resolves.toBe(false);

    const fresh = await runCli(['--json', '--harness', 'codex', '--no-cursor']);
    expect(fresh.exitCode).toBe(0);
    expect(JSON.parse(fresh.stdout)).toEqual([]);
    await expect(Bun.file(databasePath).exists()).resolves.toBe(true);
    await expect(Bun.file(rendezvousPath).exists()).resolves.toBe(false);
    await expect(Bun.file(`${databasePath}.engine.lock`).exists()).resolves.toBe(false);
  });
});

test('forwards Ctrl-C through a foreground engine and leaves no writer or listener behind', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const databasePath = path.join(root, 'store', 'usage.sqlite');
    const interrupted = await runCli(['setup', '--local', '--port', '0'], {
      interrupt: { afterMs: 750, signal: 'SIGINT' },
    });
    if (interrupted.exitCode !== 130) {
      throw new Error(
        `Expected setup to exit 130 after SIGINT, got ${interrupted.exitCode}. stderr: ${interrupted.stderr}`,
      );
    }
    expect(interrupted.signalCode).toBeNull();
    await expect(Bun.file(`${databasePath}.engine.lock`).exists()).resolves.toBe(false);
    await expect(Bun.file(path.join(root, 'state', 'rendezvous.json')).exists()).resolves.toBe(false);

    const setupUrl = interrupted.stdout.match(SETUP_URL_PATTERN)?.[1];
    if (setupUrl !== undefined) {
      await expect(fetch(setupUrl)).rejects.toThrow();
    }
    expect((await runCli(['--json', '--harness', 'codex', '--no-cursor'])).exitCode).toBe(0);
  });
});

test('renders a snapshot merge and rejects retired HTML arguments as real processes', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const home = path.join(root, 'profile');
    await mkdir(path.join(home, '.codex', 'sessions', '2026', '01', '01'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'sessions', '2026', '01', '01', 'fixture.jsonl'), codexHistory);
    const snapshotPath = path.join(root, 'snapshot.json');
    const snapshot = await runCli(['snapshot', '--no-cursor', '--out', snapshotPath]);
    expect(snapshot.exitCode).toBe(0);

    const json = await runCli(['merge', snapshotPath, '--json']);
    const csv = await runCli(['merge', snapshotPath, '--csv']);
    expect(json.exitCode).toBe(0);
    expect(csv.exitCode).toBe(0);
    expect(csv.stdout).toContain('fixture-project');

    const reportHtml = await runCli(['--html']);
    const mergeHtml = await runCli(['merge', snapshotPath, '--html']);
    expect(reportHtml.exitCode).toBe(1);
    expect(reportHtml.stderr).toContain('Unknown option: --html');
    expect(mergeHtml.exitCode).toBe(1);
    expect(mergeHtml.stderr).toContain('Unknown option for merge: --html');
  });
});

test('merges a portable snapshot with durable config while the engine and source config are absent', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const profile = path.join(root, 'profile');
    const configPath = path.join(root, 'ai-usage.config.ts');
    const databasePath = path.join(root, 'store', 'usage.sqlite');
    const rendezvousPath = path.join(root, 'state', 'rendezvous.json');
    const snapshotPath = path.join(root, 'portable.json');
    await mkdir(path.join(profile, '.codex', 'sessions', '2026', '01', '01'), { recursive: true });
    await writeFile(path.join(profile, '.codex', 'sessions', '2026', '01', '01', 'fixture.jsonl'), codexHistory);
    await writeFile(
      configPath,
      "export default { projectAliases: [{ name: 'Durable Alias', match: ['/work/fixture-project'] }] };\n",
    );

    const snapshot = await runCli(['snapshot', '--no-cursor', '--out', snapshotPath]);
    expect(snapshot.exitCode).toBe(0);
    await rm(configPath);
    await expect(Bun.file(rendezvousPath).exists()).resolves.toBe(false);
    const before = await stat(databasePath);

    const merged = await runCli(['merge', snapshotPath, '--json', '--no-cursor']);

    expect(merged.exitCode).toBe(0);
    expect(merged.stderr).toContain('Durable Alias');
    expect(JSON.parse(merged.stdout)).toEqual([expect.objectContaining({ project: 'Durable Alias' })]);
    const after = await stat(databasePath);
    expect({ mtimeMs: after.mtimeMs, size: after.size }).toEqual({ mtimeMs: before.mtimeMs, size: before.size });
    await expect(Bun.file(rendezvousPath).exists()).resolves.toBe(false);
    await expect(Bun.file(`${databasePath}.engine.lock`).exists()).resolves.toBe(false);
  });
});

test('imports Cursor files idempotently and keeps invalid input out of state', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const validPath = path.join(root, 'cursor-valid.csv');
    const invalidPath = path.join(root, 'cursor-invalid.csv');
    await writeFile(validPath, 'Date,User,Kind,Model,Cost\n2026-01-01,user,usage,model,1.25\n');
    await writeFile(invalidPath, 'wrong,header\nvalue,value\n');

    const first = await runCli(['cursor', 'import', validPath]);
    const second = await runCli(['cursor', 'import', validPath]);
    const invalid = await runCli(['cursor', 'import', invalidPath]);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('Imported Cursor usage export');
    expect(second.stdout).toContain('Already imported');
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toBe('');
    const imported = await readdir(path.join(root, '.ai-usage', 'cursor-exports'));
    expect(imported).toHaveLength(1);
  });
});

test('drains a payload larger than one MiB without truncation', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const sourcePath = path.join(root, 'source.json');
    const baseSnapshot = path.join(root, 'base.json');
    const home = path.join(root, 'profile');
    await mkdir(path.join(home, '.codex', 'sessions', '2026', '01', '01'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'sessions', '2026', '01', '01', 'fixture.jsonl'), codexHistory);
    expect((await runCli(['snapshot', '--no-cursor', '--out', baseSnapshot])).exitCode).toBe(0);
    const snapshot = parseUsageSnapshot(await readFile(baseSnapshot, 'utf8'));
    const sourceRow = snapshot.rows[0];
    if (!sourceRow) {
      throw new Error('Expected the fixture snapshot row');
    }
    const rows = Array.from({ length: 4000 }, (_, index) => {
      const name = `payload-row-${index}`;
      return {
        ...sourceRow,
        name,
        sessionLabel: name,
        source: { ...sourceRow.source, sourceSessionId: `payload-session-${index}` },
      };
    });
    await writeFile(sourcePath, `${JSON.stringify({ ...snapshot, rows })}\n`);

    const result = await runCli(['merge', sourcePath, '--payload-json']);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeGreaterThan(1024 * 1024);
    const payload = JSON.parse(result.stdout) as { rows: Array<{ name: string }> };
    expect(payload.rows).toHaveLength(rows.length);
    expect(payload.rows.at(-1)?.name).toBe('payload-row-3999');
    expect((await stat(sourcePath)).isFile()).toBe(true);
  });
});

test('normal reports do not invoke provider quota collection', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const home = path.join(root, 'profile');
    const binaryDirectory = path.join(root, 'bin');
    const markerPath = path.join(root, 'codex-invoked');
    await mkdir(binaryDirectory, { recursive: true });
    const fakeCodexPath = path.join(binaryDirectory, 'codex');
    await writeFile(fakeCodexPath, `#!/bin/sh\ntouch "${markerPath}"\nexit 1\n`);
    await chmod(fakeCodexPath, 0o700);
    await mkdir(path.join(home, '.codex', 'sessions', '2026', '01', '01'), {
      recursive: true,
    });
    await writeFile(path.join(home, '.codex', 'sessions', '2026', '01', '01', 'fixture.jsonl'), codexHistory);

    const result = await runCli(['--json', '--no-cursor'], {
      env: { PATH: `${binaryDirectory}:${process.env.PATH ?? ''}` },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(1);
    expect(Bun.file(markerPath).exists()).resolves.toBe(false);

    const configDirectory = path.join(home, '.config', 'ai-usage');
    await mkdir(configDirectory, { mode: 0o700, recursive: true });
    await writeFile(
      path.join(configDirectory, 'config.json'),
      JSON.stringify({
        sourcePolicies: {
          'codex.sessions': { enabled: false },
        },
      }),
    );
    const pausedResult = await runCli(['--json', '--no-cursor'], {
      env: { PATH: `${binaryDirectory}:${process.env.PATH ?? ''}` },
    });

    expect(pausedResult.exitCode).toBe(0);
    expect(JSON.parse(pausedResult.stdout)).toHaveLength(1);
    expect(pausedResult.stderr).toContain('paused by user policy');
    expect(Bun.file(markerPath).exists()).resolves.toBe(false);
  });
});

test('quota reports a paused policy without invoking the provider', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const logDirectory = path.join(root, 'logs');
    const configDirectory = path.join(root, 'profile', '.config', 'ai-usage');
    await mkdir(configDirectory, { mode: 0o700, recursive: true });
    await writeFile(
      path.join(configDirectory, 'config.json'),
      // Every provider-usage source, not just one: the command is only fatal when they are all
      // paused, and leaving one enabled would have this sandbox poll a live provider.
      JSON.stringify({
        sourcePolicies: {
          'claude.usage-limits': { enabled: false },
          'codex.usage-limits': { enabled: false },
        },
      }),
    );

    const result = await runCli(['quota'], { env: { AI_USAGE_LOG_DIR: logDirectory } });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Provider usage-limit collection is paused');
    expect(result.stderr).not.toContain('[wide-event]');
    const events = await readWideEvents(logDirectory);
    const cliEvents = events.filter((event) => event.resource?.surface === 'cli');
    expect(cliEvents).toHaveLength(1);
    expect(cliEvents[0]?.boundary).toBe('cli.quota');
    expect(cliEvents[0]?.outcome).toBe('failure');
    expect(events.some((event) => event.resource?.surface === 'engine')).toBe(true);
  });
});

test('quota persists a degraded boundary without polluting stderr when live refresh fails', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const profile = path.join(root, 'profile');
    const binaryDirectory = path.join(root, 'bin');
    const logDirectory = path.join(root, 'logs');
    const sessionDirectory = path.join(profile, '.codex', 'sessions', '2026', '07', '15');
    await mkdir(binaryDirectory, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    const fakeCodexPath = path.join(binaryDirectory, 'codex');
    await writeFile(fakeCodexPath, '#!/bin/sh\nexit 1\n');
    await chmod(fakeCodexPath, 0o700);
    const observedAt = new Date(Date.now() - 60_000);
    const resetsAt = new Date(observedAt.getTime() + 5 * 60 * 60 * 1000);
    await writeFile(
      path.join(sessionDirectory, 'rollout.jsonl'),
      `${JSON.stringify({
        timestamp: observedAt.toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: {
              resets_at: resetsAt.toISOString(),
              used_percent: 20,
              window_minutes: 300,
            },
          },
        },
      })}\n`,
    );

    const result = await runCli(['quota', '--no-color'], {
      env: {
        AI_USAGE_LOG_DIR: logDirectory,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const events = await readWideEvents(logDirectory);
    const cliEvent = events.find((event) => event.resource?.surface === 'cli');
    expect(cliEvent?.boundary).toBe('cli.quota');
    expect(cliEvent?.outcome).toBe('degraded');
    expect(cliEvent?.schemaVersion).toBe(2);
    expect(cliEvent?.resource).toMatchObject({ serviceName: 'ai-usage', surface: 'cli' });
    expect(cliEvent?.annotations.warningCodes).toEqual(['provider-warning']);
    expect(events.some((event) => event.resource?.surface === 'engine' && event.boundary === 'source.run')).toBe(true);
  });
});

test('quota persists a failed boundary when refresh fails without durable data', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const binaryDirectory = path.join(root, 'bin');
    const logDirectory = path.join(root, 'logs');
    await mkdir(binaryDirectory, { recursive: true });
    const fakeCodexPath = path.join(binaryDirectory, 'codex');
    await writeFile(fakeCodexPath, '#!/bin/sh\nexit 1\n');
    await chmod(fakeCodexPath, 0o700);

    const result = await runCli(['quota', '--no-color'], {
      env: {
        AI_USAGE_LOG_DIR: logDirectory,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No stored provider usage-limit observation is available.');
    expect(result.stderr).toBe('');
    const events = await readWideEvents(logDirectory);
    const cliEvent = events.find((event) => event.resource?.surface === 'cli');
    expect(cliEvent).toMatchObject({
      annotations: {
        domainOutcome: 'warning',
        outputCount: 0,
        warningCodes: ['provider-warning'],
      },
      boundary: 'cli.quota',
      outcome: 'failure',
    });
    expect(
      events.some(
        (event) =>
          event.resource?.surface === 'engine' &&
          event.boundary === 'source.run' &&
          event.services.some((service) => service.name === 'source.execute'),
      ),
    ).toBe(true);
  });
});

test('quota --history reads stored observations without invoking provider collection', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const binaryDirectory = path.join(root, 'bin');
    const logDirectory = path.join(root, 'logs');
    const markerPath = path.join(root, 'codex-invoked');
    await mkdir(binaryDirectory, { recursive: true });
    const fakeCodexPath = path.join(binaryDirectory, 'codex');
    await writeFile(fakeCodexPath, `#!/bin/sh\ntouch "${markerPath}"\nexit 1\n`);
    await chmod(fakeCodexPath, 0o700);

    const result = await runCli(['quota', '--history', '--no-color'], {
      env: {
        AI_USAGE_LOG_DIR: logDirectory,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No stored provider quota history in the last 7d.');
    expect(result.stderr).toBe('');
    // The read-only seam is the whole point of --history: no provider is polled and no engine runs.
    expect(await Bun.file(markerPath).exists()).toBe(false);
    const events = await readWideEvents(logDirectory);
    const cliEvent = events.find((event) => event.resource?.surface === 'cli');
    expect(cliEvent).toMatchObject({
      annotations: { domainOutcome: 'empty', outputCount: 0, quotaHistoryRange: '7d' },
      boundary: 'cli.quota',
      outcome: 'success',
    });
    expect(events.some((event) => event.resource?.surface === 'engine')).toBe(false);
  });
});
