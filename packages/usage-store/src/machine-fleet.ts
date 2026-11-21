import path from 'node:path';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { Effect } from 'effect';
import { withUsageStoreReader } from './connections';
import { type UsageStoreError, usageStoreError, usageStoreReadError } from './errors';
import type { SqliteDatabase } from './sqlite-database';

export interface UsageMachineFleetItem extends UsageMachine {
  hasLocalObservedRows: boolean;
  hasPortableRows: boolean;
  lastSeenAt: string;
  newestSessionAt: string | null;
  sessionCount: number;
}

export const MAX_USAGE_MACHINE_FLEET_MACHINES = 100;

export interface QueryUsageMachineFleetInput {
  dbPath: string;
  maximumMachines?: number;
}

export interface QueryUsageMachineFleetResult {
  machines: UsageMachineFleetItem[];
  omittedMachines: number;
  /** Stored rows that failed validation and were skipped from fleet metadata. */
  skipped: number;
}

export interface QueryUsageLocalMachineInput {
  readonly dbPath: string;
}

export interface QueryUsageSyncFleetResult extends QueryUsageMachineFleetResult {
  readonly currentMachine: UsageMachine;
}

interface StoredMachineFleetAggregateRecord {
  has_local_observed_rows: number | null;
  has_portable_rows: number | null;
  label: string | null;
  last_seen_at: string | null;
  machine_count: number;
  newest_session_at: string | null;
  origin_machine_id: string | null;
  session_count: number | null;
  skipped: number;
}

export interface StoredUsageLocalMachineRecord {
  machine_id: string;
  machine_label: string;
  updated_at: string;
}

export const usageStorePath = (home: string) => path.join(home, '.config', 'ai-usage', 'usage-store.sqlite');

export const queryUsageMachineFleetWithDatabase = (
  db: SqliteDatabase,
  input: QueryUsageMachineFleetInput,
): Effect.Effect<QueryUsageMachineFleetResult, UsageStoreError> => {
  const maximumMachines = input.maximumMachines ?? MAX_USAGE_MACHINE_FLEET_MACHINES;
  if (
    !(
      Number.isSafeInteger(maximumMachines) &&
      maximumMachines > 0 &&
      maximumMachines <= MAX_USAGE_MACHINE_FLEET_MACHINES
    )
  ) {
    return Effect.fail(
      usageStoreError(
        'queryUsageMachineFleet',
        input.dbPath,
        `maximumMachines must be an integer from 1 through ${MAX_USAGE_MACHINE_FLEET_MACHINES}.`,
        'invalid-input',
      ),
    );
  }

  return Effect.try({
    try: () => {
      const records = db
        .query(`
            /* queryUsageMachineFleet */
            WITH ranked_rows AS (
              SELECT
                active_date,
                last_seen_at,
                machine_label,
                origin_machine_id,
                row_key,
                source_authority,
                status,
                ROW_NUMBER() OVER (
                  PARTITION BY origin_machine_id
                  ORDER BY last_seen_at DESC, row_key ASC
                ) AS freshness_rank
              FROM usage_rows
              WHERE fleet_metadata_valid = 1
            ),
            machine_rows AS (
              SELECT
                MAX(CASE WHEN source_authority = 'local-observed' THEN 1 ELSE 0 END) AS has_local_observed_rows,
                MAX(CASE WHEN source_authority = 'portable-opaque' THEN 1 ELSE 0 END) AS has_portable_rows,
                COALESCE(
                  MAX(CASE WHEN freshness_rank = 1 THEN NULLIF(machine_label, '') END),
                  origin_machine_id
                ) AS label,
                MAX(last_seen_at) AS last_seen_at,
                MAX(CASE WHEN status = 'active' THEN active_date END) AS newest_session_at,
                origin_machine_id,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS session_count
              FROM ranked_rows
              GROUP BY origin_machine_id
            ),
            ordered_machine_rows AS (
              SELECT machine_rows.*, usage_machine_fleet_order.sort_rank
              FROM machine_rows
              INNER JOIN usage_machine_fleet_order
                ON usage_machine_fleet_order.origin_machine_id = machine_rows.origin_machine_id
                AND usage_machine_fleet_order.machine_label = machine_rows.label
            ),
            bounded_machines AS (
              SELECT *
              FROM ordered_machine_rows
              ORDER BY
                COALESCE(newest_session_at, '') DESC,
                sort_rank ASC,
                origin_machine_id ASC
              LIMIT ?
            ),
            counts AS (
              SELECT
                (SELECT COUNT(*) FROM machine_rows) AS machine_count,
                (SELECT COUNT(*) FROM usage_rows WHERE fleet_metadata_valid = 0) AS skipped
            )
            SELECT
              bounded_machines.has_local_observed_rows,
              bounded_machines.has_portable_rows,
              bounded_machines.label,
              bounded_machines.last_seen_at,
              counts.machine_count,
              bounded_machines.newest_session_at,
              bounded_machines.origin_machine_id,
              bounded_machines.session_count,
              counts.skipped
            FROM counts
            LEFT JOIN bounded_machines ON 1 = 1
            ORDER BY
              COALESCE(bounded_machines.newest_session_at, '') DESC,
              bounded_machines.sort_rank ASC,
              bounded_machines.origin_machine_id ASC
          `)
        .all(maximumMachines) as StoredMachineFleetAggregateRecord[];
      const summary = records[0];
      if (!summary) {
        throw new Error('Machine fleet aggregate returned no summary row');
      }
      const machines: UsageMachineFleetItem[] = [];
      for (const record of records) {
        if (
          record.has_local_observed_rows === null ||
          record.has_portable_rows === null ||
          record.label === null ||
          record.last_seen_at === null ||
          record.origin_machine_id === null ||
          record.session_count === null
        ) {
          continue;
        }
        machines.push({
          hasLocalObservedRows: record.has_local_observed_rows === 1,
          hasPortableRows: record.has_portable_rows === 1,
          id: record.origin_machine_id,
          label: record.label,
          lastSeenAt: record.last_seen_at,
          newestSessionAt: record.newest_session_at,
          sessionCount: record.session_count,
        });
      }

      return {
        machines,
        omittedMachines: summary.machine_count - machines.length,
        skipped: summary.skipped,
      };
    },
    catch: (cause) => usageStoreReadError('queryUsageMachineFleet', input.dbPath, cause),
  });
};

