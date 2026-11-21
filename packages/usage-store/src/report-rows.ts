import {
  createUsageMergeBundle,
  deserializeMergeRow,
  isSerializedMergeRow,
  type UsageMergeBundle,
} from '@ai-usage/report-core/merge-bundle';
import { MAX_PORTABLE_USAGE_ROWS } from '@ai-usage/report-core/portable-usage';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { CollectedUsageRow } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { withUsageStoreReader } from './connections';
import { type UsageStoreError, usageStoreError, usageStoreReadError } from './errors';
import {
  injectLocalProjectionReadPhase,
  type QueryUsageMachineFleetResult,
  queryUsageMachineFleetWithDatabase,
  readUsageLocalMachineWithDatabase,
} from './machine-fleet';
import {
  enrichmentContentHash,
  isRtkSavingsContribution,
  RTK_SAVINGS_SCHEMA_VERSION,
  RTK_SAVINGS_SOURCE_ID,
  type RtkSavingsContribution,
  type StoredEnrichmentRecord,
  stripRtkSavings,
} from './rtk-savings';
import type { SqliteDatabase } from './sqlite-database';
import type { StoredRowRecord, StoredSourceAuthority, StoredUsageRowStatus } from './stored-usage-row';
export interface UsageStoreGenerations {
  machineFleetGeneration: number;
  usageStoreGeneration: number;
}

export interface ExportLocalMergeBundleInput {
  dbPath: string;
  generatedAt?: Date;
  machine: UsageMachine;
}

export interface QueryLocalMergeBundleInput {
  readonly dbPath: string;
  readonly generatedAt?: Date;
}

export interface QueryReportRowsInput {
  dbPath: string;
  harnessKeys?: string[];
  originMachineIds?: string[];
  sourceAuthorities?: StoredSourceAuthority[];
  statuses?: StoredUsageRowStatus[];
}

export interface QueryRowsResult {
  rows: CollectedUsageRow[];
  /** Stored rows that failed validation and were skipped so a single corrupt row cannot block the report. */
  skipped: number;
  sourceAuthorities: StoredSourceAuthority[];
}

export interface QueryStoredReportCaptureInput extends QueryReportRowsInput {
  maximumMachines?: number;
}

export interface QueryStoredReportCaptureResult {
  generations: UsageStoreGenerations;
  machineFleet: QueryUsageMachineFleetResult;
  reportRows: QueryRowsResult;
}

export interface QueryUsageStoreGenerationInput {
  dbPath: string;
}

const readReportRows = (db: SqliteDatabase, input: QueryReportRowsInput): QueryRowsResult => {
  const statuses = input.statuses?.length ? input.statuses : (['active'] satisfies StoredUsageRowStatus[]);
  const params: unknown[] = [...statuses];
  let sql = `SELECT row_key, row_json, source_authority FROM usage_rows WHERE status IN (${statuses.map(() => '?').join(', ')})`;

  if (input.originMachineIds?.length) {
    sql += ` AND origin_machine_id IN (${input.originMachineIds.map(() => '?').join(', ')})`;
    params.push(...input.originMachineIds);
  }

  if (input.harnessKeys?.length) {
    sql += ` AND harness_key IN (${input.harnessKeys.map(() => '?').join(', ')})`;
    params.push(...input.harnessKeys);
  }

  if (input.sourceAuthorities?.length) {
    sql += ` AND source_authority IN (${input.sourceAuthorities.map(() => '?').join(', ')})`;
    params.push(...input.sourceAuthorities);
  }

  sql += " ORDER BY COALESCE(active_date, '') DESC, row_key ASC";
  const records = db.query(sql).all(...params) as StoredRowRecord[];
  const rowKeys = records.map(({ row_key }) => row_key);
  const rowKeySet = new Set(rowKeys);
  const enrichments =
    rowKeys.length === 0
      ? []
      : (
          db
            .query(`
                  SELECT row_key, source_id, schema_version, content_hash, payload_json
                  FROM usage_row_enrichments
                  WHERE source_id = ?
                `)
            .all(RTK_SAVINGS_SOURCE_ID) as StoredEnrichmentRecord[]
        ).filter(({ row_key }) => rowKeySet.has(row_key));
  const rtkByRowKey = new Map<string, RtkSavingsContribution>();
  let skipped = 0;
  for (const enrichment of enrichments) {
    let payload: unknown;
    try {
      payload = JSON.parse(enrichment.payload_json) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    if (
      enrichment.schema_version !== RTK_SAVINGS_SCHEMA_VERSION ||
      enrichment.source_id !== RTK_SAVINGS_SOURCE_ID ||
      !isRtkSavingsContribution(payload) ||
      enrichment.content_hash !== enrichmentContentHash(payload)
    ) {
      skipped += 1;
      continue;
    }
    rtkByRowKey.set(enrichment.row_key, payload);
  }
  const rows: CollectedUsageRow[] = [];
  const sourceAuthorities: StoredSourceAuthority[] = [];
  for (const record of records) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.row_json) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    if (isSerializedMergeRow(parsed)) {
      const base = stripRtkSavings(deserializeMergeRow(parsed));
      const contribution = rtkByRowKey.get(record.row_key);
      rows.push(contribution ? { ...base, ...contribution } : base);
      sourceAuthorities.push(record.source_authority);
    } else {
      skipped += 1;
    }
  }
  return { rows, skipped, sourceAuthorities };
};

export const queryReportRows = (input: QueryReportRowsInput): Effect.Effect<QueryRowsResult, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.try({
      try: () => readReportRows(db, input),
      catch: (cause) => usageStoreReadError('queryReportRows', input.dbPath, cause),
    }),
  );

