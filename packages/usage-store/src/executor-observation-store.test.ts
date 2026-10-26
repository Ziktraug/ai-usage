import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXECUTOR_BOUNDS, type ExecutorObservation } from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import {
  advanceExecutorAccountBarrier,
  EXECUTOR_ACCOUNT_CHANGES_TABLE,
  MAX_EXECUTOR_OBSERVATION_HISTORY,
} from './executor-observation-store';
import {
  importExecutorObservations,
  initializeUsageStore,
  queryExecutorAccountChanges,
  queryExecutorObservationHistory,
  queryLatestExecutorObservations,
} from './writer';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-history';

const observation = (
  harness: ExecutorObservation['harness'],
  observedAt: string,
  accountFingerprint?: string,
): ExecutorObservation => ({
  ...(accountFingerprint === undefined ? {} : { accountFingerprint }),
  authEvidence: `${harness} status exit 0`,
  authMethod: null,
  authState: 'logged-in',
  binaryPath: `/usr/local/bin/${harness}`,
  harness,
  machineId: MACHINE,
  observedAt,
  outcome: 'observed',
  version: '1.0.0',
});

const store = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'executor-observation-history-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(
    importExecutorObservations({
      dbPath,
      observations: [
        observation('claude-code', '2026-10-25T08:00:00.000Z', '0123456789abcdef'),
        observation('claude-code', '2026-10-25T09:00:00.000Z', 'fedcba9876543210'),
        observation('codex', '2026-10-25T08:30:00.000Z'),
        observation('claude-code', '2026-10-25T10:00:00.000Z', 'fedcba9876543210'),
        observation('codex', '2026-10-25T07:00:00.000Z', undefined),
        // Another machine's rows never enter this machine's history.
        { ...observation('claude-code', '2026-10-25T11:00:00.000Z'), machineId: 'other-machine' },
      ],
    }),
  );
  return dbPath;
};

describe('executor observation history', () => {
  test('lists the retained rows of one machine newest first, per harness when asked, re-validated', async () => {
    const dbPath = await store();
    const all = await Effect.runPromise(queryExecutorObservationHistory({ dbPath, machineId: MACHINE }));
    expect(all.truncated).toBe(false);
    expect(all.skipped).toBe(0);
    expect(
      all.observations.map((entry) => [entry.harness, entry.observedAt, entry.accountFingerprint ?? null]),
    ).toEqual([
      ['claude-code', '2026-10-25T10:00:00.000Z', 'fedcba9876543210'],
      ['claude-code', '2026-10-25T09:00:00.000Z', 'fedcba9876543210'],
      ['codex', '2026-10-25T08:30:00.000Z', null],
      ['claude-code', '2026-10-25T08:00:00.000Z', '0123456789abcdef'],
      ['codex', '2026-10-25T07:00:00.000Z', null],
    ]);

    const claude = await Effect.runPromise(
      queryExecutorObservationHistory({ dbPath, harness: 'claude-code', machineId: MACHINE }),
    );
    expect(claude.observations.map((entry) => entry.observedAt)).toEqual([
      '2026-10-25T10:00:00.000Z',
      '2026-10-25T09:00:00.000Z',
      '2026-10-25T08:00:00.000Z',
    ]);

    // The latest-per-executor read is unchanged: one row per harness.
    const latest = await Effect.runPromise(queryLatestExecutorObservations({ dbPath, machineId: MACHINE }));
    expect(latest.observations.map((entry) => [entry.harness, entry.observedAt])).toEqual([
      ['claude-code', '2026-10-25T10:00:00.000Z'],
      ['codex', '2026-10-25T08:30:00.000Z'],
    ]);
  });

  test('bounds the read and reports truncation instead of returning more', async () => {
    const dbPath = await store();
    const bounded = await Effect.runPromise(queryExecutorObservationHistory({ dbPath, limit: 2, machineId: MACHINE }));
    expect(bounded.observations).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
    expect(MAX_EXECUTOR_OBSERVATION_HISTORY).toBe(640);
    const failure = await Effect.runPromise(
      queryExecutorObservationHistory({ dbPath, limit: MAX_EXECUTOR_OBSERVATION_HISTORY + 1, machineId: MACHINE }).pipe(
        Effect.flip,
      ),
    );
    expect((failure as UsageStoreError).reason).toBe('invalid-input');
    const zero = await Effect.runPromise(
      queryExecutorObservationHistory({ dbPath, limit: 0, machineId: MACHINE }).pipe(Effect.flip),
    );
    expect((zero as UsageStoreError).reason).toBe('invalid-input');
  });
});

