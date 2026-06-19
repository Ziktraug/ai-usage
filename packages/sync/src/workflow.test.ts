import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageSnapshot } from '@ai-usage/core/snapshot';
import type { SourcedRow } from '@ai-usage/core/types';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { afterEach, describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { getSyncState } from './state';
import {
  addSyncRemote,
  pullOneShotSyncRemote,
  pullSyncRemote,
  selectSyncRemotesToPull,
  setSyncRemoteEnabled,
  tokenForSyncRemote,
} from './workflow';

const missingTokenEnv = 'AI_USAGE_SYNC_TEST_MISSING_TOKEN';

const row = (): SourcedRow => ({
  date: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness: 'Codex',
  provider: 'Codex API',
  name: 'session',
  model: 'gpt-5.3-codex',
  project: 'ai-usage',
  tokIn: 10,
  tokOut: 5,
  tokCr: 0,
  tokCw: 0,
  costActual: 0,
  costApprox: 0,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 1,
  tools: 0,
  linesAdded: null,
  linesDeleted: null,
  source: { harnessKey: 'codex', sourceSessionId: 'session-1' },
});

const snapshot = (machine = { id: 'remote-machine', label: 'Remote Machine' }) =>
  createUsageSnapshot({
    machine,
    rows: [row()],
    generatedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const withStorage = <A, E>(
  effect: Effect.Effect<A, E, import('@ai-usage/local-collectors/local-history').LocalHistoryStorage>,
) => {
  const home = mkdtemp();
  const storage = createLocalHistoryStorage(home);
  return Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage))).finally(() => {
    rmSync(home, { recursive: true, force: true });
  });
};

describe('sync workflow', () => {
  test('adds remotes and exposes UI-consumable state', async () => {
    const state = await withStorage(
      Effect.gen(function* () {
        yield* addSyncRemote({
          name: 'macbook',
          url: 'http://192.168.1.63:3847/snapshot',
          tokenEnv: missingTokenEnv,
        });
        return yield* getSyncState;
      }),
    );

    expect(state.remotes[0]).toMatchObject({
      name: 'macbook',
      enabled: true,
      tokenStatus: 'missing',
      rows: 0,
    });
  });

  test('pulls and stores a configured remote snapshot', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(snapshot()), { status: 200 })) as unknown as typeof fetch;

    const result = await withStorage(
      Effect.gen(function* () {
        yield* addSyncRemote({ name: 'macbook', url: 'http://remote/snapshot', tokenEnv: null });
        const remote = (yield* selectSyncRemotesToPull('macbook'))[0]!;
        yield* pullSyncRemote(remote);
        return yield* getSyncState;
      }),
    );

    expect(result.remotes[0]).toMatchObject({
      name: 'macbook',
      machineLabel: 'Remote Machine',
      rows: 1,
      tokenStatus: 'none',
    });
  });

  test('toggles remote enabled state', async () => {
    const state = await withStorage(
      Effect.gen(function* () {
        yield* addSyncRemote({ name: 'macbook', url: 'http://remote/snapshot', tokenEnv: null });
        yield* setSyncRemoteEnabled('macbook', false);
        return yield* getSyncState;
      }),
    );

    expect(state.remotes[0]?.enabled).toBe(false);
  });

  test('pulls a one-shot remote without preconfigured storage', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(snapshot()), { status: 200 })) as unknown as typeof fetch;

    const state = await withStorage(
      Effect.gen(function* () {
        yield* pullOneShotSyncRemote({ name: 'macbook', url: 'http://remote/snapshot', tokenEnv: null });
        return yield* getSyncState;
      }),
    );

    expect(state.remotes).toHaveLength(0);
    expect(state.storedSnapshots[0]?.machineLabel).toBe('Remote Machine');
  });

  test('fails when a configured token env is missing', async () => {
    const error = await withStorage(
      Effect.gen(function* () {
        yield* addSyncRemote({
          name: 'macbook',
          url: 'http://remote/snapshot',
          tokenEnv: missingTokenEnv,
        });
        const remote = (yield* selectSyncRemotesToPull('macbook'))[0]!;
        return yield* Effect.flip(tokenForSyncRemote(remote));
      }),
    );

    if (error._tag !== 'SyncWorkflowError') throw new Error(`Expected SyncWorkflowError, got ${error._tag}`);
    expect(error.reason).toBe('missing-token');
  });

  test('rejects syncing this machine from itself', async () => {
    const error = await withStorage(
      Effect.gen(function* () {
        const localMachine = yield* ensureMachineConfig;
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(snapshot(localMachine)), { status: 200 })) as unknown as typeof fetch;
        yield* addSyncRemote({ name: 'self', url: 'http://self/snapshot', tokenEnv: null });
        const remote = (yield* selectSyncRemotesToPull('self'))[0]!;
        return yield* Effect.flip(pullSyncRemote(remote));
      }),
    );

    if (error._tag !== 'SyncWorkflowError') throw new Error(`Expected SyncWorkflowError, got ${error._tag}`);
    expect(error.reason).toBe('self-sync');
  });
});

const mkdtemp = () => {
  const home = path.join(tmpdir(), `ai-usage-sync-workflow-${crypto.randomUUID()}`);
  mkdirSync(home, { recursive: true });
  return home;
};
