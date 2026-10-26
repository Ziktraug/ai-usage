import type { ExecutorAccountChange } from '@ai-usage/report-core/delegation-qualification';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  EXECUTOR_BOUNDS,
  type ExecutorHarness,
  type ExecutorObservation,
  isExecutorAccountFingerprint,
  isExecutorHarness,
  parseExecutorObservation,
} from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import { UsageStoreError, type UsageStoreErrorReason } from './errors';

/**
 * Durable storage for executor observations (which harness CLIs a machine can run and whether
 * they are signed in), modelled on `skill-observation-store.ts`: its own table, its own source,
 * and a read path that bypasses the report bootstrap.
 *
 * Three properties are load-bearing:
 *
 * - **Rows are re-validated on read** with the same `parseExecutorObservation` that admitted
 *   them, so a tightened bound hides history instead of serving it; refused rows are counted in
 *   `skipped`, never dropped in silence.
 * - **Observations never advance the store generation.** They qualify a routing simulation; they
 *   are not report data and must not trigger a served-revision publication (ADR 0048 budget).
 * - **The account-change barrier outlives the history.** `executor_account_changes` keeps, per
 *   executor, the last account fingerprint observed and when the signed-in account last changed,
 *   advanced by `advanceExecutorAccountBarrier` inside the import transaction and never touched by
 *   pruning. A quota collected before that change stays unattributable however many observations
 *   of the new account follow (PR #73 defect F3).
 */

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

export interface ImportExecutorObservationsInput {
  readonly dbPath: string;
  readonly observations: readonly unknown[];
}

export interface ExecutorObservationImportResult {
  readonly inserted: number;
  /** Older rows removed to keep `EXECUTOR_BOUNDS.maxRetainedPerExecutor` per machine and harness. */
  readonly pruned: number;
  /** Candidates that failed validation. Counted, so a broken collector is visible. */
  readonly rejected: number;
}

export interface QueryLatestExecutorObservationsInput {
  readonly dbPath: string;
  readonly machineId?: string;
}

export interface QueryLatestExecutorObservationsResult {
  /** The newest observation per (machine, harness), ordered by machine then harness. */
  readonly observations: readonly ExecutorObservation[];
  /** Persisted rows that no longer pass validation. Never silently omitted. */
  readonly skipped: number;
  /** More (machine, harness) pairs exist than `EXECUTOR_BOUNDS.maxObservations`. */
  readonly truncated: boolean;
}

export interface QueryExecutorObservationHistoryInput {
  readonly dbPath: string;
  /** One harness only; every harness of the machine when absent. */
  readonly harness?: ExecutorHarness;
  /** Rows returned at most; defaults to and may not exceed `MAX_EXECUTOR_OBSERVATION_HISTORY`. */
  readonly limit?: number;
  readonly machineId: string;
}

export interface QueryExecutorObservationHistoryResult {
  /** Newest first (`observedAt`, then insertion order); the retained rows of each executor, re-validated. */
  readonly observations: readonly ExecutorObservation[];
  /** Persisted rows that no longer pass validation. Never silently omitted. */
  readonly skipped: number;
  /** More rows exist than the limit returned. */
  readonly truncated: boolean;
}

export interface QueryExecutorAccountChangesInput {
  readonly dbPath: string;
  readonly machineId: string;
}

export interface QueryExecutorAccountChangesResult {
  /** One barrier per executor of the machine that ever reported a fingerprint, ordered by harness. */
  readonly changes: readonly ExecutorAccountBarrier[];
  /**
   * `false` when the store has no barrier table: the engine has not reopened it since the table was
   * added, so no change is persisted yet and only the history-derived change applies. A query-only
   * reader cannot create the table.
   */
  readonly persisted: boolean;
  /** Persisted rows that no longer pass validation. Never silently omitted. */
  readonly skipped: number;
  /** More executors exist than `EXECUTOR_BOUNDS.maxObservations`. */
  readonly truncated: boolean;
}

/** The retained history of every executor of one machine fits this bound by construction. */
export const MAX_EXECUTOR_OBSERVATION_HISTORY =
  EXECUTOR_BOUNDS.maxRetainedPerExecutor * EXECUTOR_BOUNDS.maxObservations;

interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

interface SqliteDatabase {
  exec: (sql: string) => unknown;
  query: (sql: string) => SqliteStatement;
}

interface ExecutorObservationStoreDependencies {
  readonly usageStoreError: (
    operation: string,
    dbPath: string,
    cause: unknown,
    reason: UsageStoreErrorReason,
  ) => UsageStoreError;
  readonly usageStoreReadError: (operation: string, dbPath: string, cause: unknown) => UsageStoreError;
  readonly withUsageStoreReader: <Value>(
    dbPath: string,
    use: (database: SqliteDatabase) => Effect.Effect<Value, UsageStoreError>,
  ) => Effect.Effect<Value, UsageStoreError>;
  readonly withUsageStoreWriter: <Value>(
    dbPath: string,
    use: (database: SqliteDatabase) => Effect.Effect<Value, UsageStoreError>,
  ) => Effect.Effect<Value, UsageStoreError>;
}

