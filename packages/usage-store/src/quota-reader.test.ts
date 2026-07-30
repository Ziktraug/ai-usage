import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { Effect } from 'effect';
import {
  queryLatestProviderQuotaObservations,
  queryProviderQuotaObservations,
  queryProviderQuotaSourceStates,
  type ServedRevisionQueryTrace,
  type UsageStoreError,
} from './reader';
import { importProviderQuotaBatch, recordProviderQuotaSourceAttempt } from './writer';

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
      Effect.either(
        queryProviderQuotaObservations({
          dbPath,
          from: '2026-07-15T00:00:00.000Z',
          maximumObservations: 10_001,
          to: '2026-07-15T11:00:00.000Z',
        }),
      ),
    );

    expect(result._tag).toBe('Left');
    expect((result as { left: UsageStoreError }).left.reason).toBe('invalid-input');
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

  test('rolls back multi-call source-state admission beyond the reader budget', async () => {
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
      Effect.either(
        importProviderQuotaBatch({
          checkpointUpdates: [{ cursor: { offset: 1000 }, cursorKey: 'overflow-batch', ...source }],
          dbPath,
          items: [],
        }),
      ),
    );
    const attemptOverflow = await Effect.runPromise(
      Effect.either(
        recordProviderQuotaSourceAttempt({
          attemptedAt: new Date('2026-07-15T12:00:00.000Z'),
          cursorKey: 'overflow-attempt',
          dbPath,
          succeeded: false,
          ...source,
        }),
      ),
    );
    const states = await Effect.runPromise(queryProviderQuotaSourceStates({ dbPath, ...source }));

    expect(batchOverflow._tag).toBe('Left');
    expect((batchOverflow as { left: UsageStoreError }).left.reason).toBe('invalid-input');
    expect(attemptOverflow._tag).toBe('Left');
    expect((attemptOverflow as { left: UsageStoreError }).left.reason).toBe('invalid-input');
    expect(states).toHaveLength(1000);
    expect(states.some(({ cursorKey }) => cursorKey.startsWith('overflow-'))).toBe(false);
  });
});
