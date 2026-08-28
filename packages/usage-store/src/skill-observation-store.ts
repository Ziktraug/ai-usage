import { MAX_SKILL_OBSERVATION_BATCH, parseSkillObservation } from '@ai-usage/report-core/skill-observation';
import { Effect } from 'effect';
import { UsageStoreError, type UsageStoreErrorReason } from './errors';
import type {
  ImportSkillObservationsInput,
  QuerySkillObservationsInput,
  QuerySkillObservationsResult,
  RetainSkillObservationsInput,
  RetainSkillObservationsResult,
  SkillObservationImportResult,
  StoredSkillObservation,
} from './index';

/**
 * Durable storage for the skill-observation fact family (ADR 0022), modelled on
 * `provider-quota-store.ts`: its own tables, its own collector, and a read path
 * that does not go through the report bootstrap.
 *
 * Two properties are load-bearing and easy to erode:
 *
 * - **Rows are re-validated on read.** `parseSkillObservation` runs on the way
 *   out as well as in, so any tightening of that parser retroactively hides
 *   history already on disk. Rows that fail are counted in `skipped`, never
 *   silently discarded.
 * - **The tier never collapses.** Reads group by tier and harness; nothing here
 *   sums across them.
 */

const MAX_SKILL_OBSERVATION_READ = 50_000;
const DEFAULT_SKILL_OBSERVATION_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
// Bounds WAL growth of each retention transaction; every batch commits independently.
const SKILL_OBSERVATION_RETENTION_BATCH_SIZE = 20_000;

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  finalize(): void;
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  clearStatements(): void;
  close(throwOnError?: boolean): void;
  exec(sql: string): unknown;
  readonly inTransaction: boolean;
  query(sql: string): SqliteStatement;
}

interface SkillObservationRecord {
  args_present: number | null;
  first_observed_at: string;
  harness_key: string;
  id: number;
  last_observed_at: string;
  machine_id: string;
  observation_key: string;
  observed_at: string;
  project_path: string | null;
  resolved_path: string | null;
  session_id: string;
  skill_name: string;
  success: number | null;
  tier: string;
}

interface SkillObservationStoreDependencies {
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

const booleanColumn = (value: boolean | null): number | null => {
  if (value === null) {
    return null;
  }
  return value ? 1 : 0;
};

const booleanFromColumn = (value: number | null): boolean | null => {
  if (value === null) {
    return null;
  }
  return value === 1;
};

export const createSkillObservationStore = (dependencies: SkillObservationStoreDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader, withUsageStoreWriter } = dependencies;

