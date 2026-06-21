import fs from 'node:fs';
import path from 'node:path';
import {
  createUsageMergeBundle,
  deserializeMergeRow,
  parseSerializedMergeRow,
  type SerializedMergeRow,
  toSerializedMergeRow,
  type UsageMergeBundle,
} from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { CollectedUsageRow, UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { Data, Effect } from 'effect';

export type StoredUsageRowStatus = 'active' | 'superseded' | 'deleted';

export interface ImportResult {
  inserted: number;
  updated: number;
  unchanged: number;
  superseded: number;
  deleted: number;
  warnings: number;
}

export interface ImportLocalRowsInput {
  dbPath: string;
  machine: UsageMachine;
  rows: UsageRowWithOptionalSource[];
  importedAt?: Date;
}

export interface ExportLocalMergeBundleInput {
  dbPath: string;
  machine: UsageMachine;
  generatedAt?: Date;
}

export interface ImportPeerMergeBundleInput {
  dbPath: string;
  localMachineId: string;
  bundle: UsageMergeBundle;
  importedAt?: Date;
}

export interface QueryReportRowsInput {
  dbPath: string;
  harnessKeys?: string[];
  originMachineIds?: string[];
  statuses?: StoredUsageRowStatus[];
}

export interface QueryRowsResult {
  rows: CollectedUsageRow[];
}

export type UsageStoreErrorReason = 'invalid-input' | 'self-import' | 'storage-failure' | 'migration-failure';

export class UsageStoreError extends Data.TaggedError('UsageStoreError')<{
  readonly operation: string;
  readonly message: string;
  readonly reason?: UsageStoreErrorReason;
  readonly cause?: unknown;
}> {}

export interface UsageStore {
  importLocalRows(input: ImportLocalRowsInput): Effect.Effect<ImportResult, UsageStoreError>;
  exportLocalMergeBundle(input: ExportLocalMergeBundleInput): Effect.Effect<UsageMergeBundle, UsageStoreError>;
  importPeerMergeBundle(input: ImportPeerMergeBundleInput): Effect.Effect<ImportResult, UsageStoreError>;
  queryReportRows(input?: QueryReportRowsInput): Effect.Effect<QueryRowsResult, UsageStoreError>;
}

type SqliteStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
};

type SqliteDatabase = {
  close(): void;
  exec(sql: string): unknown;
  query(sql: string): SqliteStatement;
};

type ExistingRow = {
  content_hash: string;
  status: StoredUsageRowStatus;
};

type StoredRowRecord = {
  row_json: string;
};

const usageStoreError = (operation: string, dbPath: string, cause: unknown, reason?: UsageStoreErrorReason) =>
  new UsageStoreError({
    operation,
    message: `${operation} ${dbPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    ...(reason === undefined ? {} : { reason }),
    cause,
  });

export const usageStorePath = (home: string) => path.join(home, '.config', 'ai-usage', 'usage-store.sqlite');

const migrate = (db: SqliteDatabase) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_rows (
      origin_machine_id TEXT NOT NULL,
      harness_key TEXT NOT NULL,
      source_session_id TEXT,
      source_fingerprint TEXT NOT NULL,
      row_key TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      row_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted')),
      active_date TEXT,
      project TEXT NOT NULL,
      model TEXT NOT NULL,
      token_total INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- Reserved for future explicit supersession tracking; supersession is currently
      -- carried by the status column (active | superseded | deleted).
      superseded_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_usage_rows_origin_status ON usage_rows(origin_machine_id, status);
    CREATE INDEX IF NOT EXISTS idx_usage_rows_active_date ON usage_rows(active_date);
    CREATE INDEX IF NOT EXISTS idx_usage_rows_project ON usage_rows(project);
    CREATE INDEX IF NOT EXISTS idx_usage_rows_model ON usage_rows(model);
  `);
};

const openUsageStoreDatabase = (dbPath: string): Effect.Effect<SqliteDatabase, UsageStoreError> =>
  Effect.tryPromise({
    try: async () => {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath) as SqliteDatabase;
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      migrate(db);
      return db;
    },
    catch: (cause) => usageStoreError('openUsageStore', dbPath, cause, 'storage-failure'),
  });

const closeUsageStoreDatabase = (dbPath: string, db: SqliteDatabase): Effect.Effect<void> =>
  Effect.try({
    try: () => db.close(),
    catch: (cause) => usageStoreError('closeUsageStore', dbPath, cause, 'storage-failure'),
  }).pipe(Effect.ignore);

const withUsageStore = <A>(
  dbPath: string,
  use: (db: SqliteDatabase) => Effect.Effect<A, UsageStoreError>,
): Effect.Effect<A, UsageStoreError> =>
  Effect.acquireUseRelease(openUsageStoreDatabase(dbPath), use, (db) => closeUsageStoreDatabase(dbPath, db));

const emptyImportResult = (): ImportResult => ({
  deleted: 0,
  inserted: 0,
  superseded: 0,
  unchanged: 0,
  updated: 0,
  warnings: 0,
});

