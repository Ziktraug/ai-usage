import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  makeCaptureWideEventSink,
  makeTestWideEventSinkLayer,
  noopWideEventSink,
  WideEventSink,
  type WideEventSnapshot,
} from '@ai-usage/effect-runtime';
import { makeWebWideEventSinkLayer } from '@ai-usage/effect-runtime/node';
import { createLocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { CollectionSourceId, SourceControlView } from '@ai-usage/report-core/source-control';
import type { ScheduledSource } from '@ai-usage/report-data/source-adapters';
import type { SourcePolicyStore } from '@ai-usage/report-data/source-control';
import { queryReportRows } from '@ai-usage/usage-store';
import { Duration, Effect, ManagedRuntime, Ref } from 'effect';
import { createWebProcessRuntime, requestSourceControlPublicationForServer } from './source-control.server';
import { installWebProcessRuntime, type WebProcessRuntime } from './web-process-runtime.server';

const detected = {
  availability: 'detected',
  reason: { code: 'none' },
} as const;

const policyStore = (): SourcePolicyStore => ({
  load: Effect.succeed({}),
  setEnabled: () => Effect.void,
});

const testWideEventSinkLayer = () => makeTestWideEventSinkLayer(noopWideEventSink);

const wideEventFixture = (eventId: string, instanceId: string): WideEventSnapshot => ({
  annotations: {},
  boundary: 'fixture.boundary',
  durationMs: 1,
  emittedAt: '2026-07-22T00:00:00.001Z',
  error: null,
  event: 'wide-event',
  eventId,
  outcome: 'success',
  resource: {
    instanceId,
    runtimeMode: 'test',
    serviceName: 'ai-usage',
    serviceVersion: '0.1.0-test',
    surface: 'web',
  },
  schemaVersion: 2,
  services: [],
  spanId: 'span',
  startedAt: '2026-07-22T00:00:00.000Z',
  traceId: 'trace',
});

const waitForSnapshot = async (
  read: () => Promise<SourceControlView>,
  predicate: (snapshot: SourceControlView) => boolean,
): Promise<SourceControlView> => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const snapshot = await read();
    if (predicate(snapshot)) {
      return snapshot;
    }
    await Bun.sleep(5);
  }
  throw new Error('Timed out waiting for source-control runtime state.');
};

const sourceView = (snapshot: SourceControlView, sourceId: CollectionSourceId) => {
  const source = snapshot.sources.find(({ id }) => id === sourceId);
  if (!source) {
    throw new Error(`Missing source state for ${sourceId}.`);
  }
  return source;
};

const fakeSource = (run: ScheduledSource['run']): ReadonlyMap<CollectionSourceId, ScheduledSource> =>
  new Map([
    [
      'claude.sessions',
      {
        cadence: Duration.hours(1),
        detect: Effect.succeed(detected),
        id: 'claude.sessions',
        run,
      },
    ],
  ]);