const assertLocalMergeBundleRowBudget = (db: SqliteDatabase, dbPath: string, machineId: string): void => {
  const boundedRows = db
    .query(`
      SELECT row_key
      FROM usage_rows
      WHERE origin_machine_id = ? AND source_authority = 'local-observed' AND status = 'active'
      LIMIT ?
    `)
    .all(machineId, MAX_PORTABLE_USAGE_ROWS + 1);
  if (boundedRows.length <= MAX_PORTABLE_USAGE_ROWS) {
    return;
  }
  const record = db
    .query(`
      SELECT COUNT(*) AS row_count
      FROM usage_rows
      WHERE origin_machine_id = ? AND source_authority = 'local-observed' AND status = 'active'
    `)
    .get(machineId) as { row_count: number } | null;
  const rowCount = record?.row_count;
  if (!(Number.isSafeInteger(rowCount) && Number(rowCount) > MAX_PORTABLE_USAGE_ROWS)) {
    throw usageStoreError('queryLocalMergeBundle', dbPath, 'The local export row count is invalid.', 'corrupt');
  }
  throw usageStoreError(
    'queryLocalMergeBundle',
    dbPath,
    `Usage merge bundle contains ${rowCount} rows; maximum is ${MAX_PORTABLE_USAGE_ROWS}`,
    'invalid-input',
  );
};

export const queryLocalMergeBundle = (
  input: QueryLocalMergeBundleInput,
): Effect.Effect<UsageMergeBundle, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => db.exec('BEGIN'),
        catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
      });
      return yield* Effect.gen(function* () {
        const machine = yield* Effect.try({
          try: () => readUsageLocalMachineWithDatabase(db, input.dbPath),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        yield* Effect.tryPromise({
          try: () => injectLocalProjectionReadPhase('local-bundle-after-machine'),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        yield* Effect.try({
          try: () => assertLocalMergeBundleRowBudget(db, input.dbPath, machine.id),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        const result = yield* Effect.try({
          try: () =>
            readReportRows(db, {
              dbPath: input.dbPath,
              originMachineIds: [machine.id],
              sourceAuthorities: ['local-observed'],
            }),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        const bundle = yield* Effect.try({
          try: () =>
            createUsageMergeBundle({
              machine,
              rows: result.rows,
              ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
            }),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        yield* Effect.try({
          try: () => db.exec('COMMIT'),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        return bundle;
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

export const readUsageStoreGenerations = (db: SqliteDatabase): UsageStoreGenerations => {
  const records = db
    .query(`
      SELECT key, value
      FROM usage_store_metadata
      WHERE key IN ('generation', 'machine_fleet_generation')
    `)
    .all() as Array<{ key: string; value: number }>;
  const metadata = new Map(records.map(({ key, value }) => [key, value]));
  const machineFleetGeneration = metadata.get('machine_fleet_generation');
  const usageStoreGeneration = metadata.get('generation');
  if (
    !(
      Number.isSafeInteger(machineFleetGeneration) &&
      Number(machineFleetGeneration) >= 0 &&
      Number.isSafeInteger(usageStoreGeneration) &&
      Number(usageStoreGeneration) >= 0
    )
  ) {
    throw new Error('Usage store generation metadata is missing or invalid');
  }
  return {
    machineFleetGeneration: Number(machineFleetGeneration),
    usageStoreGeneration: Number(usageStoreGeneration),
  };
};

export const queryUsageStoreGenerations = (
  input: QueryUsageStoreGenerationInput,
): Effect.Effect<UsageStoreGenerations, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.try({
      try: () => readUsageStoreGenerations(db),
      catch: (cause) => usageStoreReadError('queryUsageStoreGenerations', input.dbPath, cause),
    }),
  );

export const queryUsageStoreGeneration = (
  input: QueryUsageStoreGenerationInput,
): Effect.Effect<number, UsageStoreError> =>
  queryUsageStoreGenerations(input).pipe(Effect.map(({ usageStoreGeneration }) => usageStoreGeneration));

export const queryStoredReportCapture = (
  input: QueryStoredReportCaptureInput,
): Effect.Effect<QueryStoredReportCaptureResult, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => db.exec('BEGIN'),
        catch: (cause) => usageStoreReadError('queryStoredReportCapture', input.dbPath, cause),
      });
      return yield* Effect.gen(function* () {
        const generations = yield* Effect.try({
          try: () => readUsageStoreGenerations(db),
          catch: (cause) => usageStoreReadError('queryStoredReportCapture', input.dbPath, cause),
        });
        const reportRows = yield* Effect.try({
          try: () => readReportRows(db, input),
          catch: (cause) => usageStoreReadError('queryStoredReportCapture', input.dbPath, cause),
        });
        const machineFleet = yield* queryUsageMachineFleetWithDatabase(db, {
          dbPath: input.dbPath,
          ...(input.maximumMachines === undefined ? {} : { maximumMachines: input.maximumMachines }),
        });
        yield* Effect.try({
          try: () => db.exec('COMMIT'),
          catch: (cause) => usageStoreReadError('queryStoredReportCapture', input.dbPath, cause),
        });
        return { generations, machineFleet, reportRows };
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            try {
              db.exec('ROLLBACK');
            } catch {
              // The capture failure remains authoritative.
            }
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
    }),
  );

export const exportLocalMergeBundle = (
  input: ExportLocalMergeBundleInput,
): Effect.Effect<UsageMergeBundle, UsageStoreError> =>
  queryReportRows({
    dbPath: input.dbPath,
    originMachineIds: [input.machine.id],
    sourceAuthorities: ['local-observed'],
  }).pipe(
    Effect.map((result) =>
      createUsageMergeBundle({
        machine: input.machine,
        rows: result.rows,
        ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
      }),
    ),
  );
