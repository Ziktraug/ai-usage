import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { Effect } from 'effect';
import {
  queryLatestLocalProviderQuotaObservations,
  queryLatestProviderQuotaObservations,
  queryProviderQuotaObservations,
  queryProviderQuotaSourceStates,
  type ServedRevisionQueryTrace,
  type UsageStoreError,
} from './reader';
import { importProviderQuotaBatch, recordProviderQuotaSourceAttempt, updateUsageMachineLabel } from './writer';

const temporaryRoots: string[] = [];
const OBSERVATION_TABLE_SCAN_PATTERN = /^SCAN (?:candidate|observations|provider_quota_observations)\b/u;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const observation = (index: number): ProviderQuotaObservation => ({
  accountScope: `account-${index}`,
  machineId: 'machine-a',
  machineLabel: 'Machine A',
  observedAt: `2026-07-15T0${index}:00:00.000Z`,
  plan: 'plus',
  providerGeneratedAt: null,
  providerKey: 'codex',
  providerLabel: 'Codex',
  source: { confidence: 'authoritative', key: `source-${index}`, mode: 'poll' },
  state: 'ok',
  windows: [
    {
      blocked: false,
      group: '5h',
      id: 'codex:primary',
      label: '5h',
      limitSeconds: 18_000,
      remainingPercent: 100 - index,
      resetsAt: '2026-07-15T15:00:00.000Z',
      scope: 'provider',
      usedPercent: index,
    },
  ],
});

const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-quota-reader-'));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath,
      items: [1, 2, 3].map((index) => ({ observation: observation(index), sourceEventKey: `event-${index}` })),
    }),
  );
  return dbPath;
};