  /**
   * Re-import of an unchanged transcript is the normal case, not an error: the
   * collectors re-scan on every sweep. A repeated observation refreshes
   * `last_observed_at` and counts as unchanged.
   */
  const importSkillObservations = (
    input: ImportSkillObservationsInput,
  ): Effect.Effect<SkillObservationImportResult, UsageStoreError> => {
    if (input.observations.length > MAX_SKILL_OBSERVATION_BATCH) {
      return Effect.fail(
        usageStoreError(
          'importSkillObservations',
          input.dbPath,
          `Skill observation batch exceeds its ${MAX_SKILL_OBSERVATION_BATCH}-observation budget`,
          'invalid-input',
        ),
      );
    }
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const result: SkillObservationImportResult = { inserted: 0, rejected: 0, unchanged: 0 };
          const importedAt = (input.importedAt ?? new Date()).toISOString();
          db.exec('BEGIN IMMEDIATE');
          try {
            // The identity is checked before the write rather than inferred
            // from a RETURNING expression: two imports inside one batch share
            // an `importedAt`, which would make a first/last timestamp
            // comparison call a repeat an insert.
            const existing = db.query(`
              SELECT id FROM skill_observations
              WHERE machine_id = ? AND harness_key = ? AND session_id = ? AND tier = ? AND observation_key = ?
            `);
            const insert = db.query(`
              INSERT INTO skill_observations (
                harness_key, skill_name, tier, machine_id, session_id, observation_key,
                observed_at, project_path, resolved_path, args_present, success,
                first_observed_at, last_observed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(machine_id, harness_key, session_id, tier, observation_key) DO UPDATE SET
                last_observed_at = excluded.last_observed_at,
                skill_name = excluded.skill_name,
                observed_at = excluded.observed_at,
                project_path = excluded.project_path,
                resolved_path = excluded.resolved_path,
                args_present = excluded.args_present,
                success = excluded.success
            `);
            for (const candidate of input.observations) {
              const observation = parseSkillObservation(candidate);
              if (!observation) {
                // A malformed observation is counted, never dropped in silence:
                // the collector that produced it is the thing to fix.
                result.rejected++;
                continue;
              }
              const seen =
                existing.get(
                  input.machineId,
                  observation.harnessKey,
                  observation.sessionId,
                  observation.tier,
                  observation.observationKey,
                ) !== null;
              insert.run(
                observation.harnessKey,
                observation.skillName,
                observation.tier,
                input.machineId,
                observation.sessionId,
                observation.observationKey,
                observation.observedAt,
                observation.projectPath,
                observation.resolvedPath,
                booleanColumn(observation.argsPresent),
                booleanColumn(observation.success),
                importedAt,
                importedAt,
              );
              if (seen) {
                result.unchanged++;
              } else {
                result.inserted++;
              }
            }
            if (result.inserted > 0 || result.unchanged > 0) {
              db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
            }
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          return result;
        },
        catch: (cause) =>
          cause instanceof UsageStoreError
            ? cause
            : usageStoreError('importSkillObservations', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

  const storedObservationFromRecord = (record: SkillObservationRecord): StoredSkillObservation | null => {
    const observation = parseSkillObservation({
      argsPresent: booleanFromColumn(record.args_present),
      harnessKey: record.harness_key,
      observationKey: record.observation_key,
      observedAt: record.observed_at,
      projectPath: record.project_path,
      resolvedPath: record.resolved_path,
      sessionId: record.session_id,
      skillName: record.skill_name,
      success: booleanFromColumn(record.success),
      tier: record.tier,
    });
    return observation
      ? {
          firstObservedAt: record.first_observed_at,
          id: record.id,
          lastObservedAt: record.last_observed_at,
          machineId: record.machine_id,
          observation,
        }
      : null;
  };

  const querySkillObservations = (
    input: QuerySkillObservationsInput,
  ): Effect.Effect<QuerySkillObservationsResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const maximum = input.maximumObservations ?? MAX_SKILL_OBSERVATION_READ;
          if (!(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_SKILL_OBSERVATION_READ)) {
            throw usageStoreError(
              'querySkillObservations',
              input.dbPath,
              `maximumObservations must be from 1 through ${MAX_SKILL_OBSERVATION_READ}`,
              'invalid-input',
            );
          }
          const clauses: string[] = [];
          const params: unknown[] = [];
          if (input.skillName !== undefined) {
            clauses.push('skill_name = ?');
            params.push(input.skillName);
          }
          if (input.harnessKey !== undefined) {
            clauses.push('harness_key = ?');
            params.push(input.harnessKey);
          }
          if (input.tier !== undefined) {
            clauses.push('tier = ?');
            params.push(input.tier);
          }
          if (input.machineId !== undefined) {
            clauses.push('machine_id = ?');
            params.push(input.machineId);
          }
          if (input.from !== undefined) {
            clauses.push('observed_at >= ?');
            params.push(input.from);
          }
          if (input.to !== undefined) {
            clauses.push('observed_at <= ?');
            params.push(input.to);
          }
          const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
          const sql = `
            SELECT * FROM skill_observations
            ${whereSql}
            ORDER BY observed_at DESC, id DESC
            LIMIT ?
          `;
          const queryParams = [...params, maximum + 1];
          input.trace?.({ params: queryParams, sql });
          const rows = db.query(sql).all(...queryParams) as SkillObservationRecord[];
          const truncated = rows.length > maximum;
          const observations: StoredSkillObservation[] = [];
          let skipped = 0;
          for (const row of rows.slice(0, maximum)) {
            const stored = storedObservationFromRecord(row);
            if (stored) {
              observations.push(stored);
            } else {
              skipped++;
            }
          }
          return { observations, skipped, truncated };
        },
        catch: (cause) => usageStoreReadError('querySkillObservations', input.dbPath, cause),
      }),
    );

  const retainSkillObservations = (
    input: RetainSkillObservationsInput,
  ): Effect.Effect<RetainSkillObservationsResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const now = input.now ?? Date.now();
          const retentionMs = input.retentionMs ?? DEFAULT_SKILL_OBSERVATION_RETENTION_MS;
          if (!(Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(retentionMs) && retentionMs > 0)) {
            throw usageStoreError(
              'retainSkillObservations',
              input.dbPath,
              'Skill observation retention options are invalid',
              'invalid-input',
            );
          }
          // Observations are small and few - tens to hundreds - so retention is
          // a plain age cutoff rather than the quota family's downsampling.
          // Nothing here is aggregated away: an observation is kept whole or
          // dropped whole, so a surviving count never silently changes meaning.
          const cutoff = new Date(now - retentionMs).toISOString();
          const deleteBatch = db.query(`
            DELETE FROM skill_observations
            WHERE id IN (SELECT id FROM skill_observations WHERE observed_at < ? LIMIT ?)
          `);
          const countChanges = db.query('SELECT changes() AS changed');
          let deleted = 0;
          for (;;) {
            deleteBatch.run(cutoff, SKILL_OBSERVATION_RETENTION_BATCH_SIZE);
            const { changed } = countChanges.get() as { changed: number };
            deleted += changed;
            if (changed < SKILL_OBSERVATION_RETENTION_BATCH_SIZE) {
              break;
            }
          }
          return { deleted };
        },
        catch: (cause) =>
          cause instanceof UsageStoreError
            ? cause
            : usageStoreError('retainSkillObservations', input.dbPath, cause, 'storage-failure'),
      }),
    );

  return { importSkillObservations, querySkillObservations, retainSkillObservations };
};