export const queryUsageMachineFleet = (
  input: QueryUsageMachineFleetInput,
): Effect.Effect<QueryUsageMachineFleetResult, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) => queryUsageMachineFleetWithDatabase(db, input));

export const readUsageLocalMachineWithDatabase = (db: SqliteDatabase, dbPath: string): UsageMachine => {
  const record = db
    .query('SELECT machine_id, machine_label, updated_at FROM usage_local_machine WHERE singleton = 1')
    .get() as StoredUsageLocalMachineRecord | null;
  if (!record) {
    throw usageStoreError(
      'queryUsageLocalMachine',
      dbPath,
      'The usage engine has not published its local machine identity.',
      'machine-unavailable',
    );
  }
  if (
    typeof record.machine_id !== 'string' ||
    typeof record.machine_label !== 'string' ||
    typeof record.updated_at !== 'string' ||
    record.machine_id.length === 0 ||
    record.updated_at.length === 0
  ) {
    throw usageStoreError('queryUsageLocalMachine', dbPath, 'The local machine projection is invalid.', 'corrupt');
  }
  const updatedAt = new Date(record.updated_at);
  if (!Number.isFinite(updatedAt.getTime()) || updatedAt.toISOString() !== record.updated_at) {
    throw usageStoreError('queryUsageLocalMachine', dbPath, 'The local machine projection is invalid.', 'corrupt');
  }
  return { id: record.machine_id, label: record.machine_label };
};

export const queryUsageLocalMachine = (
  input: QueryUsageLocalMachineInput,
): Effect.Effect<UsageMachine, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.try({
      try: () => readUsageLocalMachineWithDatabase(db, input.dbPath),
      catch: (cause) => usageStoreReadError('queryUsageLocalMachine', input.dbPath, cause),
    }),
  );

export type LocalProjectionReadPhase = 'local-bundle-after-machine' | 'sync-fleet-after-machine';

let localProjectionReadFaultInjector: ((phase: LocalProjectionReadPhase) => Promise<void> | void) | undefined;

export const setLocalProjectionReadFaultInjectorForTesting = (
  injector: (phase: LocalProjectionReadPhase) => Promise<void> | void,
): (() => void) => {
  if (localProjectionReadFaultInjector) {
    throw new Error('A local projection read fault injector is already installed.');
  }
  localProjectionReadFaultInjector = injector;
  return () => {
    if (localProjectionReadFaultInjector === injector) {
      localProjectionReadFaultInjector = undefined;
    }
  };
};

export const injectLocalProjectionReadPhase = (phase: LocalProjectionReadPhase): Promise<void> =>
  Promise.resolve(localProjectionReadFaultInjector?.(phase));

export const queryUsageSyncFleet = (
  input: QueryUsageMachineFleetInput,
): Effect.Effect<QueryUsageSyncFleetResult, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => db.exec('BEGIN'),
        catch: (cause) => usageStoreReadError('queryUsageSyncFleet', input.dbPath, cause),
      });
      return yield* Effect.gen(function* () {
        const currentMachine = yield* Effect.try({
          try: () => readUsageLocalMachineWithDatabase(db, input.dbPath),
          catch: (cause) => usageStoreReadError('queryUsageSyncFleet', input.dbPath, cause),
        });
        yield* Effect.tryPromise({
          try: () => injectLocalProjectionReadPhase('sync-fleet-after-machine'),
          catch: (cause) => usageStoreReadError('queryUsageSyncFleet', input.dbPath, cause),
        });
        const fleet = yield* queryUsageMachineFleetWithDatabase(db, input);
        yield* Effect.try({
          try: () => db.exec('COMMIT'),
          catch: (cause) => usageStoreReadError('queryUsageSyncFleet', input.dbPath, cause),
        });
        return { currentMachine, ...fleet };
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            try {
              db.exec('ROLLBACK');
            } catch {
              // The read failure remains authoritative.
            }
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
    }),
  );