describe('bounded provider quota readers', () => {
  test('reads only the local machine quota heads from one store snapshot', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine: { id: 'machine-a', label: 'Machine A' } }));
    await Effect.runPromise(
      importProviderQuotaBatch({
        checkpointUpdates: [],
        dbPath,
        items: [
          {
            observation: {
              ...observation(4),
              accountScope: 'peer-account',
              machineId: 'machine-b',
              machineLabel: 'Machine B',
            },
            sourceEventKey: 'peer-event',
          },
        ],
      }),
    );

    const latest = await Effect.runPromise(queryLatestLocalProviderQuotaObservations({ dbPath }));

    expect(latest.observations).toHaveLength(3);
    expect(latest.observations.every(({ observation: item }) => item.machineId === 'machine-a')).toBe(true);
  });

  test('bounds historical anchors and latest groups in SQL while preserving order', async () => {
    const dbPath = await createStore();

    const history = await Effect.runPromise(
      queryProviderQuotaObservations({
        dbPath,
        from: '2026-07-15T10:00:00.000Z',
        maximumObservations: 2,
        to: '2026-07-15T11:00:00.000Z',
      }),
    );
    const latest = await Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath, maximumObservations: 2 }));

    expect(history.observations.map(({ firstObservedAt }) => firstObservedAt)).toEqual([
      '2026-07-15T01:00:00.000Z',
      '2026-07-15T02:00:00.000Z',
    ]);
    expect(latest.observations.map(({ firstObservedAt }) => firstObservedAt)).toEqual([
      '2026-07-15T03:00:00.000Z',
      '2026-07-15T02:00:00.000Z',
    ]);
    expect(latest.truncated).toBe(true);
  });

  test('rejects caller-selected observation limits above the store budget', async () => {
    const dbPath = await createStore();
    const result = await Effect.runPromise(
      Effect.result(
        queryProviderQuotaObservations({
          dbPath,
          from: '2026-07-15T00:00:00.000Z',
          maximumObservations: 10_001,
          to: '2026-07-15T11:00:00.000Z',
        }),
      ),
    );

    expect(result._tag).toBe('Failure');
    expect((result as { failure: UsageStoreError }).failure.reason).toBe('invalid-input');
  });

  test('uses capped catalogs and indexed seeks instead of lifetime observation scans', async () => {
    const dbPath = await createStore();
    const historyTrace: ServedRevisionQueryTrace[] = [];
    const latestTrace: ServedRevisionQueryTrace[] = [];

    await Effect.runPromise(
      queryProviderQuotaObservations({
        dbPath,
        from: '2026-07-15T10:00:00.000Z',
        to: '2026-07-15T11:00:00.000Z',
        trace: (query) => historyTrace.push(query),
      }),
    );
    await Effect.runPromise(
      queryLatestProviderQuotaObservations({ dbPath, trace: (query) => latestTrace.push(query) }),
    );

    const database = new Database(dbPath, { create: false, readonly: true });
    try {
      const explain = ({ params, sql }: ServedRevisionQueryTrace): string[] => {
        const bindings = params.map((param) => {
          if (param === null || typeof param === 'number' || typeof param === 'string') {
            return param;
          }
          throw new Error('Quota query trace contains an unsupported test binding');
        });
        return (
          database.query(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{
            detail: string;
          }>
        ).map(({ detail }) => detail);
      };
      const historyPlan = historyTrace.flatMap(explain);
      const latestPlan = latestTrace.flatMap(explain);

      expect(historyPlan.some((detail) => detail.includes('idx_provider_quota_range_all'))).toBe(true);
      expect(historyPlan.some((detail) => detail.includes('idx_provider_quota_anchor_normalized'))).toBe(true);
      expect(latestPlan.some((detail) => detail.includes('idx_provider_quota_heads_order'))).toBe(true);
      expect([...historyPlan, ...latestPlan].some((detail) => OBSERVATION_TABLE_SCAN_PATTERN.test(detail))).toBe(false);
    } finally {
      database.close(true);
    }
  });

  test('preserves normalized anchor grouping, exact scope filters, and confidence-priority heads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-quota-semantics-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    const authoritativeNull = {
      ...observation(1),
      accountScope: null,
      observedAt: '2026-07-15T01:00:00.000Z',
      source: { confidence: 'authoritative', key: 'shared-source', mode: 'poll' },
    } as const satisfies ProviderQuotaObservation;
    const derivedEmpty = {
      ...observation(3),
      accountScope: '',
      observedAt: '2026-07-15T03:00:00.000Z',
      source: { confidence: 'derived', key: 'shared-source', mode: 'poll' },
    } as const satisfies ProviderQuotaObservation;
    await Effect.runPromise(
      importProviderQuotaBatch({
        checkpointUpdates: [],
        dbPath,
        items: [
          { observation: derivedEmpty, sourceEventKey: 'derived-empty' },
          { observation: authoritativeNull, sourceEventKey: 'authoritative-null' },
        ],
      }),
    );

    const queryHistory = (accountScope?: string | null) =>
      Effect.runPromise(
        queryProviderQuotaObservations({
          ...(accountScope === undefined ? {} : { accountScope }),
          dbPath,
          from: '2026-07-15T10:00:00.000Z',
          to: '2026-07-15T11:00:00.000Z',
        }),
      );
    const [normalized, exactNull, exactEmpty, latest] = await Promise.all([
      queryHistory(),
      queryHistory(null),
      queryHistory(''),
      Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath })),
    ]);

    expect(normalized.observations.map(({ firstObservedAt }) => firstObservedAt)).toEqual(['2026-07-15T03:00:00.000Z']);
    expect(exactNull.observations.map(({ firstObservedAt }) => firstObservedAt)).toEqual(['2026-07-15T01:00:00.000Z']);
    expect(exactEmpty.observations.map(({ firstObservedAt }) => firstObservedAt)).toEqual(['2026-07-15T03:00:00.000Z']);
    expect(latest.observations.map(({ firstObservedAt }) => firstObservedAt)).toEqual(['2026-07-15T01:00:00.000Z']);
  });

  test('admits lifetime checkpoints beyond one read budget while keeping reads bounded', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-quota-source-budget-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    const source = { machineId: 'machine-a', providerKey: 'codex', sourceKey: 'rollout' } as const;
    await Effect.runPromise(
      importProviderQuotaBatch({
        checkpointUpdates: Array.from({ length: 1000 }, (_, index) => ({
          cursor: { offset: index },
          cursorKey: `cursor-${String(index).padStart(4, '0')}`,
          ...source,
        })),
        dbPath,
        items: [],
      }),
    );

    const batchOverflow = await Effect.runPromise(
      Effect.result(
        importProviderQuotaBatch({
          checkpointUpdates: [{ cursor: { offset: 1000 }, cursorKey: 'overflow-batch', ...source }],
          dbPath,
          items: [],
        }),
      ),
    );
    const attemptOverflow = await Effect.runPromise(
      Effect.result(
        recordProviderQuotaSourceAttempt({
          attemptedAt: new Date('2026-07-15T12:00:00.000Z'),
          cursorKey: 'overflow-attempt',
          dbPath,
          succeeded: false,
          ...source,
        }),
      ),
    );
    const states = await Effect.runPromise(
      queryProviderQuotaSourceStates({
        dbPath,
        ...source,
        cursorKeys: ['cursor-0999', 'overflow-batch', 'overflow-attempt'],
      }),
    );

    expect(batchOverflow._tag).toBe('Success');
    expect(attemptOverflow._tag).toBe('Success');
    expect(states).toHaveLength(3);
    const all = await Effect.runPromise(Effect.result(queryProviderQuotaSourceStates({ dbPath, ...source })));
    expect(all._tag).toBe('Failure');
    const oversized = await Effect.runPromise(
      Effect.result(
        queryProviderQuotaSourceStates({
          dbPath,
          ...source,
          cursorKeys: Array.from({ length: 1001 }, (_, index) => String(index)),
        }),
      ),
    );
    expect(oversized._tag).toBe('Failure');
  });
});

