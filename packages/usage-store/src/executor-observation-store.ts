import {
  EXECUTOR_BOUNDS,
  type ExecutorObservation,
  parseExecutorObservation,
} from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import { UsageStoreError, type UsageStoreErrorReason } from './errors';

/**
 * Durable storage for executor observations (which harness CLIs a machine can run and whether
 * they are signed in), modelled on `skill-observation-store.ts`: its own table, its own source,
 * and a read path that bypasses the report bootstrap.
 *
 * Two properties are load-bearing:
 *
 * - **Rows are re-validated on read** with the same `parseExecutorObservation` that admitted
 *   them, so a tightened bound hides history instead of serving it; refused rows are counted in
 *   `skipped`, never dropped in silence.
 * - **Observations never advance the store generation.** They qualify a routing simulation; they
 *   are not report data and must not trigger a served-revision publication (ADR 0048 budget).
 */

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

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): unknown;
  query(sql: string): SqliteStatement;
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
              touched.add(JSON.stringify([observation.machineId, observation.harness]));
            }
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

  const queryLatestExecutorObservations = (
    input: QueryLatestExecutorObservationsInput,
  ): Effect.Effect<QueryLatestExecutorObservationsResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const limit = EXECUTOR_BOUNDS.maxObservations;
          // The reader is query-only and cannot add the ADR 0057 column; a store the engine has not
          // reopened since then has recorded no fingerprint, which reads as exactly that.
          const columns = db.query('PRAGMA table_info(executor_observations)').all() as Array<{ name?: unknown }>;
          const fingerprint = columns.some((column) => column.name === 'account_fingerprint')
            ? 'account_fingerprint'
            : 'NULL AS account_fingerprint';
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

  return { importExecutorObservations, queryLatestExecutorObservations };
};