describe('web source-control runtime', () => {
  test('treats a deduplicated publication request as handled by the installed runtime', async () => {
    let requests = 0;
    const unavailable = (): Promise<never> => Promise.reject(new Error('Unexpected runtime operation.'));
    const runtime: WebProcessRuntime = {
      dispose: async () => undefined,
      effects: { runEffect: unavailable },
      sourceControl: {
        detectAll: async () => undefined,
        getSnapshot: unavailable,
        requestPublication: () => {
          requests += 1;
          return Promise.resolve(false);
        },
        runAllEnabled: async () => 0,
        runNow: async () => false,
        setEnabled: async () => undefined,
        start: unavailable,
        subscribe: () => () => undefined,
      },
    };
    const uninstall = installWebProcessRuntime(runtime);

    try {
      expect(await requestSourceControlPublicationForServer()).toBe(true);
      expect(requests).toBe(1);
    } finally {
      uninstall();
    }

    expect(await requestSourceControlPublicationForServer()).toBe(false);
  });

  test('starts once, publishes, and disposes idempotently', async () => {
    const publications = await Effect.runPromise(Ref.make(0));
    const sink = makeCaptureWideEventSink();
    const runtime = createWebProcessRuntime({
      instanceId: 'runtime-test',
      policyStore: policyStore(),
      publication: {
        publish: Ref.updateAndGet(publications, (count) => count + 1).pipe(
          Effect.map((count) => ({
            changed: true,
            revision: `revision-${count}`,
          })),
        ),
      },
      sources: fakeSource(() =>
        Effect.succeed({
          changed: true,
          inputCount: 1,
          outputCount: 1,
          warnings: [],
        }),
      ),
      wideEventSinkLayer: makeTestWideEventSinkLayer(sink),
    });

    expect((await runtime.sourceControl.start()).instanceId).toBe('runtime-test');
    const portEvent = wideEventFixture('runtime-port-test', 'runtime-test');
    await runtime.effects.runEffect(WideEventSink.pipe(Effect.flatMap((eventSink) => eventSink.submit(portEvent))));
    expect(sink.events()).toContainEqual(portEvent);

    const completed = await waitForSnapshot(
      runtime.sourceControl.getSnapshot,
      (snapshot) =>
        sourceView(snapshot, 'claude.sessions').lastOutcome === 'success' &&
        snapshot.publication.revision === 'revision-1',
    );
    expect(completed.runningCount).toBe(0);
    expect(await Effect.runPromise(Ref.get(publications))).toBe(1);

    await Promise.all([runtime.dispose(), runtime.dispose()]);
  });

  test('interrupts in-flight adapter work during disposal', async () => {
    const interrupted = await Effect.runPromise(Ref.make(false));
    const runtime = createWebProcessRuntime({
      policyStore: policyStore(),
      publication: {
        publish: Effect.succeed({ changed: false }),
      },
      sources: fakeSource(() => Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true)))),
      wideEventSinkLayer: testWideEventSinkLayer(),
    });

    await runtime.sourceControl.start();
    await waitForSnapshot(
      runtime.sourceControl.getSnapshot,
      (snapshot) => sourceView(snapshot, 'claude.sessions').lifecycle === 'running',
    );
    await runtime.dispose();

    expect(await Effect.runPromise(Ref.get(interrupted))).toBe(true);
  });

  test('applies the bounded source timeout inside the managed runtime', async () => {
    const runtime = createWebProcessRuntime({
      policyStore: policyStore(),
      publication: {
        publish: Effect.succeed({ changed: false }),
      },
      sourceTimeout: Duration.millis(10),
      sources: fakeSource(() => Effect.never),
      wideEventSinkLayer: testWideEventSinkLayer(),
    });

    try {
      await runtime.sourceControl.start();
      const timedOut = await waitForSnapshot(
        runtime.sourceControl.getSnapshot,
        (snapshot) => sourceView(snapshot, 'claude.sessions').lastOutcome === 'timed-out',
      );
      expect(sourceView(timedOut, 'claude.sessions').reason).toEqual({
        code: 'timed-out',
        message: 'The source run timed out; previously stored data was preserved.',
      });
    } finally {
      await runtime.dispose();
    }
  });

  test('routes file delivery warnings and shutdown loss summaries directly to the console writer', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-web-wide-event-'));
    const writes: Array<{ line: string; severity: string }> = [];
    const runtime = createWebProcessRuntime({
      policyStore: policyStore(),
      publication: { publish: Effect.succeed({ changed: false }) },
      sources: fakeSource(() => Effect.succeed({ changed: false, inputCount: 1, outputCount: 1, warnings: [] })),
      wideEventSinkLayer: makeWebWideEventSinkLayer({
        appendLine: () => Promise.reject(new Error('fixture write failure')),
        consoleWrite: (line, severity) => writes.push({ line, severity }),
        directory,
        format: 'pretty',
        resource: {
          instanceId: 'web-delivery-test',
          runtimeMode: 'test',
          serviceName: 'ai-usage',
          serviceVersion: '0.1.0-test',
          surface: 'web',
        },
      }),
    });

    try {
      await runtime.sourceControl.start();
      await waitForSnapshot(
        runtime.sourceControl.getSnapshot,
        (snapshot) => sourceView(snapshot, 'claude.sessions').lastOutcome === 'success',
      );
    } finally {
      await runtime.dispose();
      await rm(directory, { force: true, recursive: true });
    }

    expect(writes.some(({ line }) => line.includes('[wide-event:file] append-failure'))).toBe(true);
    expect(writes.some(({ line }) => line.includes('[wide-event] delivery summary'))).toBe(true);
    expect(
      writes
        .filter(({ line }) => line.includes('[wide-event:file]') || line.includes('delivery summary'))
        .every(({ severity }) => severity === 'warn'),
    ).toBe(true);
  });

  test('reports an unsettled file append as lost before shutdown completes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-web-wide-event-shutdown-'));
    const writes: Array<{ line: string; severity: string }> = [];
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const blockedAppend = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const layer = makeWebWideEventSinkLayer({
      appendLine: async () => {
        markAppendStarted();
        await blockedAppend;
      },
      appendTimeoutMs: 5000,
      consoleWrite: (line, severity) => writes.push({ line, severity }),
      directory,
      drainTimeoutMs: 10,
      resource: {
        instanceId: 'web-shutdown-loss-test',
        runtimeMode: 'test',
        serviceName: 'ai-usage',
        serviceVersion: '0.1.0-test',
        surface: 'web',
      },
      silenceConsole: true,
    });
    const runtime = ManagedRuntime.make(layer);
    const event = wideEventFixture('shutdown-loss', 'web-shutdown-loss-test');

    try {
      await runtime.runPromise(WideEventSink.pipe(Effect.flatMap((sink) => sink.submit(event))));
      await appendStarted;
      await runtime.dispose();

      expect(writes.filter(({ line }) => line.includes('[wide-event] delivery summary'))).toEqual([
        {
          line: '[wide-event] delivery summary file(dropped=1,failed=0) console(dropped=0,failed=0)',
          severity: 'warn',
        },
      ]);
    } finally {
      releaseAppend();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('keeps shutdown best-effort when the diagnostic console writer fails', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-web-wide-event-writer-'));
    let markWarningObserved!: () => void;
    const warningObserved = new Promise<void>((resolve) => {
      markWarningObserved = resolve;
    });
    const layer = makeWebWideEventSinkLayer({
      appendLine: () => Promise.reject(new Error('fixture append failure')),
      consoleWrite: (line) => {
        if (line.includes('[wide-event:file] append-failure')) {
          markWarningObserved();
        }
        if (line.includes('[wide-event] delivery summary')) {
          throw new Error('fixture console writer failure');
        }
      },
      directory,
      resource: {
        instanceId: 'web-writer-failure-test',
        runtimeMode: 'test',
        serviceName: 'ai-usage',
        serviceVersion: '0.1.0-test',
        surface: 'web',
      },
      silenceConsole: true,
    });
    const runtime = ManagedRuntime.make(layer);
    const event = wideEventFixture('writer-failure', 'web-writer-failure-test');

    try {
      await runtime.runPromise(WideEventSink.pipe(Effect.flatMap((sink) => sink.submit(event))));
      await warningObserved;

      await expect(runtime.dispose()).resolves.toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('runs real Bun adapters against SQLite without a browser', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'ai-usage-web-source-control-'));
    const storage = createLocalHistoryStorage(home);
    const dbPath = path.join(home, '.local', 'share', 'ai-usage', 'usage.db');
    const machine: UsageMachine = {
      id: 'web-runtime-machine',
      label: 'Web Runtime Machine',
    };
    const sessionDirectory = path.join(home, '.codex', 'sessions', '2026', '01', '01');
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      path.join(sessionDirectory, 'fixture.jsonl'),
      `${JSON.stringify({
        payload: { cwd: '/work/runtime', id: 'runtime-session' },
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'session_meta',
      })}\n${JSON.stringify({
        payload: {
          info: {
            total_token_usage: {
              cached_input_tokens: 2,
              input_tokens: 12,
              output_tokens: 18,
              total_tokens: 30,
            },
          },
          type: 'token_count',
        },
        timestamp: '2026-01-01T00:01:00.000Z',
      })}\n`,
    );
    const runtime = createWebProcessRuntime({
      adapterOptions: { dbPath, machine },
      policyStore: policyStore(),
      publication: {
        publish: Effect.succeed({ changed: false }),
      },
      storage,
      wideEventSinkLayer: testWideEventSinkLayer(),
    });

    try {
      await runtime.sourceControl.start();
      await waitForSnapshot(
        runtime.sourceControl.getSnapshot,
        (snapshot) => sourceView(snapshot, 'codex.sessions').lastOutcome === 'success',
      );
      const stored = await Effect.runPromise(queryReportRows({ dbPath, originMachineIds: [machine.id] }));
      const codexRows = stored.rows.filter((row) => row.source.harnessKey === 'codex');
      expect(codexRows).toHaveLength(1);
      expect(codexRows[0]?.source.sourceSessionId).toBe('runtime-session');
    } finally {
      await runtime.dispose();
      await rm(home, { force: true, recursive: true });
    }
  });
});
