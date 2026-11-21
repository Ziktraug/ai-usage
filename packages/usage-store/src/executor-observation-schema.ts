// Executor account-change barrier: its table, its rule and its additive migration. Imports no store module.

import type { ExecutorAccountChange } from '@ai-usage/report-core/delegation-qualification';
import { type ExecutorObservation, parseExecutorObservation } from '@ai-usage/report-core/work-executors';

export const EXECUTOR_ACCOUNT_CHANGES_TABLE = 'executor_account_changes';

const executorAccountChangesSchemaSql = `
  CREATE TABLE IF NOT EXISTS ${EXECUTOR_ACCOUNT_CHANGES_TABLE} (
    machine_id TEXT NOT NULL,
    harness TEXT NOT NULL CHECK (harness IN ('claude-code', 'codex')),
    account_fingerprint TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    changed_at TEXT,
    PRIMARY KEY (machine_id, harness)
  );
`;

/** The persisted barrier of one executor: the state `advanceExecutorAccountBarrier` moves. */
export interface ExecutorAccountBarrier extends ExecutorAccountChange {
  /** The last non-null fingerprint an observation of this executor carried. */
  readonly accountFingerprint: string;
  /** The newest observation time carrying that fingerprint. */
  readonly observedAt: string;
}

type BarrierState = Pick<ExecutorAccountBarrier, 'accountFingerprint' | 'changedAt' | 'observedAt'>;

/**
 * The barrier rule, applied to every imported observation in import order and to the retained
 * history when the table is created. Observation times are canonical instants, so text order is
 * time order. Returns the same reference when the observation moves nothing.
 *
 * - A null fingerprint never moves the state: an unknown identity is neither a change nor a
 *   confirmation of the current account.
 * - No state yet: record the fingerprint and its time; no change.
 * - The same fingerprint: advance the observation time (never back).
 * - Another fingerprint at or after the recorded time: the account changed at this time.
 * - Another fingerprint older than the recorded time (out of order): the barrier only grows. An
 *   observation older than the recorded change is already behind it and moves nothing; otherwise
 *   the change is placed at the newest observation of the current account, the latest time the
 *   current account is known to have been signed in.
 */
export const advanceExecutorAccountBarrier = (
  state: BarrierState | null,
  accountFingerprint: string | null,
  observedAt: string,
): BarrierState | null => {
  if (accountFingerprint === null) {
    return state;
  }
  if (state === null) {
    return { accountFingerprint, changedAt: null, observedAt };
  }
  if (accountFingerprint === state.accountFingerprint) {
    return observedAt > state.observedAt ? { ...state, observedAt } : state;
  }
  if (observedAt >= state.observedAt) {
    return { accountFingerprint, changedAt: observedAt, observedAt };
  }
  if (state.changedAt !== null && observedAt < state.changedAt) {
    return state;
  }
  return state.changedAt === state.observedAt ? state : { ...state, changedAt: state.observedAt };
};

interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

interface SqliteDatabase {
  exec: (sql: string) => unknown;
  query: (sql: string) => SqliteStatement;
}

export interface ExecutorObservationRecord {
  account_fingerprint: string | null;
  auth_evidence: string;
  auth_method: string | null;
  auth_state: string;
  binary_path: string | null;
  harness: string;
  machine_id: string;
  observed_at: string;
  outcome: string;
  version: string | null;
}

export interface ExecutorAccountChangeRecord {
  account_fingerprint: string;
  changed_at: string | null;
  harness: string;
  machine_id: string;
  observed_at: string;
}

export const observationFromRecord = (record: ExecutorObservationRecord): ExecutorObservation | null =>
  parseExecutorObservation({
    accountFingerprint: record.account_fingerprint,
    authEvidence: record.auth_evidence,
    authMethod: record.auth_method,
    authState: record.auth_state,
    binaryPath: record.binary_path,
    harness: record.harness,
    machineId: record.machine_id,
    observedAt: record.observed_at,
    outcome: record.outcome,
    version: record.version,
  });

export const executorKey = (machineId: string, harness: string): string => JSON.stringify([machineId, harness]);

export const tableMissing = (db: Pick<SqliteDatabase, 'query'>, table: string): boolean =>
  db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) === null;

const SELECT_BARRIER_SQL = `
  SELECT account_fingerprint, observed_at, changed_at
  FROM ${EXECUTOR_ACCOUNT_CHANGES_TABLE}
  WHERE machine_id = ? AND harness = ?
`;
const UPSERT_BARRIER_SQL = `
  INSERT INTO ${EXECUTOR_ACCOUNT_CHANGES_TABLE} (machine_id, harness, account_fingerprint, observed_at, changed_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (machine_id, harness) DO UPDATE SET
    account_fingerprint = excluded.account_fingerprint,
    observed_at = excluded.observed_at,
    changed_at = excluded.changed_at
`;

/**
 * Applies the barrier rule to observations inside the caller's transaction: each executor's state
 * is read once, advanced in memory in the given order and written back when it moved.
 */
export const advanceBarriers = (db: SqliteDatabase, observations: Iterable<ExecutorObservation>): void => {
  const select = db.query(SELECT_BARRIER_SQL);
  const upsert = db.query(UPSERT_BARRIER_SQL);
  const states = new Map<string, { readonly initial: BarrierState | null; current: BarrierState | null }>();
  for (const observation of observations) {
    const key = executorKey(observation.machineId, observation.harness);
    let entry = states.get(key);
    if (entry === undefined) {
      const stored = select.get(observation.machineId, observation.harness) as Pick<
        ExecutorAccountChangeRecord,
        'account_fingerprint' | 'changed_at' | 'observed_at'
      > | null;
      const initial =
        stored === null
          ? null
          : {
              accountFingerprint: stored.account_fingerprint,
              changedAt: stored.changed_at,
              observedAt: stored.observed_at,
            };
      entry = { current: initial, initial };
      states.set(key, entry);
    }
    entry.current = advanceExecutorAccountBarrier(
      entry.current,
      observation.accountFingerprint ?? null,
      observation.observedAt,
    );
  }
  for (const [key, entry] of states) {
    if (entry.current !== null && entry.current !== entry.initial) {
      const [machineId, harness] = JSON.parse(key) as [string, string];
      upsert.run(
        machineId,
        harness,
        entry.current.accountFingerprint,
        entry.current.observedAt,
        entry.current.changedAt,
      );
    }
  }
};

/**
 * Creates the barrier table inside the caller's migration transaction when it is absent (ADR 0075:
 * additive under usage `user_version` 4, presence is the signal) and backfills it from the retained
 * history with the same rule, so a change still visible at upgrade time is not lost; `true` when
 * the table was created. Idempotent: a second open finds it and changes nothing. Runs after the
 * `account_fingerprint` column exists.
 */
export const migrateExecutorAccountChangeSchema = (db: SqliteDatabase): boolean => {
  const missing = tableMissing(db, EXECUTOR_ACCOUNT_CHANGES_TABLE);
  db.exec(executorAccountChangesSchemaSql);
  if (!missing) {
    return false;
  }
  const rows = db
    .query(`
      SELECT machine_id, harness, observed_at, binary_path, version, auth_state, auth_evidence, auth_method,
        account_fingerprint, outcome
      FROM executor_observations
      ORDER BY machine_id, harness, observed_at ASC, id ASC
    `)
    .all() as ExecutorObservationRecord[];
  const retained: ExecutorObservation[] = [];
  for (const row of rows) {
    const observation = observationFromRecord(row);
    if (observation) {
      retained.push(observation);
    }
  }
  advanceBarriers(db, retained);
  return true;
};
