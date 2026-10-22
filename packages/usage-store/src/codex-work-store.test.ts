import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { type CodexWorkObservation, parseCodexWorkObservation } from '@ai-usage/report-core/codex-work-observation';
import { Effect } from 'effect';
import { codexWorkSchemaSql, createCodexWorkStore, MAX_CODEX_WORK_SESSION_FILTER } from './codex-work-store';
import { UsageStoreError } from './errors';

const at = (minute: number) =>
  canonicalInstantFromDate(new Date(`2026-10-22T10:${String(minute).padStart(2, '0')}:00.000Z`));
const observation = (): CodexWorkObservation => ({
  format: 'codex-work-v1',
  sourceSessionId: 'session',
  originator: 'Codex Desktop',
  source: 'vscode',
  threadSource: 'user',
  forkedFromId: null,
  lastEventAt: at(5),
  latestUserMessageAt: at(4),
  omittedRequests: 0,
  rejectedRecords: 0,
  requests: [
    {
      callId: 'q1',
      tool: 'request_user_input_async',
      askedAt: at(1),
      acknowledgedAt: at(2),
      rejectedAt: null,
      questions: [{ id: null, text: 'Quel seuil retenir ?', textTruncated: false, answeredAt: null }],
    },
  ],
});

const fixture = () => {
  const db = new Database(':memory:');
  db.exec(codexWorkSchemaSql);
  const store = createCodexWorkStore({
    usageStoreError: (operation, _dbPath, cause, reason) =>
      new UsageStoreError({ operation, message: String(cause), cause, reason }),
    usageStoreReadError: (operation, _dbPath, cause) =>
      new UsageStoreError({ operation, message: String(cause), cause, reason: 'storage-failure' }),
    withUsageStoreWriter: (_path, use) => {
      db.exec('PRAGMA query_only = OFF');
      return use(db);
    },
    withUsageStoreReader: (_path, use) => {
      db.exec('PRAGMA query_only = ON');
      return use(db);
    },
  });
  return { db, ...store };
};

describe('local Codex request evidence', () => {
  test('a legacy store missing the local evidence table fails with schema-too-old', async () => {
    const store = fixture();
    try {
      store.db.exec('DROP TABLE codex_work_observations');
      const result = await Effect.runPromise(
        Effect.either(
          store.queryCodexWorkObservations({ dbPath: ':memory:', machineId: 'a', sourceSessionIds: ['session'] }),
        ),
      );
      expect(result._tag === 'Left' ? result.left.reason : null).toBe('schema-too-old');
    } finally {
      store.db.close();
    }
  });
  test('strict contract refuses impossible answers, duplicates, excess bounds and unknown fields', () => {
    const base = observation();
    expect(parseCodexWorkObservation(base)).toEqual(base);
    expect(parseCodexWorkObservation({ ...base, unknown: true })).toBeNull();
    expect(
      parseCodexWorkObservation({ ...base, requests: Array.from({ length: 17 }, () => base.requests[0]) }),
    ).toBeNull();
    expect(parseCodexWorkObservation({ ...base, requests: [base.requests[0], base.requests[0]] })).toBeNull();
    expect(
      parseCodexWorkObservation({
        ...base,
        requests: [{ ...base.requests[0], questions: [{ ...base.requests[0]?.questions[0], id: 'invented-id' }] }],
      }),
    ).toBeNull();
    expect(
      parseCodexWorkObservation({
        ...base,
        requests: [{ ...base.requests[0], questions: [{ ...base.requests[0]?.questions[0], answeredAt: at(3) }] }],
      }),
    ).toBeNull();
  });

  test('reimport is idempotent, newer empty evidence clears old requests, and machines stay isolated', async () => {
    const store = fixture();
    try {
      const input = { dbPath: ':memory:', machineId: 'a', observedAt: at(10), observations: [observation()] };
      expect(await Effect.runPromise(store.importCodexWorkObservations(input))).toEqual({
        changed: 1,
        unchanged: 0,
        rejected: 0,
      });
      expect(await Effect.runPromise(store.importCodexWorkObservations(input))).toEqual({
        changed: 0,
        unchanged: 1,
        rejected: 0,
      });
      expect(
        (
          await Effect.runPromise(
            store.queryCodexWorkObservations({ dbPath: ':memory:', machineId: 'b', sourceSessionIds: ['session'] }),
          )
        ).observations,
      ).toEqual([]);
      expect(
        (
          await Effect.runPromise(
            store.queryCodexWorkObservations({ dbPath: ':memory:', machineId: 'a', sourceSessionIds: ['session'] }),
          )
        ).observations[0]?.requests,
      ).toHaveLength(1);
      await Effect.runPromise(
        store.importCodexWorkObservations({
          ...input,
          observations: [{ ...observation(), lastEventAt: at(6), requests: [] }],
        }),
      );
      await Effect.runPromise(store.importCodexWorkObservations(input));
      expect(
        (
          await Effect.runPromise(
            store.queryCodexWorkObservations({ dbPath: ':memory:', machineId: 'a', sourceSessionIds: ['session'] }),
          )
        ).observations[0]?.requests,
      ).toEqual([]);
    } finally {
      store.db.close();
    }
  });

  test('bad records are counted, corrupt stored data is visible, and identity reads are bounded', async () => {
    const store = fixture();
    try {
      const input = { dbPath: ':memory:', machineId: 'a', observedAt: at(10), observations: [observation(), {}] };
      expect((await Effect.runPromise(store.importCodexWorkObservations(input))).rejected).toBe(1);
      store.db.exec("UPDATE codex_work_observations SET observation_json = '{}'");
      expect(
        await Effect.runPromise(
          store.queryCodexWorkObservations({ dbPath: ':memory:', machineId: 'a', sourceSessionIds: ['session'] }),
        ),
      ).toEqual({ observations: [], skipped: 1 });
      const failed = await Effect.runPromise(
        Effect.either(
          store.queryCodexWorkObservations({
            dbPath: ':memory:',
            machineId: 'a',
            sourceSessionIds: Array.from({ length: MAX_CODEX_WORK_SESSION_FILTER + 1 }, () => 'session'),
          }),
        ),
      );
      expect(failed._tag).toBe('Left');
    } finally {
      store.db.close();
    }
  });
});