const insertMergeRow = (db: SqliteDatabase, row: SerializedMergeRow, now: string) => {
  db.query(`
    INSERT INTO usage_rows (
      origin_machine_id,
      harness_key,
      source_session_id,
      source_fingerprint,
      row_key,
      content_hash,
      row_json,
      status,
      active_date,
      project,
      model,
      token_total,
      first_seen_at,
      last_seen_at,
      updated_at,
      superseded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.source.machineId,
    row.source.harnessKey,
    row.source.sourceSessionId,
    row.sourceFingerprint,
    row.rowKey,
    row.contentHash,
    JSON.stringify(row),
    row.status,
    row.activeDate,
    row.project,
    row.model,
    row.tokenTotal,
    now,
    now,
    now,
    null,
  );
};

const updateMergeRow = (db: SqliteDatabase, row: SerializedMergeRow, now: string) => {
  db.query(`
    UPDATE usage_rows
    SET
      source_fingerprint = ?,
      content_hash = ?,
      row_json = ?,
      status = ?,
      active_date = ?,
      project = ?,
      model = ?,
      token_total = ?,
      last_seen_at = ?,
      updated_at = ?
    WHERE row_key = ?
  `).run(
    row.sourceFingerprint,
    row.contentHash,
    JSON.stringify(row),
    row.status,
    row.activeDate,
    row.project,
    row.model,
    row.tokenTotal,
    now,
    now,
    row.rowKey,
  );
};

const touchMergeRow = (db: SqliteDatabase, rowKey: string, now: string) => {
  db.query('UPDATE usage_rows SET last_seen_at = ? WHERE row_key = ?').run(now, rowKey);
};

const importMergeRows = (
  dbPath: string,
  rows: SerializedMergeRow[],
  importedAt = new Date(),
): Effect.Effect<ImportResult, UsageStoreError> =>
  withUsageStore(dbPath, (db) =>
    Effect.try({
      try: () => {
        const result = emptyImportResult();
        const now = importedAt.toISOString();
        const selectExisting = db.query('SELECT content_hash, status FROM usage_rows WHERE row_key = ?');

        db.exec('BEGIN IMMEDIATE');
        try {
          for (const row of rows) {
            const existing = selectExisting.get(row.rowKey) as ExistingRow | null;
            if (!existing) {
              insertMergeRow(db, row, now);
              result.inserted++;
              continue;
            }

            if (existing.content_hash === row.contentHash && existing.status === row.status) {
              touchMergeRow(db, row.rowKey, now);
              result.unchanged++;
              continue;
            }

            updateMergeRow(db, row, now);
            if (row.status === 'deleted') result.deleted++;
            else if (row.status === 'superseded') result.superseded++;
            else result.updated++;
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }

        return result;
      },
      catch: (cause) => usageStoreError('importMergeRows', dbPath, cause, 'storage-failure'),
    }),
  );

export const importLocalRows = (input: ImportLocalRowsInput): Effect.Effect<ImportResult, UsageStoreError> =>
  importMergeRows(
    input.dbPath,
    input.rows.map((row) => toSerializedMergeRow(row, input.machine)),
    input.importedAt,
  );

export const importPeerMergeBundle = (
  input: ImportPeerMergeBundleInput,
): Effect.Effect<ImportResult, UsageStoreError> => {
  if (input.bundle.machine.id === input.localMachineId) {
    return Effect.fail(
      new UsageStoreError({
        operation: 'importPeerMergeBundle',
        message: 'Cannot import a peer merge bundle from the local machine.',
        reason: 'self-import',
      }),
    );
  }
  return importMergeRows(input.dbPath, input.bundle.rows, input.importedAt);
};

export const queryReportRows = (input: QueryReportRowsInput): Effect.Effect<QueryRowsResult, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const statuses = input.statuses?.length ? input.statuses : (['active'] satisfies StoredUsageRowStatus[]);
        const params: unknown[] = [...statuses];
        let sql = `SELECT row_json FROM usage_rows WHERE status IN (${statuses.map(() => '?').join(', ')})`;

        if (input.originMachineIds?.length) {
          sql += ` AND origin_machine_id IN (${input.originMachineIds.map(() => '?').join(', ')})`;
          params.push(...input.originMachineIds);
        }

        if (input.harnessKeys?.length) {
          sql += ` AND harness_key IN (${input.harnessKeys.map(() => '?').join(', ')})`;
          params.push(...input.harnessKeys);
        }

        sql += " ORDER BY COALESCE(active_date, '') DESC, row_key ASC";
        const records = db.query(sql).all(...params) as StoredRowRecord[];
        return {
          rows: records.map((record) =>
            deserializeMergeRow(parseSerializedMergeRow(JSON.parse(record.row_json) as unknown)),
          ),
        };
      },
      catch: (cause) => usageStoreError('queryReportRows', input.dbPath, cause, 'storage-failure'),
    }),
  );

export const exportLocalMergeBundle = (
  input: ExportLocalMergeBundleInput,
): Effect.Effect<UsageMergeBundle, UsageStoreError> =>
  queryReportRows({ dbPath: input.dbPath, originMachineIds: [input.machine.id] }).pipe(
    Effect.map((result) =>
      createUsageMergeBundle({
        machine: input.machine,
        rows: result.rows,
        ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
      }),
    ),
  );

export const createUsageStore = (dbPath: string): UsageStore => ({
  exportLocalMergeBundle: (input) => exportLocalMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  importLocalRows: (input) => importLocalRows({ ...input, dbPath: input.dbPath ?? dbPath }),
  importPeerMergeBundle: (input) => importPeerMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  queryReportRows: (input) => queryReportRows({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
});
