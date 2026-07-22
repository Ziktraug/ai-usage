import { expect, test } from 'bun:test';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WideEventSnapshot } from '@ai-usage/effect-runtime';
import { parseUsageSnapshot } from '@ai-usage/report-core/snapshot';
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
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toBe(second.stdout);

      const labelled = await runCli(['machine', 'set-label', 'Fixture Machine']);
      expect(labelled.exitCode).toBe(0);
      expect(labelled.stdout).toContain('Fixture Machine');

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
    await mkdir(configDirectory, { recursive: true });
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
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, 'config.json'),
      JSON.stringify({
        sourcePolicies: {
          'codex.usage-limits': { enabled: false },
        },
      }),
    );

    const result = await runCli(['quota'], { env: { AI_USAGE_LOG_DIR: logDirectory } });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Codex usage-limit collection is paused');
    expect(result.stderr).not.toContain('[wide-event]');
    const events = await readWideEvents(logDirectory);
    expect(events).toHaveLength(1);
    expect(events[0]?.boundary).toBe('cli.quota');
    expect(events[0]?.outcome).toBe('failure');
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
    await writeFile(
      path.join(sessionDirectory, 'rollout.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-07-15T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: {
              resets_at: '2026-07-15T15:00:00.000Z',
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
    expect(events).toHaveLength(1);
    expect(events[0]?.boundary).toBe('cli.quota');
    expect(events[0]?.outcome).toBe('degraded');
    expect(events[0]?.schemaVersion).toBe(2);
    expect(events[0]?.resource).toMatchObject({ serviceName: 'ai-usage', surface: 'cli' });
    expect(events[0]?.annotations.warningCodes).toEqual(['provider-warning']);
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
    expect(result.stdout).toContain('No stored Codex usage-limit observation is available.');
    expect(result.stderr).toBe('');
    const events = await readWideEvents(logDirectory);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      annotations: {
        domainOutcome: 'warning',
        outputCount: 0,
        warningCodes: ['provider-warning'],
      },
      boundary: 'cli.quota',
      outcome: 'failure',
      services: [{ name: 'quota.refresh', outcome: 'failure' }],
    });
  });
});
