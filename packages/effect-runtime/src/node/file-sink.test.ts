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
import { makeTestWideEventSinkLayer } from '../sink';
import { createFileWideEventSink, type FileWideEventWarning } from './file-sink';
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
  schemaVersion: 2,
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
  resource: {
    instanceId: 'fixture-instance',
    runtimeMode: 'test',
    serviceName: 'ai-usage',
    serviceVersion: '0.1.0-test',
    surface: 'web',
  },
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

  test('opens the circuit at the deadline while a non-cooperative append keeps the lock', async () => {
    const directory = makeTempDir();
    let appendCount = 0;
    let releaseAppend!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const sink = createFileWideEventSink({
      directory,
      appendTimeoutMs: 15,
      appendLine: async () => {
        appendCount++;
        await blocked;
      },
    });

    await Effect.runPromise(sink.submit(sampleEvent('non-cooperative')));
    await Bun.sleep(30);
    await Effect.runPromise(sink.submit(sampleEvent('after-deadline')));

    expect((await Effect.runPromise(sink.diagnostics())).dropped).toBe(1);
    expect(await withCooperativeLock(directory, async () => 'acquired', 20)).toBeNull();
    expect(appendCount).toBe(1);

    releaseAppend();
    await sink.drain();
    expect(await withCooperativeLock(directory, async () => 'acquired', 200)).toBe('acquired');
    expect(await Effect.runPromise(sink.diagnostics())).toEqual({ accepted: 0, dropped: 1, failed: 1 });
    await sink.dispose();
  });

  test('rate-limits typed warning kinds without exposing append errors', async () => {
    const directory = makeTempDir();
    let current = new Date('2026-07-21T12:00:00.000Z');
    const warnings: FileWideEventWarning[] = [];
    const sink = createFileWideEventSink({
      directory,
      appendLine: () => Promise.reject(new Error('credential Bearer fixture-secret')),
      now: () => current,
      warn: (warning) => warnings.push(warning),
    });

    for (const [index, seconds] of [0, 10, 31].entries()) {
      current = new Date(`2026-07-21T12:00:${seconds.toString().padStart(2, '0')}.000Z`);
      await Effect.runPromise(sink.submit(sampleEvent(`warning-${index}`)));
      await sink.drain();
    }

    expect(warnings.map(({ kind }) => kind)).toEqual(['append-failure', 'append-failure']);
    expect(warnings.every(({ message }) => !message.includes('fixture-secret'))).toBe(true);
    await sink.dispose();
  });

  test('sweeps once per selected target and retries a failed sweep', async () => {
    const directory = makeTempDir();
    let current = new Date('2026-07-21T12:00:00.000Z');
    let sweepCount = 0;
    let failFirstSweep = true;
    const sink = createFileWideEventSink({
      directory,
      now: () => current,
      sweepFiles: () => {
        sweepCount++;
        if (failFirstSweep) {
          failFirstSweep = false;
          return Promise.reject(new Error('fixture sweep failure'));
        }
        return Promise.resolve();
      },
    });

    for (const id of ['steady-1', 'steady-2', 'steady-3']) {
      await Effect.runPromise(sink.submit(sampleEvent(id)));
      await sink.drain();
    }
    expect(sweepCount).toBe(2);

    current = new Date('2026-07-22T12:00:00.000Z');
    await Effect.runPromise(sink.submit(sampleEvent('next-day')));
    await sink.drain();
    expect(sweepCount).toBe(3);
    await sink.dispose();

    const rotationDirectory = makeTempDir();
    let rotationSweeps = 0;
    const rotationSink = createFileWideEventSink({
      directory: rotationDirectory,
      maxSizeMb: 0.0001,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      sweepFiles: () => {
        rotationSweeps++;
        return Promise.resolve();
      },
    });
    for (const id of ['rotation-1', 'rotation-2']) {
      await Effect.runPromise(rotationSink.submit(sampleEvent(id)));
      await rotationSink.drain();
    }
    expect(rotationSweeps).toBe(2);
    await rotationSink.dispose();
  });

  test('rotates before exceeding max size and retains newest files', async () => {
    const directory = makeTempDir();
    const sink = createFileWideEventSink({
      directory,
      maxSizeMb: 0.0001,
      maxFiles: 2,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
    });
    for (const index of Array.from({ length: 8 }, (_, itemIndex) => itemIndex)) {
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
        Effect.provide(makeTestWideEventSinkLayer(sink)),
      ),
    );
    expect(result).toBe('ok');
    await sink.dispose();
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

  test('dispose respects its deadline when an active append ignores cancellation', async () => {
    const directory = makeTempDir();
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendBlocked = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const sink = createFileWideEventSink({
      directory,
      appendTimeoutMs: 5000,
      drainTimeoutMs: 20,
      appendLine: async () => {
        markAppendStarted();
        await appendBlocked;
      },
    });

    await Effect.runPromise(sink.submit(sampleEvent('shutdown-ignores-abort')));
    await appendStarted;
    const disposalOutcome = await Promise.race([
      sink.dispose().then(() => 'disposed' as const),
      Bun.sleep(100).then(() => 'deadline-exceeded' as const),
    ]);

    expect(disposalOutcome).toBe('disposed');
    releaseAppend();
    await sink.drain();
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
for (const index of Array.from({ length: 5 }, (_, itemIndex) => itemIndex)) {
  await Effect.runPromise(sink.submit({
    schemaVersion: 2,
    event: 'wide-event',
    eventId: \`\${process.pid}-\${index}\`,
    boundary: 'subprocess',
    startedAt: new Date().toISOString(),
    emittedAt: new Date().toISOString(),
    traceId: 't',
    spanId: 's',
    outcome: 'success',
    durationMs: 1,
    error: null,
    resource: {
      instanceId: 'subprocess-fixture',
      runtimeMode: 'test',
      serviceName: 'ai-usage',
      serviceVersion: '0.1.0-test',
      surface: 'web',
    },
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