const ACCOUNT_A = '0123456789abcdef';
const ACCOUNT_B = 'fedcba9876543210';
const at = (minute: number): string => `2026-10-25T12:${String(minute).padStart(2, '0')}:00.000Z`;

const emptyStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'executor-account-change-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  return dbPath;
};

const changesOf = (dbPath: string, machineId = MACHINE) =>
  Effect.runPromise(queryExecutorAccountChanges({ dbPath, machineId }));

describe('executor account-change barrier', () => {
  test('the rule: a first fingerprint records, the same one advances, another one changes, null never moves', () => {
    expect(advanceExecutorAccountBarrier(null, null, at(0))).toBeNull();
    const recorded = advanceExecutorAccountBarrier(null, ACCOUNT_A, at(1));
    expect(recorded).toEqual({ accountFingerprint: ACCOUNT_A, changedAt: null, observedAt: at(1) });
    const advanced = advanceExecutorAccountBarrier(recorded, ACCOUNT_A, at(2));
    expect(advanced).toEqual({ accountFingerprint: ACCOUNT_A, changedAt: null, observedAt: at(2) });
    // An older observation of the same account and an unknown identity move nothing (same reference).
    expect(advanceExecutorAccountBarrier(advanced, ACCOUNT_A, at(1))).toBe(advanced);
    expect(advanceExecutorAccountBarrier(advanced, null, at(3))).toBe(advanced);
    const changed = advanceExecutorAccountBarrier(advanced, ACCOUNT_B, at(4));
    expect(changed).toEqual({ accountFingerprint: ACCOUNT_B, changedAt: at(4), observedAt: at(4) });
    const confirmed = advanceExecutorAccountBarrier(changed, ACCOUNT_B, at(6));
    expect(confirmed).toEqual({ accountFingerprint: ACCOUNT_B, changedAt: at(4), observedAt: at(6) });
    // Equal time, another fingerprint: a change at that time.
    expect(advanceExecutorAccountBarrier(confirmed, ACCOUNT_A, at(6))).toEqual({
      accountFingerprint: ACCOUNT_A,
      changedAt: at(6),
      observedAt: at(6),
    });
  });

  test('the rule: an out-of-order older observation of another account only makes the barrier later, never earlier', () => {
    const confirmed = { accountFingerprint: ACCOUNT_B, changedAt: at(4), observedAt: at(6) };
    // Older than the recorded change: already behind it, nothing moves.
    expect(advanceExecutorAccountBarrier(confirmed, ACCOUNT_A, at(3))).toBe(confirmed);
    // Between the change and the newest confirmation: the barrier moves to the newest confirmation.
    const conservative = advanceExecutorAccountBarrier(confirmed, ACCOUNT_A, at(5));
    expect(conservative).toEqual({ accountFingerprint: ACCOUNT_B, changedAt: at(6), observedAt: at(6) });
    expect(advanceExecutorAccountBarrier(conservative, ACCOUNT_A, at(5))).toBe(conservative);
    // No change recorded yet: the newest observation of the current account becomes the barrier.
    expect(
      advanceExecutorAccountBarrier(
        { accountFingerprint: ACCOUNT_A, changedAt: null, observedAt: at(2) },
        ACCOUNT_B,
        at(1),
      ),
    ).toEqual({ accountFingerprint: ACCOUNT_A, changedAt: at(2), observedAt: at(2) });
  });

  test('the import persists the barrier in the same transaction and pruning never touches it', async () => {
    const dbPath = await emptyStore();
    await Effect.runPromise(
      importExecutorObservations({ dbPath, observations: [observation('claude-code', at(1), ACCOUNT_A)] }),
    );
    expect(await changesOf(dbPath)).toEqual({
      changes: [
        {
          accountFingerprint: ACCOUNT_A,
          changedAt: null,
          harness: 'claude-code',
          machineId: MACHINE,
          observedAt: at(1),
        },
      ],
      persisted: true,
      skipped: 0,
      truncated: false,
    });
    // A harness that reports no identity (Codex) never gets a barrier.
    await Effect.runPromise(importExecutorObservations({ dbPath, observations: [observation('codex', at(1))] }));
    expect((await changesOf(dbPath)).changes.map((change) => change.harness)).toEqual(['claude-code']);
    // The change, then more confirmations of the new account than the store retains.
    await Effect.runPromise(
      importExecutorObservations({ dbPath, observations: [observation('claude-code', at(2), ACCOUNT_B)] }),
    );
    const refreshes = EXECUTOR_BOUNDS.maxRetainedPerExecutor + 2;
    const imported = await Effect.runPromise(
      importExecutorObservations({
        dbPath,
        observations: Array.from({ length: refreshes }, (_, index) =>
          observation('claude-code', at(3 + index), ACCOUNT_B),
        ),
      }),
    );
    expect(imported.pruned).toBeGreaterThan(0);
    const history = await Effect.runPromise(
      queryExecutorObservationHistory({ dbPath, harness: 'claude-code', machineId: MACHINE }),
    );
    expect(history.observations).toHaveLength(EXECUTOR_BOUNDS.maxRetainedPerExecutor);
    expect(history.observations.every((entry) => entry.accountFingerprint === ACCOUNT_B)).toBe(true);
    expect((await changesOf(dbPath)).changes).toEqual([
      {
        accountFingerprint: ACCOUNT_B,
        changedAt: at(2),
        harness: 'claude-code',
        machineId: MACHINE,
        observedAt: at(2 + refreshes),
      },
    ]);
    // Another machine's rows have their own barrier and never enter this machine's read.
    await Effect.runPromise(
      importExecutorObservations({
        dbPath,
        observations: [{ ...observation('claude-code', at(20), ACCOUNT_A), machineId: 'other-machine' }],
      }),
    );
    expect((await changesOf(dbPath)).changes.map((change) => change.machineId)).toEqual([MACHINE]);
    expect((await changesOf(dbPath, 'other-machine')).changes).toMatchObject([
      { accountFingerprint: ACCOUNT_A, changedAt: null, machineId: 'other-machine' },
    ]);
  });

  test('the fixture history derives the same barrier the qualification reads from it', async () => {
    const dbPath = await store();
    // Claude: A at 08:00, B at 09:00 and 10:00 → the change is at 09:00; Codex reports no identity.
    expect((await changesOf(dbPath)).changes).toEqual([
      {
        accountFingerprint: 'fedcba9876543210',
        changedAt: '2026-10-25T09:00:00.000Z',
        harness: 'claude-code',
        machineId: MACHINE,
        observedAt: '2026-10-25T10:00:00.000Z',
      },
    ]);
  });

  test('a store without the barrier table reads as not persisted; a row that no longer validates is counted', async () => {
    const dbPath = await emptyStore();
    await Effect.runPromise(
      importExecutorObservations({
        dbPath,
        observations: [observation('claude-code', at(1), ACCOUNT_A), observation('claude-code', at(2), ACCOUNT_B)],
      }),
    );
    const corrupting = new Database(dbPath, { create: false, readwrite: true });
    corrupting.exec(
      `INSERT INTO ${EXECUTOR_ACCOUNT_CHANGES_TABLE} (machine_id, harness, account_fingerprint, observed_at, changed_at)
       VALUES ('${MACHINE}', 'codex', 'not-a-fingerprint', '${at(3)}', NULL)`,
    );
    corrupting.close(true);
    expect(await changesOf(dbPath)).toMatchObject({ persisted: true, skipped: 1 });
    expect((await changesOf(dbPath)).changes.map((change) => change.harness)).toEqual(['claude-code']);

    // The query-only readers meet stores the engine has not reopened since the table was added.
    const dropping = new Database(dbPath, { create: false, readwrite: true });
    dropping.exec(`DROP TABLE ${EXECUTOR_ACCOUNT_CHANGES_TABLE}`);
    dropping.close(true);
    expect(await changesOf(dbPath)).toEqual({ changes: [], persisted: false, skipped: 0, truncated: false });
  });
});
