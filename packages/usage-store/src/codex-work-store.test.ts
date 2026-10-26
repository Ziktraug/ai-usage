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
      return use(db as unknown as Parameters<typeof use>[0]);
    },
    withUsageStoreReader: (_path, use) => {
      db.exec('PRAGMA query_only = ON');
      return use(db as unknown as Parameters<typeof use>[0]);
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
        Effect.result(
          store.queryCodexWorkObservations({ dbPath: ':memory:', machineId: 'a', sourceSessionIds: ['session'] }),
        ),
      );
      expect(result._tag === 'Failure' ? result.failure.reason : null).toBe('schema-too-old');
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
      ).toEqual({ observations: [], skipped: 1, incompleteSessionIds: ['session'] });
      const failed = await Effect.runPromise(
        Effect.result(
          store.queryCodexWorkObservations({
            dbPath: ':memory:',
            machineId: 'a',
            sourceSessionIds: Array.from({ length: MAX_CODEX_WORK_SESSION_FILTER + 1 }, () => 'session'),
          }),
        ),
      );
      expect(failed._tag).toBe('Failure');
    } finally {
      store.db.close();
    }
  });
});

test('collection membership invalidates missing sessions without deleting their historical requests', async () => {
  const store = fixture();
  const base = { dbPath: ':memory:', machineId: 'a', observedAt: at(10) };
  const read = () =>
    Effect.runPromise(store.queryCodexWorkObservations({ ...base, sourceSessionIds: ['session', 'missing'] }));
  const phase = (id: string, step: 'start' | 'observations' | 'complete', observations: readonly unknown[] = []) =>
    Effect.runPromise(store.importCodexWorkObservations({ ...base, observations, collection: { id, phase: step } }));
  try {
    await Effect.runPromise(store.importCodexWorkObservations({ ...base, observations: [observation()] }));
    expect((await read()).incompleteSessionIds).toEqual(['session', 'missing']);
    await phase('first', 'start');
    await phase('first', 'observations', [observation()]);
    expect((await read()).incompleteSessionIds).toEqual(['session', 'missing']);
    await phase('first', 'complete');
    expect((await read()).incompleteSessionIds).toEqual(['missing']);
    const historical = (await read()).observations;
    // Same wall-clock time: membership, not lastEventAt/observedAt, identifies the current pass.
    await phase('second', 'start');
    await phase('second', 'complete');
    expect((await read()).incompleteSessionIds).toEqual(['session', 'missing']);
    expect((await read()).observations).toEqual(historical);
    await phase('third', 'start');
    await phase('third', 'observations', [observation()]);
    await phase('third', 'complete');
    expect((await read()).incompleteSessionIds).toEqual(['missing']);
    expect((await read()).observations).toEqual(historical);
  } finally {
    store.db.close();
  }
});

test('an interrupted collection, late completion and older import cannot establish complete coverage', async () => {
  const store = fixture();
  const base = { dbPath: ':memory:', machineId: 'a', observedAt: at(10) };
  const phase = (id: string, step: 'start' | 'observations' | 'complete', observations: readonly unknown[] = []) =>
    Effect.runPromise(store.importCodexWorkObservations({ ...base, observations, collection: { id, phase: step } }));
  const read = () => Effect.runPromise(store.queryCodexWorkObservations({ ...base, sourceSessionIds: ['session'] }));
  try {
    await phase('first', 'start');
    await phase('first', 'observations', [observation()]);
    await phase('first', 'complete');
    await phase('second', 'start');
    await phase('first', 'observations', [observation()]);
    await phase('first', 'complete');
    expect((await read()).incompleteSessionIds).toEqual(['session']);
    await phase('second', 'observations', [{ ...observation(), lastEventAt: at(4) }]);
    await phase('second', 'complete');
    expect((await read()).incompleteSessionIds).toEqual(['session']);
    expect((await read()).observations[0]?.requests).toHaveLength(1);
  } finally {
    store.db.close();
  }
});

test('read-only legacy stores without coverage preserve evidence and report unknown without migration', async () => {
  const store = fixture();
  const base = { dbPath: ':memory:', machineId: 'a', observedAt: at(10) };
  try {
    await Effect.runPromise(store.importCodexWorkObservations({ ...base, observations: [observation()] }));
    store.db.exec('DROP TABLE codex_work_collection_coverage');
    const read = await Effect.runPromise(store.queryCodexWorkObservations({ ...base, sourceSessionIds: ['session'] }));
    expect(read.incompleteSessionIds).toEqual(['session']);
    expect(read.observations[0]?.requests).toHaveLength(1);
    expect(
      store.db.query("SELECT name FROM sqlite_master WHERE name='codex_work_collection_coverage'").get(),
    ).toBeNull();
  } finally {
    store.db.close();
  }
});
