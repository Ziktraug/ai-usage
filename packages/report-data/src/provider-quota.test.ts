import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaBatch, ProviderQuotaBatchSource } from '@ai-usage/local-collectors';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { queryLatestProviderQuotaObservations, usageStorePath } from '@ai-usage/usage-store';
import { Cause, Deferred, Effect, Exit, Fiber, Ref } from 'effect';
import { queryLocalProviderQuotaHistory, refreshLocalProviderQuotas } from './provider-quota';
import {
  createProviderQuotaRefresh,
  type ProviderQuotaPersistence,
  type ResolvedProviderQuotaRefreshInput,
} from './provider-quota-refresh';

const observation = (observedAt: string): ProviderQuotaObservation => ({
  accountScope: null,
  machineId: 'machine-1',
  machineLabel: 'Laptop',
  observedAt,
  plan: 'plus',
  providerGeneratedAt: null,
  providerKey: 'codex',
  providerLabel: 'Codex',
  source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
  state: 'ok',
  windows: [
    {
      blocked: false,
      group: '5h',
      id: 'codex:primary',
      label: '5h',
      limitSeconds: 18_000,
      remainingPercent: 75,
      resetsAt: '2026-07-15T15:00:00.000Z',
      scope: 'provider',
      usedPercent: 25,
    },
  ],
});

const emptyBatch: ProviderQuotaBatch = {
  checkpoints: [],
  hasMore: false,
  observations: [],
  sourceEvents: [],
};

const refreshInput = (
  overrides: Partial<ResolvedProviderQuotaRefreshInput<never>> = {},
): ResolvedProviderQuotaRefreshInput<never> => ({
  backfillSource: null,
  dbPath: '/private/provider-quota-test.sqlite',
  liveCadenceMs: 0,
  liveSource: { collect: () => Effect.succeed(emptyBatch) },
  machine: { id: 'machine-1', label: 'Laptop' },
  now: new Date('2026-07-15T10:00:00.000Z'),
  ...overrides,
});

const fakePersistence = (
  importBatch: ProviderQuotaPersistence<never>['importBatch'],
): ProviderQuotaPersistence<never> => ({
  importBatch,
  queryBackfillStates: () => Effect.succeed([]),
  queryLatest: () => Effect.succeed({ observations: [], skipped: 0, truncated: false }),
  queryLiveState: () => Effect.succeed(null),
  recordAttempt: () => Effect.void,
});

