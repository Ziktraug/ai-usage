import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { CollectionSourceId, SourceControlView } from '@ai-usage/report-core/source-control';
import type { ScheduledSource } from '@ai-usage/report-data/source-adapters';
import type { SourcePolicyStore } from '@ai-usage/report-data/source-control';
import { queryReportRows } from '@ai-usage/usage-store';
import { Duration, Effect, Ref } from 'effect';
import {
  createWebSourceControlRuntime,
  installWebSourceControlRuntime,
  requestSourceControlPublicationForServer,
  type WebSourceControlRuntime,
} from './source-control.server';

const detected = {
  availability: 'detected',
  reason: { code: 'none' },
} as const;

const policyStore = (): SourcePolicyStore => ({
  load: Effect.succeed({}),
  setEnabled: () => Effect.void,
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
    const runtime: WebSourceControlRuntime = {
      detectAll: async () => undefined,
      dispose: async () => undefined,
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
    };
    const uninstall = installWebSourceControlRuntime(runtime);

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
    const runtime = createWebSourceControlRuntime({
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
    });

    expect((await runtime.start()).instanceId).toBe('runtime-test');
    const completed = await waitForSnapshot(
      runtime.getSnapshot,
      (snapshot) =>
        sourceView(snapshot, 'claude.sessions').lastOutcome === 'success' &&
        snapshot.publication.revision === 'revision-1',
    );
    expect(completed.runningCount).toBe(0);
    expect(await Effect.runPromise(Ref.get(publications))).toBe(1);

    const uninstall = installWebSourceControlRuntime(runtime);
    expect(() => installWebSourceControlRuntime(runtime)).toThrow('already installed');
    uninstall();
    await Promise.all([runtime.dispose(), runtime.dispose()]);
  });

  test('interrupts in-flight adapter work during disposal', async () => {
    const interrupted = await Effect.runPromise(Ref.make(false));
    const runtime = createWebSourceControlRuntime({
      policyStore: policyStore(),
      publication: {
        publish: Effect.succeed({ changed: false }),
      },
      sources: fakeSource(() => Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true)))),
    });

    await runtime.start();
    await waitForSnapshot(
      runtime.getSnapshot,
      (snapshot) => sourceView(snapshot, 'claude.sessions').lifecycle === 'running',
    );
    await runtime.dispose();

    expect(await Effect.runPromise(Ref.get(interrupted))).toBe(true);
  });

  test('applies the bounded source timeout inside the managed runtime', async () => {
    const runtime = createWebSourceControlRuntime({
      policyStore: policyStore(),
      publication: {
        publish: Effect.succeed({ changed: false }),
      },
      sourceTimeout: Duration.millis(10),
      sources: fakeSource(() => Effect.never),
    });

    try {
      await runtime.start();
      const timedOut = await waitForSnapshot(
        runtime.getSnapshot,
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
    const runtime = createWebSourceControlRuntime({
      adapterOptions: { dbPath, machine },
      policyStore: policyStore(),
      publication: {
        publish: Effect.succeed({ changed: false }),
      },
      storage,
    });

    try {
      await runtime.start();
      await waitForSnapshot(
        runtime.getSnapshot,
        (snapshot) => sourceView(snapshot, 'codex.sessions').lastOutcome === 'success',
      );
      const stored = await Effect.runPromise(queryReportRows({ dbPath, originMachineIds: [machine.id] }));
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]?.source.sourceSessionId).toBe('runtime-session');
    } finally {
      await runtime.dispose();
      await rm(home, { force: true, recursive: true });
    }
  });
});
