import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { TestMemoryStorage } from '@ai-usage/local-machine/testing/memory-storage';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { queryCodexWorkObservations } from '@ai-usage/usage-store/testing';
import { importCodexWorkObservations, initializeUsageStore, usageStorePath } from '@ai-usage/usage-store/writer';
import { Cause, Effect, Exit } from 'effect';
import { createScheduledSourceRegistry } from './source-adapters';
import { isolatedSourceOptions } from './source-test-fixtures';

const CORPUS_SIZE = 10_001;
const NOW = new Date('2026-10-22T12:00:00.000Z');
const BEFORE = canonicalInstantFromDate(new Date('2026-10-22T09:00:00.000Z'));
const machine = { id: 'corpus-machine', label: 'Disposable corpus' };
const countStored = (dbPath: string): number => {
  if (!existsSync(dbPath)) {
    return 0;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM codex_work_observations').get()?.count ?? 0;
  } finally {
    db.close();
  }
};
const createCorpusSource = async (home: string) => {
  const storage = new TestMemoryStorage(home);
  for (let index = 0; index < CORPUS_SIZE; index++) {
    const id = `session-${String(index).padStart(5, '0')}`;
    storage.writeText(
      `.codex/sessions/2026/${id}.jsonl`,
      JSON.stringify({
        timestamp: '2026-10-22T10:00:00.000Z',
        type: 'session_meta',
        payload: { id, cwd: '/fixture' },
      }),
    );
  }
  const registry = await Effect.runPromise(
    createScheduledSourceRegistry({ ...isolatedSourceOptions, machine, now: () => NOW }).pipe(
      Effect.provideService(LocalHistoryStorage, storage),
    ),
  );
  const source = registry.get('codex.sessions');
  if (source === undefined) {
    throw new Error('expected existing Codex source');
  }
  return source;
};

test('a 10001-session source imports every bounded snapshot, including a final empty clearing snapshot', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'codex-work-corpus-'));
  try {
    const dbPath = usageStorePath(home);
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(
      importCodexWorkObservations({
        dbPath,
        machineId: machine.id,
        observedAt: BEFORE,
        observations: [
          {
            format: 'codex-work-v1',
            sourceSessionId: 'session-10000',
            originator: null,
            source: null,
            threadSource: null,
            forkedFromId: null,
            lastEventAt: BEFORE,
            latestUserMessageAt: null,
            omittedRequests: 0,
            rejectedRecords: 0,
            requests: [
              {
                callId: 'old',
                tool: 'request_user_input_async',
                askedAt: BEFORE,
                acknowledgedAt: BEFORE,
                rejectedAt: null,
                questions: [{ id: null, text: 'Old question', textTruncated: false, answeredAt: null }],
              },
            ],
          },
        ],
      }),
    );
    const source = await createCorpusSource(home);
    const result = await Effect.runPromise(source.run({ reportProgress: () => Effect.void }));
    expect(result).toMatchObject({ changed: true, inputCount: CORPUS_SIZE, outputCount: CORPUS_SIZE });
    expect(countStored(dbPath)).toBe(CORPUS_SIZE);
    const final = await Effect.runPromise(
      queryCodexWorkObservations({ dbPath, machineId: machine.id, sourceSessionIds: ['session-10000'] }),
    );
    expect(final.observations[0]?.requests).toEqual([]);
    const unchanged = await Effect.runPromise(source.run({ reportProgress: () => Effect.void }));
    expect(unchanged.changed).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cancellation after a committed request batch prevents the next batch and a rerun resumes safely', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'codex-work-corpus-abort-'));
  try {
    const dbPath = usageStorePath(home);
    const source = await createCorpusSource(home);
    const signal = {
      get aborted() {
        return countStored(dbPath) > 0;
      },
    } as AbortSignal;
    const exit = await Effect.runPromiseExit(source.run({ reportProgress: () => Effect.void, signal }));
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    expect(countStored(dbPath)).toBe(10_000);
    const resumed = await Effect.runPromise(source.run({ reportProgress: () => Effect.void }));
    expect(resumed.changed).toBe(true);
    expect(countStored(dbPath)).toBe(CORPUS_SIZE);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