/**
 * The real store shape after the Codex app-server started scoping its readings by account
 * fingerprint: one unscoped `codex` head it wrote before, never refreshed again, beside the scoped
 * head it refreshes every few minutes. The rollout backfill keeps writing unscoped rows, so the
 * unscoped head cannot be deleted; the latest read applies the supersession rule instead.
 */
describe('superseded unscoped quota heads', () => {
  const CODEX_FINGERPRINT = 'ee40c8e243efcef5';
  const reading = (
    accountScope: string | null,
    observedAt: string,
    overrides: Partial<ProviderQuotaObservation> = {},
  ): ProviderQuotaObservation => ({
    ...observation(1),
    accountScope,
    observedAt,
    source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
    windows: observation(1).windows.map((window) => ({ ...window, usedPercent: Date.parse(observedAt) % 100 })),
    ...overrides,
  });
  const createStoreWith = async (name: string, readings: readonly ProviderQuotaObservation[]): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), `usage-store-quota-${name}-`));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine: { id: 'machine-a', label: 'Machine A' } }));
    for (const item of readings) {
      // One batch per reading: a later identical reading must coalesce into the earlier row.
      await Effect.runPromise(
        importProviderQuotaBatch({ checkpointUpdates: [], dbPath, items: [{ observation: item }] }),
      );
    }
    return dbPath;
  };
  const heads = (result: { observations: { lastObservedAt: string; observation: ProviderQuotaObservation }[] }) =>
    result.observations.map(({ lastObservedAt, observation: item }) => [
      item.providerKey,
      item.accountScope,
      lastObservedAt,
    ]);

  test('omits the unscoped head once a scoped head of the same provider and machine is confirmed at or after it', async () => {
    const scopedFirst = reading(CODEX_FINGERPRINT, '2026-10-27T20:00:00.000Z');
    const dbPath = await createStoreWith('superseded', [
      scopedFirst,
      reading(null, '2026-10-27T20:21:00.000Z'),
      // The same scoped reading confirmed again: the row's first sighting stays older than the
      // unscoped head, only its last confirmation moves past it. Last confirmation is what counts.
      { ...scopedFirst, observedAt: '2026-10-27T20:25:00.000Z' },
    ]);

    const [latest, local, single, equal] = await Promise.all([
      Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath })),
      Effect.runPromise(queryLatestLocalProviderQuotaObservations({ dbPath })),
      // The superseded head sorts first here (newer first sighting), so a bound applied before the
      // rule would have returned only the dead head.
      Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath, maximumObservations: 1 })),
      createStoreWith('equal', [
        reading(null, '2026-10-27T20:21:00.000Z'),
        reading(CODEX_FINGERPRINT, '2026-10-27T20:21:00.000Z'),
      ]).then((equalPath) => Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath: equalPath }))),
    ]);

    expect(heads(latest)).toEqual([['codex', CODEX_FINGERPRINT, '2026-10-27T20:25:00.000Z']]);
    expect(latest).toMatchObject({ skipped: 0, truncated: false });
    expect(heads(local)).toEqual(heads(latest));
    expect(heads(single)).toEqual(heads(latest));
    expect(single).toMatchObject({ skipped: 0, truncated: false });
    expect(heads(equal)).toEqual([['codex', CODEX_FINGERPRINT, '2026-10-27T20:21:00.000Z']]);
  });

  test('keeps an unscoped head that is newer than every scoped head', async () => {
    const dbPath = await createStoreWith('fresher', [
      reading(CODEX_FINGERPRINT, '2026-10-27T20:00:00.000Z'),
      reading(null, '2026-10-27T20:21:00.000Z', { state: 'auth-required', windows: [] }),
    ]);

    const latest = await Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath }));

    expect(heads(latest)).toEqual([
      ['codex', null, '2026-10-27T20:21:00.000Z'],
      ['codex', CODEX_FINGERPRINT, '2026-10-27T20:00:00.000Z'],
    ]);
  });

  test('leaves unscoped-only providers, other machines and every scoped account alone', async () => {
    const dbPath = await createStoreWith('neighbours', [
      reading(null, '2026-10-27T18:00:00.000Z'),
      reading('1234567890abcdef', '2026-10-27T19:30:00.000Z'),
      reading(CODEX_FINGERPRINT, '2026-10-27T20:00:00.000Z'),
      reading(null, '2026-10-27T19:00:00.000Z', { providerKey: 'claude', providerLabel: 'Claude' }),
      reading(null, '2026-10-27T17:00:00.000Z', { machineId: 'machine-b', machineLabel: 'Machine B' }),
    ]);

    const [latest, local] = await Promise.all([
      Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath })),
      Effect.runPromise(queryLatestLocalProviderQuotaObservations({ dbPath })),
    ]);

    expect(heads(latest)).toEqual([
      ['codex', CODEX_FINGERPRINT, '2026-10-27T20:00:00.000Z'],
      ['codex', '1234567890abcdef', '2026-10-27T19:30:00.000Z'],
      ['claude', null, '2026-10-27T19:00:00.000Z'],
      ['codex', null, '2026-10-27T17:00:00.000Z'],
    ]);
    expect(latest.observations.map(({ observation: item }) => item.machineId)).toEqual([
      'machine-a',
      'machine-a',
      'machine-a',
      'machine-b',
    ]);
    expect(heads(local)).toEqual(heads(latest).slice(0, 3));
  });

  test('still answers the unscoped stream when a history read names it by account scope', async () => {
    const dbPath = await createStoreWith('explicit-scope', [
      reading(null, '2026-10-27T20:21:00.000Z'),
      reading(CODEX_FINGERPRINT, '2026-10-27T20:25:00.000Z'),
    ]);

    const [unscopedStream, everyStream] = await Promise.all([
      Effect.runPromise(
        queryProviderQuotaObservations({
          accountScope: null,
          dbPath,
          from: '2026-10-27T00:00:00.000Z',
          to: '2026-10-28T00:00:00.000Z',
        }),
      ),
      Effect.runPromise(
        queryProviderQuotaObservations({ dbPath, from: '2026-10-27T00:00:00.000Z', to: '2026-10-28T00:00:00.000Z' }),
      ),
    ]);

    expect(heads(unscopedStream)).toEqual([['codex', null, '2026-10-27T20:21:00.000Z']]);
    expect(heads(everyStream)).toEqual([
      ['codex', null, '2026-10-27T20:21:00.000Z'],
      ['codex', CODEX_FINGERPRINT, '2026-10-27T20:25:00.000Z'],
    ]);
  });

  test('does not resurrect the duplicate when the rollout backfill imports a later unscoped reading', async () => {
    const dbPath = await createStoreWith('rollout', [
      reading(null, '2026-10-27T20:21:00.000Z'),
      reading(CODEX_FINGERPRINT, '2026-10-27T20:25:00.000Z'),
    ]);
    await Effect.runPromise(
      importProviderQuotaBatch({
        checkpointUpdates: [],
        dbPath,
        items: [
          {
            observation: reading(null, '2026-10-27T21:00:00.000Z', {
              source: { confidence: 'historical', key: 'codex-rollout', mode: 'backfill' },
            }),
            sourceEventKey: 'rollout-event',
          },
        ],
      }),
    );

    const [latest, history] = await Promise.all([
      Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath })),
      Effect.runPromise(
        queryProviderQuotaObservations({ dbPath, from: '2026-10-27T00:00:00.000Z', to: '2026-10-28T00:00:00.000Z' }),
      ),
    ]);

    expect(heads(latest)).toEqual([['codex', CODEX_FINGERPRINT, '2026-10-27T20:25:00.000Z']]);
    // History keeps every stream: the rollout row is stored, it just never becomes a latest head.
    expect(history.observations.map(({ observation: item }) => item.source.key)).toEqual([
      'codex-app-server',
      'codex-app-server',
      'codex-rollout',
    ]);
  });

  test('bounds the result by unsuperseded heads, not by the rows the rule removed', async () => {
    const dbPath = await createStoreWith('budget', [
      reading(null, '2026-10-27T18:00:00.000Z'),
      reading('1234567890abcdef', '2026-10-27T19:30:00.000Z'),
      reading(CODEX_FINGERPRINT, '2026-10-27T20:00:00.000Z'),
    ]);

    const [two, one] = await Promise.all([
      Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath, maximumObservations: 2 })),
      Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath, maximumObservations: 1 })),
    ]);

    expect(heads(two).map(([, accountScope]) => accountScope)).toEqual([CODEX_FINGERPRINT, '1234567890abcdef']);
    expect(two.truncated).toBe(false);
    expect(heads(one).map(([, accountScope]) => accountScope)).toEqual([CODEX_FINGERPRINT]);
    expect(one.truncated).toBe(true);
  });
});