describe('provider quota orchestration', () => {
  test('interrupts the owner inside the durable phase before its commit action', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const committed = yield* Ref.make(false);
        const refresh = createProviderQuotaRefresh(
          fakePersistence(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Ref.set(committed, true)),
              Effect.as({ coalesced: 0, inserted: 0, unchanged: 0 }),
            ),
          ),
        );
        const owner = yield* Effect.fork(refresh(refreshInput()));
        yield* Deferred.await(entered);
        const ownerExit = yield* Fiber.interrupt(owner);
        yield* Deferred.succeed(release, undefined);
        return { committed: yield* Ref.get(committed), ownerExit };
      }),
    );

    expect(Exit.isFailure(result.ownerExit)).toBe(true);
    if (Exit.isFailure(result.ownerExit)) {
      expect(Cause.isInterruptedOnly(result.ownerExit.cause)).toBe(true);
    }
    expect(result.committed).toBe(false);
  });

  test('lets a joined caller cancel without stopping the owner', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const collectCalls = yield* Ref.make(0);
        const refresh = createProviderQuotaRefresh(
          fakePersistence(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ coalesced: 0, inserted: 0, unchanged: 0 }),
            ),
          ),
        );
        const input = refreshInput({
          liveSource: {
            collect: () => Ref.update(collectCalls, (calls) => calls + 1).pipe(Effect.as(emptyBatch)),
          },
        });
        const owner = yield* Effect.fork(refresh(input));
        yield* Deferred.await(entered);
        const joinerController = new AbortController();
        const joiner = yield* Effect.fork(refresh({ ...input, signal: joinerController.signal }));
        yield* Effect.yieldNow();
        joinerController.abort();
        const joinerExit = yield* Fiber.await(joiner);
        yield* Deferred.succeed(release, undefined);
        const ownerExit = yield* Fiber.await(owner);
        return { collectCalls: yield* Ref.get(collectCalls), joinerExit, ownerExit };
      }),
    );

    expect(Exit.isFailure(result.joinerExit)).toBe(true);
    expect(Exit.isSuccess(result.ownerExit)).toBe(true);
    expect(result.collectCalls).toBe(1);
  });

  test('owner cancellation stops joiners and permits a fresh successful flight', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const blockWrite = yield* Ref.make(true);
        const committed = yield* Ref.make(0);
        const refresh = createProviderQuotaRefresh(
          fakePersistence(() =>
            Ref.get(blockWrite).pipe(
              Effect.flatMap((blocked) =>
                blocked
                  ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                  : Effect.void,
              ),
              Effect.andThen(Ref.update(committed, (count) => count + 1)),
              Effect.as({ coalesced: 0, inserted: 0, unchanged: 0 }),
            ),
          ),
        );
        const controller = new AbortController();
        const input = refreshInput({ signal: controller.signal });
        const owner = yield* Effect.fork(refresh(input));
        yield* Deferred.await(entered);
        const joiner = yield* Effect.fork(refresh(refreshInput()));
        yield* Effect.yieldNow();
        controller.abort();
        const ownerExit = yield* Fiber.await(owner);
        const joinerExit = yield* Fiber.await(joiner);
        yield* Deferred.succeed(release, undefined);
        yield* Ref.set(blockWrite, false);
        const retry = yield* refresh(refreshInput());
        return { committed: yield* Ref.get(committed), joinerExit, ownerExit, retry };
      }),
    );

    expect(Exit.isFailure(result.ownerExit)).toBe(true);
    expect(Exit.isFailure(result.joinerExit)).toBe(true);
    expect(result.retry.live).toBe('refreshed');
    expect(result.committed).toBe(1);
  });

  test('aborts an owner without post-abort writes and allows a clean retry', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-report-quota-abort-'));
    const dbPath = usageStorePath(home);
    const run = <A, E>(effect: Effect.Effect<A, E, typeof LocalHistoryStorage.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))));
    let calls = 0;
    const liveSource: ProviderQuotaBatchSource = {
      collect: (request) =>
        Effect.tryPromise({
          try: () =>
            new Promise((resolve, reject) => {
              calls += 1;
              if (calls > 1) {
                resolve({
                  checkpoints: [],
                  hasMore: false,
                  observations: [observation('2026-07-15T10:01:00.000Z')],
                  sourceEvents: [],
                });
                return;
              }
              const onAbort = (): void => {
                request.signal?.removeEventListener('abort', onAbort);
                reject(new Error('aborted'));
              };
              request.signal?.addEventListener('abort', onAbort, { once: true });
            }),
          catch: (error) => error,
        }),
    };
    const controller = new AbortController();
    const input = {
      dbPath,
      machine: { id: 'machine-1', label: 'Laptop' },
      options: {
        backfillSource: null,
        liveCadenceMs: 0,
        liveSource,
        now: () => new Date('2026-07-15T10:00:00.000Z'),
      },
      signal: controller.signal,
    } as const;
    const aborted = run(refreshLocalProviderQuotas(input));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(aborted).rejects.toThrow('aborted');
    expect(
      (
        await Effect.runPromise(
          queryLatestProviderQuotaObservations({ dbPath, machineId: 'machine-1', providerKey: 'codex' }),
        )
      ).observations,
    ).toHaveLength(0);

    const { signal: _signal, ...retryInput } = input;
    const retried = await run(refreshLocalProviderQuotas(retryInput));
    expect(retried.live).toBe('refreshed');
    expect(calls).toBe(2);
  });

  test('polls once per cadence and exposes independently bounded history', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-report-quota-'));
    const dbPath = usageStorePath(home);
    const run = <A, E>(effect: Effect.Effect<A, E, typeof LocalHistoryStorage.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))));
    let calls = 0;
    const liveSource: ProviderQuotaBatchSource = {
      collect: (request) => {
        calls++;
        return Effect.succeed({
          checkpoints: [],
          hasMore: false,
          observations: [observation((request.observedAt ?? new Date()).toISOString())],
          sourceEvents: [],
        });
      },
    };

    const input = {
      dbPath,
      machine: { id: 'machine-1', label: 'Laptop' },
      options: {
        backfillSource: null,
        liveSource,
        now: () => new Date('2026-07-15T10:00:00.000Z'),
      },
    } as const;
    const first = await run(refreshLocalProviderQuotas(input));
    const second = await run(refreshLocalProviderQuotas(input));
    const history = await run(
      queryLocalProviderQuotaHistory({
        dbPath,
        from: '2026-07-15T09:00:00.000Z',
        machineId: 'machine-1',
        maximumPoints: 10,
        providerKey: 'codex',
        to: '2026-07-15T11:00:00.000Z',
      }),
    );

    expect(first.live).toBe('refreshed');
    expect(second.live).toBe('skipped');
    expect(calls).toBe(1);
    expect(history.points).toHaveLength(1);
    expect(history.latest[0]?.source).toBe('live-api');
  });
});
