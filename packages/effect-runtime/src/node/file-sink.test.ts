import { afterEach, describe, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { runBoundaryEffect } from '../boundary';
import type { WideEventSnapshot } from '../model';
import { makeWideEventSinkLayer } from '../sink';
import { makeConsoleWideEventSink, renderPrettyWideEvent } from './console-sink';
import { createFileWideEventSink } from './file-sink';
import { acquireCooperativeLock, ensureOwnedLogDirectory, withCooperativeLock } from './lock';
import { resolveWideEventLogDirectory } from './resolve-log-dir';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-usage-wide-event-'));
  tempDirs.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const sampleEvent = (id: string): WideEventSnapshot => ({
  schemaVersion: 1,
  event: 'wide-event',
  eventId: id,
  boundary: 'test.boundary',
  startedAt: '2026-07-21T00:00:00.000Z',
  emittedAt: '2026-07-21T00:00:01.000Z',
  traceId: 'trace',
  spanId: 'span',
  outcome: 'success',
  durationMs: 1,
  error: null,
  annotations: { sourceId: 'cursor' },
  services: [],
});

const SYMLINK_ERROR = /symlink/;
const permissionBits = (mode: number): number => mode % 0o1000;
describe('node wide-event sinks', () => {
  test('resolves absolute AI_USAGE_LOG_DIR override and rejects relative overrides', async () => {
    const absolute = makeTempDir();
    expect(await resolveWideEventLogDirectory({ AI_USAGE_LOG_DIR: absolute })).toBe(absolute);
    expect(await resolveWideEventLogDirectory({ AI_USAGE_LOG_DIR: 'relative/logs' })).not.toBe('relative/logs');
  });

  test('creates owned directory as 0700 and log files as 0600', async () => {
    const directory = makeTempDir();
    const sink = createFileWideEventSink({ directory });
    await Effect.runPromise(sink.submit(sampleEvent('perm-1')));
    await sink.drain();
    const mode = permissionBits(lstatSync(directory).mode);
    expect(mode).toBe(0o700);
    const files = readdirSync(directory).filter((name) => name.endsWith('.ndjson'));
    expect(files.length).toBeGreaterThan(0);
    const fileMode = permissionBits(lstatSync(path.join(directory, files[0]!)).mode);
    expect(fileMode).toBe(0o600);
    await sink.dispose();
  });

  test('rejects symlink log directories', () => {
    const root = makeTempDir();
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    mkdirSync(real, { recursive: true });
    try {
      symlinkSync(real, link);
    } catch {
      // Skip on platforms without symlink permission.
      return;
    }
    expect(() => ensureOwnedLogDirectory(link)).toThrow(SYMLINK_ERROR);
  });

  test('queue-full drops records without blocking and preserves diagnostics', async () => {
    const directory = makeTempDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = createFileWideEventSink({
      directory,
      queueCapacity: 2,
      drainTimeoutMs: 100,
      appendLine: async () => {
        await gate;
      },
    });

    await Effect.runPromise(sink.submit(sampleEvent('q1')));
    await Effect.runPromise(sink.submit(sampleEvent('q2')));
    await Effect.runPromise(sink.submit(sampleEvent('q3')));
    const diagnostics = await Effect.runPromise(sink.diagnostics());
    expect(diagnostics.dropped).toBeGreaterThanOrEqual(1);
    release();
    await sink.drain();
    await sink.dispose();
  });

  test('append timeout opens the circuit and later submits are dropped', async () => {
    const directory = makeTempDir();
    const sink = createFileWideEventSink({
      directory,
      appendTimeoutMs: 20,
      appendLine: async (_filePath, _line, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    await Effect.runPromise(sink.submit(sampleEvent('slow')));
    await sink.drain();
    await Effect.runPromise(sink.submit(sampleEvent('after')));
    const diagnostics = await Effect.runPromise(sink.diagnostics());
    expect(diagnostics.failed + diagnostics.dropped).toBeGreaterThan(0);
    await sink.dispose();
  });

  test('holds the cooperative lock until a timed-out append has settled', async () => {
    const directory = makeTempDir();
    let appendInFlight = false;
    const sink = createFileWideEventSink({
      directory,
      appendTimeoutMs: 10,
      appendLine: async () => {
        appendInFlight = true;
        await Bun.sleep(60);
        appendInFlight = false;
      },
    });

    await Effect.runPromise(sink.submit(sampleEvent('slow-lock-holder')));
    await sink.drain();
    const observedInFlightUnderNextLock = await withCooperativeLock(directory, async () => appendInFlight, 200);

    expect(observedInFlightUnderNextLock).toBe(false);
    await sink.dispose();
  });

  test('rotates before exceeding max size and retains newest files', async () => {
    const directory = makeTempDir();
    const sink = createFileWideEventSink({
      directory,
      maxSizeMb: 0.0001,
      maxFiles: 2,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
    });
    for (let index = 0; index < 8; index += 1) {
      await Effect.runPromise(sink.submit(sampleEvent(`rot-${index}`)));
      await sink.drain();
    }
    const files = readdirSync(directory).filter((name) => name.endsWith('.ndjson'));
    expect(files.length).toBeLessThanOrEqual(2);
    await sink.dispose();
  });

  test('lock timeout never appends unlocked', async () => {
    const directory = makeTempDir();
    ensureOwnedLogDirectory(directory);
    const held = await acquireCooperativeLock(directory, 50);
    expect(held).not.toBeNull();
    const second = await withCooperativeLock(directory, async () => 'wrote', 30);
    expect(second).toBeNull();
    held?.release();
  });

  test('filesystem failure leaves the business Effect result unchanged', async () => {
    const sink = createFileWideEventSink({
      directory: makeTempDir(),
      appendLine: () => Promise.reject(new Error('disk full')),
    });
    const result = await Effect.runPromise(
      runBoundaryEffect({ boundary: 'fs-fail' }, Effect.succeed('ok')).pipe(
        Effect.provide(makeWideEventSinkLayer(sink)),
      ),
    );
    expect(result).toBe('ok');
    await sink.dispose();
  });

  test('pretty console sink renders a tree and json sink writes one line', () => {
    const lines: string[] = [];
    const pretty = makeConsoleWideEventSink({
      format: 'pretty',
      write: (line) => lines.push(line),
    });
    Effect.runSync(
      pretty.submit({
        ...sampleEvent('pretty'),
        services: [
          {
            name: 'child',
            traceId: 't',
            spanId: 's',
            outcome: 'success',
            durationMs: 2,
          },
        ],
      }),
    );
    expect(lines[0]).toContain('[wide-event]');
    expect(lines[0]).toContain('- child');

    const jsonLines: string[] = [];
    const json = makeConsoleWideEventSink({
      format: 'json',
      write: (line) => jsonLines.push(line),
    });
    Effect.runSync(json.submit(sampleEvent('json')));
    expect(jsonLines).toHaveLength(1);
    expect(jsonLines[0]?.includes('\n')).toBe(false);
    expect(JSON.parse(jsonLines[0]!).eventId).toBe('json');
  });

  test('scoped file sink drains before explicit process exit style completion', async () => {
    const directory = makeTempDir();
    const sink = createFileWideEventSink({ directory });
    await Effect.runPromise(sink.submit(sampleEvent('exit-1')));
    await sink.dispose();
    const files = readdirSync(directory).filter((name) => name.endsWith('.ndjson'));
    const body = readFileSync(path.join(directory, files[0]!), 'utf8');
    expect(body).toContain('exit-1');
  });

  test('dispose drains every event accepted before shutdown', async () => {
    const directory = makeTempDir();
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writtenEventIds: string[] = [];
    const sink = createFileWideEventSink({
      directory,
      appendLine: async (_filePath, line) => {
        const event = JSON.parse(line) as WideEventSnapshot;
        writtenEventIds.push(event.eventId);
        if (event.eventId === 'exit-first') {
          await firstWriteBlocked;
        }
      },
    });

    await Effect.runPromise(sink.submit(sampleEvent('exit-first')));
    await Effect.runPromise(sink.submit(sampleEvent('exit-second')));
    const disposal = sink.dispose();
    releaseFirstWrite();
    await disposal;

    expect(writtenEventIds).toEqual(['exit-first', 'exit-second']);
    expect(await Effect.runPromise(sink.diagnostics())).toEqual({ accepted: 2, dropped: 0, failed: 0 });
  });

  test('dispose aborts an active append when the drain deadline expires', async () => {
    const directory = makeTempDir();
    let appendAborted = false;
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const sink = createFileWideEventSink({
      directory,
      appendTimeoutMs: 5000,
      drainTimeoutMs: 20,
      appendLine: async (_filePath, _line, signal) => {
        markAppendStarted();
        await new Promise<void>((resolve) => {
          const fallback = setTimeout(resolve, 100);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(fallback);
              appendAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    await Effect.runPromise(sink.submit(sampleEvent('shutdown-timeout')));
    await appendStarted;
    await sink.dispose();

    expect(appendAborted).toBe(true);
    expect(await withCooperativeLock(directory, async () => 'acquired', 200)).toBe('acquired');
  });

  test('stale lock recovery allows a later writer', async () => {
    const directory = makeTempDir();
    ensureOwnedLogDirectory(directory);
    const lockPath = path.join(directory, 'wide-events.lock');
    writeFileSync(lockPath, '999999999\n0\n', { mode: 0o600 });
    // Backdate mtime into the stale window.
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    const lock = await acquireCooperativeLock(directory, 200);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  test('does not steal an old lock from a process that is still alive', async () => {
    const directory = makeTempDir();
    const lockPath = path.join(directory, 'wide-events.lock');
    const owner = await acquireCooperativeLock(directory, 50);
    expect(owner).not.toBeNull();
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    const contender = await acquireCooperativeLock(directory, 30);
    try {
      expect(contender).toBeNull();
    } finally {
      contender?.release();
      owner?.release();
    }
  });

  test('renderPrettyWideEvent keeps identity fields', () => {
    const text = renderPrettyWideEvent(sampleEvent('pretty-id'));
    expect(text).toContain('test.boundary');
    expect(text).toContain('pretty-id');
  });

  test('concurrent subprocess writers append under the lock', async () => {
    const directory = makeTempDir();
    const scriptPath = path.join(import.meta.dir, `writer-${process.pid}.ts`);
    writeFileSync(
      scriptPath,
      `
import { Effect } from 'effect';
import { createFileWideEventSink } from './file-sink.ts';

const directory = process.argv[2]!;
const sink = createFileWideEventSink({ directory, lockTimeoutMs: 5_000, appendTimeoutMs: 5_000 });
for (let i = 0; i < 5; i++) {
  await Effect.runPromise(sink.submit({
    schemaVersion: 1,
    event: 'wide-event',
    eventId: \`\${process.pid}-\${i}\`,
    boundary: 'subprocess',
    startedAt: new Date().toISOString(),
    emittedAt: new Date().toISOString(),
    traceId: 't',
    spanId: 's',
    outcome: 'success',
    durationMs: 1,
    error: null,
    annotations: {},
    services: [],
  }));
  await sink.drain();
}
await sink.dispose();
`,
    );
    const spawnWriter = () => Bun.spawn(['bun', scriptPath, directory], { stdout: 'pipe', stderr: 'pipe' });
    const left = spawnWriter();
    const right = spawnWriter();
    const [leftCode, rightCode] = await Promise.all([left.exited, right.exited]);
    expect(leftCode).toBe(0);
    expect(rightCode).toBe(0);
    const files = readdirSync(directory).filter((name) => name.endsWith('.ndjson'));
    const lines = files.flatMap((name) =>
      readFileSync(path.join(directory, name), 'utf8').trim().split('\n').filter(Boolean),
    );
    expect(lines.length).toBe(10);
    rmSync(scriptPath, { force: true });
  });
});