interface ExecutorObservationRecord {
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

interface ExecutorAccountChangeRecord {
  account_fingerprint: string;
  changed_at: string | null;
  harness: string;
  machine_id: string;
  observed_at: string;
}

const MAX_IMPORT_BATCH = 256;

const observationFromRecord = (record: ExecutorObservationRecord): ExecutorObservation | null =>
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

const barrierFromRecord = (record: ExecutorAccountChangeRecord): ExecutorAccountBarrier | null => {
  const observedAt = normalizeIsoTimestamp(record.observed_at);
  const changedAt = record.changed_at === null ? null : normalizeIsoTimestamp(record.changed_at);
  if (
    !(isExecutorHarness(record.harness) && isExecutorAccountFingerprint(record.account_fingerprint)) ||
    typeof record.machine_id !== 'string' ||
    record.machine_id.length === 0 ||
    observedAt === null ||
    (record.changed_at !== null && changedAt === null)
  ) {
    return null;
  }
  return {
    accountFingerprint: record.account_fingerprint,
    changedAt,
    harness: record.harness,
    machineId: record.machine_id,
    observedAt,
  };
};

const executorKey = (machineId: string, harness: string): string => JSON.stringify([machineId, harness]);

const tableMissing = (db: Pick<SqliteDatabase, 'query'>, table: string): boolean =>
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
const advanceBarriers = (db: SqliteDatabase, observations: Iterable<ExecutorObservation>): void => {
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

export const createExecutorObservationStore = (dependencies: ExecutorObservationStoreDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader, withUsageStoreWriter } = dependencies;

  const importExecutorObservations = (
    input: ImportExecutorObservationsInput,
  ): Effect.Effect<ExecutorObservationImportResult, UsageStoreError> => {
    if (input.observations.length > MAX_IMPORT_BATCH) {
      return Effect.fail(
        usageStoreError(
          'importExecutorObservations',
          input.dbPath,
          `Executor observation batch exceeds ${MAX_IMPORT_BATCH} entries`,
          'invalid-input',
        ),
      );
    }
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          let inserted = 0;
          let rejected = 0;
          let pruned = 0;
          db.exec('BEGIN IMMEDIATE');
          try {
            const insert = db.query(`
              INSERT INTO executor_observations (
                machine_id, harness, observed_at, binary_path, version, auth_state, auth_evidence, auth_method,
                account_fingerprint, outcome
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const prune = db.query(`
              DELETE FROM executor_observations
              WHERE machine_id = ? AND harness = ? AND id NOT IN (
                SELECT id FROM executor_observations
                WHERE machine_id = ? AND harness = ?
                ORDER BY observed_at DESC, id DESC
                LIMIT ?
              )
            `);
            const countChanges = db.query('SELECT changes() AS changed');
            const touched = new Set<string>();
            const admitted: ExecutorObservation[] = [];
            for (const candidate of input.observations) {
              const observation = parseExecutorObservation(candidate);
              if (!observation) {
                rejected++;
                continue;
              }
              insert.run(
                observation.machineId,
                observation.harness,
                observation.observedAt,
                observation.binaryPath,
                observation.version,
                observation.authState,
                observation.authEvidence,
                observation.authMethod,
                observation.accountFingerprint ?? null,
                observation.outcome,
              );
              inserted++;
              admitted.push(observation);
              touched.add(executorKey(observation.machineId, observation.harness));
            }
            // The barrier moves with the rows, in the same transaction and before pruning, so the
            // change survives whatever the retention removes.
            advanceBarriers(db, admitted);
            for (const pair of touched) {
              const [machineId, harness] = JSON.parse(pair) as [string, string];
              prune.run(machineId, harness, machineId, harness, EXECUTOR_BOUNDS.maxRetainedPerExecutor);
              pruned += (countChanges.get() as { changed: number }).changed;
            }
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          return { inserted, pruned, rejected };
        },
        catch: (cause) =>
          cause instanceof UsageStoreError
            ? cause
            : usageStoreError('importExecutorObservations', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

  /**
   * The reader is query-only and cannot add the ADR 0057 column; a store the engine has not
   * reopened since then has recorded no fingerprint, which reads as exactly that.
   */
  const fingerprintColumn = (db: SqliteDatabase): string => {
    const columns = db.query('PRAGMA table_info(executor_observations)').all() as Array<{ name?: unknown }>;
    return columns.some((column) => column.name === 'account_fingerprint')
      ? 'account_fingerprint'
      : 'NULL AS account_fingerprint';
  };

  const queryLatestExecutorObservations = (
    input: QueryLatestExecutorObservationsInput,
  ): Effect.Effect<QueryLatestExecutorObservationsResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const limit = EXECUTOR_BOUNDS.maxObservations;
          const fingerprint = fingerprintColumn(db);
          const rows = db
            .query(`
              SELECT machine_id, harness, observed_at, binary_path, version, auth_state, auth_evidence, auth_method,
                ${fingerprint}, outcome
              FROM (
                SELECT *, ROW_NUMBER() OVER (
                  PARTITION BY machine_id, harness ORDER BY observed_at DESC, id DESC
                ) AS recency
                FROM executor_observations
                ${input.machineId === undefined ? '' : 'WHERE machine_id = ?'}
              )
              WHERE recency = 1
              ORDER BY machine_id, harness
              LIMIT ?
            `)
            .all(...(input.machineId === undefined ? [] : [input.machineId]), limit + 1) as ExecutorObservationRecord[];
          const observations: ExecutorObservation[] = [];
          let skipped = 0;
          for (const row of rows.slice(0, limit)) {
            const observation = observationFromRecord(row);
            if (observation) {
              observations.push(observation);
            } else {
              skipped++;
            }
          }
          return { observations, skipped, truncated: rows.length > limit };
        },
        catch: (cause) => usageStoreReadError('queryLatestExecutorObservations', input.dbPath, cause),
      }),
    );

  /**
   * The retained observations of one machine's executors, newest first: what a delegation
   * qualification reads to tell an account change (`observedAccountChangeAt`) from a stable sign-in.
   * The latest-per-executor read above stays the routing simulation's.
   */
  const queryExecutorObservationHistory = (
    input: QueryExecutorObservationHistoryInput,
  ): Effect.Effect<QueryExecutorObservationHistoryResult, UsageStoreError> => {
    const limit = input.limit ?? MAX_EXECUTOR_OBSERVATION_HISTORY;
    if (!(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_EXECUTOR_OBSERVATION_HISTORY)) {
      return Effect.fail(
        usageStoreError(
          'queryExecutorObservationHistory',
          input.dbPath,
          `Executor observation history limit must be between 1 and ${MAX_EXECUTOR_OBSERVATION_HISTORY}`,
          'invalid-input',
        ),
      );
    }
    return withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const fingerprint = fingerprintColumn(db);
          const rows = db
            .query(`
              SELECT machine_id, harness, observed_at, binary_path, version, auth_state, auth_evidence, auth_method,
                ${fingerprint}, outcome
              FROM executor_observations
              WHERE machine_id = ?${input.harness === undefined ? '' : ' AND harness = ?'}
              ORDER BY observed_at DESC, id DESC
              LIMIT ?
            `)
            .all(
              input.machineId,
              ...(input.harness === undefined ? [] : [input.harness]),
              limit + 1,
            ) as ExecutorObservationRecord[];
          const observations: ExecutorObservation[] = [];
          let skipped = 0;
          for (const row of rows.slice(0, limit)) {
            const observation = observationFromRecord(row);
            if (observation) {
              observations.push(observation);
            } else {
              skipped++;
            }
          }
          return { observations, skipped, truncated: rows.length > limit };
        },
        catch: (cause) => usageStoreReadError('queryExecutorObservationHistory', input.dbPath, cause),
      }),
    );
  };

  /**
   * The persisted account-change barriers of one machine's executors: what a delegation
   * qualification combines with the history-derived change (the later of the two applies). Against
   * a store without the table, `persisted` is `false` and no change is returned; the reader cannot
   * create the table.
   */
  const queryExecutorAccountChanges = (
    input: QueryExecutorAccountChangesInput,
  ): Effect.Effect<QueryExecutorAccountChangesResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          if (tableMissing(db, EXECUTOR_ACCOUNT_CHANGES_TABLE)) {
            return { changes: [], persisted: false, skipped: 0, truncated: false };
          }
          const limit = EXECUTOR_BOUNDS.maxObservations;
          const rows = db
            .query(`
              SELECT machine_id, harness, account_fingerprint, observed_at, changed_at
              FROM ${EXECUTOR_ACCOUNT_CHANGES_TABLE}
              WHERE machine_id = ?
              ORDER BY harness
              LIMIT ?
            `)
            .all(input.machineId, limit + 1) as ExecutorAccountChangeRecord[];
          const changes: ExecutorAccountBarrier[] = [];
          let skipped = 0;
          for (const row of rows.slice(0, limit)) {
            const barrier = barrierFromRecord(row);
            if (barrier) {
              changes.push(barrier);
            } else {
              skipped++;
            }
          }
          return { changes, persisted: true, skipped, truncated: rows.length > limit };
        },
        catch: (cause) => usageStoreReadError('queryExecutorAccountChanges', input.dbPath, cause),
      }),
    );

  return {
    importExecutorObservations,
    queryExecutorAccountChanges,
    queryExecutorObservationHistory,
    queryLatestExecutorObservations,
  };
};
