import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createUsageMergeBundle,
  deserializeMergeRow,
  isSerializedMergeRow,
  parseUsageMergeBundleValue,
  type SerializedMergeRow,
  toSerializedMergeRow,
  type UsageMergeBundle,
} from '@ai-usage/report-core/merge-bundle';
import { IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE } from '@ai-usage/report-core/report-budgets';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { CollectedUsageRow, UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { Data, Effect } from 'effect';
import { preparePrivateStoreFile } from './private-storage';

export type StoredUsageRowStatus = 'active' | 'superseded' | 'deleted';

export interface ImportResult {
  deleted: number;
  inserted: number;
  superseded: number;
  unchanged: number;
  updated: number;
  warnings: number;
}

export interface ImportLocalRowsInput {
  dbPath: string;
  importedAt?: Date;
  machine: UsageMachine;
  rows: UsageRowWithOptionalSource[];
}

export interface ExportLocalMergeBundleInput {
  dbPath: string;
  generatedAt?: Date;
  machine: UsageMachine;
}

export interface ImportPeerMergeBundleInput {
  bundle: UsageMergeBundle;
  dbPath: string;
  importedAt?: Date;
  localMachineId: string;
}

export interface PreviewPeerMergeBundleInput extends ImportPeerMergeBundleInput {}

export interface PreviewPeerMergeBundleResult extends ImportResult {
  generation: number;
  storeStateToken: string;
}

export interface ConfirmPeerMergeBundleInput extends ImportPeerMergeBundleInput {
  expectedGeneration: number;
  expectedStoreStateToken: string;
}

export interface QueryReportRowsInput {
  dbPath: string;
  harnessKeys?: string[];
  originMachineIds?: string[];
  statuses?: StoredUsageRowStatus[];
}

export interface QueryRowsResult {
  rows: CollectedUsageRow[];
  /** Stored rows that failed validation and were skipped so a single corrupt row cannot block the report. */
  skipped: number;
}

export interface QueryUsageStoreGenerationInput {
  dbPath: string;
}

export type UsageStoreErrorReason =
  | 'invalid-input'
  | 'self-import'
  | 'storage-failure'
  | 'migration-failure'
  | 'preview-stale';

export class UsageStoreError extends Data.TaggedError('UsageStoreError')<{
  readonly operation: string;
  readonly message: string;
  readonly reason?: UsageStoreErrorReason;
  readonly cause?: unknown;
}> {}

export interface UsageStore {
  confirmPeerMergeBundle(input: ConfirmPeerMergeBundleInput): Effect.Effect<ImportResult, UsageStoreError>;
  exportLocalMergeBundle(input: ExportLocalMergeBundleInput): Effect.Effect<UsageMergeBundle, UsageStoreError>;
  importLocalRows(input: ImportLocalRowsInput): Effect.Effect<ImportResult, UsageStoreError>;
  importPeerMergeBundle(input: ImportPeerMergeBundleInput): Effect.Effect<ImportResult, UsageStoreError>;
  previewPeerMergeBundle(
    input: PreviewPeerMergeBundleInput,
  ): Effect.Effect<PreviewPeerMergeBundleResult, UsageStoreError>;
  queryReportRows(input?: QueryReportRowsInput): Effect.Effect<QueryRowsResult, UsageStoreError>;
  queryUsageStoreGeneration(input?: QueryUsageStoreGenerationInput): Effect.Effect<number, UsageStoreError>;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): unknown;
  query(sql: string): SqliteStatement;
}

interface ExistingRow {
  content_hash: string;
  row_key: string;
  status: StoredUsageRowStatus;
}

interface StoredRowRecord {
  row_json: string;
}

interface UsageStoreGenerationRecord {
  value: number;
}

type MergeRowClassification = 'inserted' | 'updated' | 'unchanged' | 'superseded' | 'deleted';

interface ClassifiedMergeRow {
  classification: MergeRowClassification;
  row: SerializedMergeRow;
}

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

    CREATE TABLE IF NOT EXISTS usage_store_metadata (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL CHECK (value >= 0)
    );

    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('generation', 0);
  `);
};

const openUsageStoreDatabase = (dbPath: string): Effect.Effect<SqliteDatabase, UsageStoreError> =>
  Effect.tryPromise({
    try: async () => {
      preparePrivateStoreFile(dbPath);
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath) as SqliteDatabase;
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      migrate(db);
      preparePrivateStoreFile(dbPath);
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

const chunkRows = <T>(rows: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    chunks.push(rows.slice(offset, offset + size));
  }
  return chunks;
};

interface ImportStatements {
  insert: SqliteStatement;
  touch: SqliteStatement;
  update: SqliteStatement;
}

const prepareImportStatements = (db: SqliteDatabase): ImportStatements => ({
  insert: db.query(`
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
  `),
  touch: db.query('UPDATE usage_rows SET last_seen_at = ? WHERE row_key = ?'),
  update: db.query(`
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
  `),
});

const insertMergeRow = (statement: SqliteStatement, row: SerializedMergeRow, now: string) => {
  statement.run(
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

const updateMergeRow = (statement: SqliteStatement, row: SerializedMergeRow, now: string) => {
  statement.run(
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

const touchMergeRow = (statement: SqliteStatement, rowKey: string, now: string) => {
  statement.run(now, rowKey);
};

const loadExistingRows = (db: SqliteDatabase, rows: SerializedMergeRow[]): Map<string, ExistingRow> => {
  const rowKeys = [...new Set(rows.map((row) => row.rowKey))];
  if (rowKeys.length === 0) {
    return new Map();
  }
  const placeholders = rowKeys.map(() => '?').join(', ');
  const existingRows = db
    .query(`SELECT row_key, content_hash, status FROM usage_rows WHERE row_key IN (${placeholders})`)
    .all(...rowKeys) as ExistingRow[];
  return new Map(existingRows.map((row) => [row.row_key, row]));
};

const classifyMergeRows = (db: SqliteDatabase, rows: SerializedMergeRow[]): ClassifiedMergeRow[] => {
  const existingRows = new Map<string, ExistingRow>();
  for (const batch of chunkRows(rows, IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE)) {
    for (const [key, value] of loadExistingRows(db, batch)) {
      existingRows.set(key, value);
    }
  }
  return rows.map((row) => {
    const existing = existingRows.get(row.rowKey);
    let classification: MergeRowClassification;
    if (!existing) {
      classification = 'inserted';
    } else if (existing.content_hash === row.contentHash && existing.status === row.status) {
      classification = 'unchanged';
    } else if (row.status === 'deleted') {
      classification = 'deleted';
    } else if (row.status === 'superseded') {
      classification = 'superseded';
    } else {
      classification = 'updated';
    }
    existingRows.set(row.rowKey, { content_hash: row.contentHash, row_key: row.rowKey, status: row.status });
    return { classification, row };
  });
};

const summarizeClassifications = (classifiedRows: ClassifiedMergeRow[]): ImportResult => {
  const result = emptyImportResult();
  for (const { classification } of classifiedRows) {
    result[classification]++;
  }
  return result;
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
        const statements = prepareImportStatements(db);

        db.exec('BEGIN IMMEDIATE');
        try {
          const classifiedRows = classifyMergeRows(db, rows);
          for (const { classification, row } of classifiedRows) {
            if (classification === 'inserted') {
              insertMergeRow(statements.insert, row, now);
              result.inserted++;
              continue;
            }

            if (classification === 'unchanged') {
              touchMergeRow(statements.touch, row.rowKey, now);
              result.unchanged++;
              continue;
            }

            updateMergeRow(statements.update, row, now);
            result[classification]++;
          }
          if (rows.length > 0) {
            db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
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
  let bundle: UsageMergeBundle;
  try {
    bundle = parseUsageMergeBundleValue(input.bundle);
  } catch (cause) {
    return Effect.fail(
      new UsageStoreError({
        operation: 'importPeerMergeBundle',
        message: `Cannot import an invalid peer merge bundle: ${cause instanceof Error ? cause.message : String(cause)}`,
        reason: 'invalid-input',
        cause,
      }),
    );
  }
  if (bundle.machine.id === input.localMachineId) {
    return Effect.fail(
      new UsageStoreError({
        operation: 'importPeerMergeBundle',
        message: 'Cannot import a peer merge bundle from the local machine.',
        reason: 'self-import',
      }),
    );
  }
  return importMergeRows(input.dbPath, bundle.rows, input.importedAt);
};

const validatePeerBundle = (
  bundleInput: UsageMergeBundle,
  localMachineId: string,
): Effect.Effect<UsageMergeBundle, UsageStoreError> => {
  try {
    const bundle = parseUsageMergeBundleValue(bundleInput);
    if (bundle.machine.id === localMachineId) {
      return Effect.fail(
        new UsageStoreError({
          operation: 'previewPeerMergeBundle',
          message: 'Cannot import a peer merge bundle from the local machine.',
          reason: 'self-import',
        }),
      );
    }
    return Effect.succeed(bundle);
  } catch (cause) {
    return Effect.fail(
      new UsageStoreError({
        operation: 'previewPeerMergeBundle',
        message: `Cannot preview an invalid peer merge bundle: ${cause instanceof Error ? cause.message : String(cause)}`,
        reason: 'invalid-input',
        cause,
      }),
    );
  }
};

const storeIdentity = (dbPath: string, generation: number): string => {
  const identity = [dbPath, `${dbPath}-wal`].map((filePath) => {
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    return stat ? { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size } : null;
  });
  return createHash('sha256').update(JSON.stringify({ generation, identity })).digest('hex');
};

const readStorePreview = async (dbPath: string, rows: SerializedMergeRow[]): Promise<PreviewPeerMergeBundleResult> => {
  if (!fs.existsSync(dbPath)) {
    return {
      ...summarizeClassifications(rows.map((row) => ({ classification: 'inserted', row }))),
      generation: 0,
      storeStateToken: createHash('sha256').update('absent').digest('hex'),
    };
  }
  if (fs.existsSync(`${dbPath}-wal`) && !fs.existsSync(`${dbPath}-shm`)) {
    throw new Error('Usage store preview is unavailable while WAL coordination state is absent.');
  }
  const { Database } = await import('bun:sqlite');
  const db = new Database(dbPath, { readonly: true }) as SqliteDatabase;
  try {
    db.exec('BEGIN');
    const record = db
      .query("SELECT value FROM usage_store_metadata WHERE key = 'generation'")
      .get() as UsageStoreGenerationRecord | null;
    if (!(record && Number.isSafeInteger(record.value) && record.value >= 0)) {
      throw new Error('Usage store generation metadata is missing or invalid.');
    }
    const result = summarizeClassifications(classifyMergeRows(db, rows));
    db.exec('ROLLBACK');
    return { ...result, generation: record.value, storeStateToken: storeIdentity(dbPath, record.value) };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original preview error remains authoritative.
    }
    throw error;
  } finally {
    db.close();
  }
};

export const previewPeerMergeBundle = (
  input: PreviewPeerMergeBundleInput,
): Effect.Effect<PreviewPeerMergeBundleResult, UsageStoreError> =>
  validatePeerBundle(input.bundle, input.localMachineId).pipe(
    Effect.flatMap((bundle) =>
      Effect.tryPromise({
        try: () => readStorePreview(input.dbPath, bundle.rows),
        catch: (cause) => usageStoreError('previewPeerMergeBundle', input.dbPath, cause, 'storage-failure'),
      }),
    ),
  );

export const confirmPeerMergeBundle = (
  input: ConfirmPeerMergeBundleInput,
): Effect.Effect<ImportResult, UsageStoreError> =>
  previewPeerMergeBundle(input).pipe(
    Effect.flatMap((preview) => {
      if (
        preview.generation !== input.expectedGeneration ||
        preview.storeStateToken !== input.expectedStoreStateToken
      ) {
        return Effect.fail(
          new UsageStoreError({
            operation: 'confirmPeerMergeBundle',
            message: 'The usage-store state changed after preview; create a new preview before confirming.',
            reason: 'preview-stale',
          }),
        );
      }
      return importPeerMergeBundle(input);
    }),
  );

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
        const rows: CollectedUsageRow[] = [];
        let skipped = 0;
        for (const record of records) {
          const parsed = JSON.parse(record.row_json) as unknown;
          if (isSerializedMergeRow(parsed)) {
            rows.push(deserializeMergeRow(parsed));
          } else {
            skipped += 1;
          }
        }
        return { rows, skipped };
      },
      catch: (cause) => usageStoreError('queryReportRows', input.dbPath, cause, 'storage-failure'),
    }),
  );

export const queryUsageStoreGeneration = (
  input: QueryUsageStoreGenerationInput,
): Effect.Effect<number, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const record = db
          .query("SELECT value FROM usage_store_metadata WHERE key = 'generation'")
          .get() as UsageStoreGenerationRecord | null;
        if (!(record && Number.isSafeInteger(record.value) && record.value >= 0)) {
          throw new Error('Usage store generation metadata is missing or invalid');
        }
        return record.value;
      },
      catch: (cause) => usageStoreError('queryUsageStoreGeneration', input.dbPath, cause, 'storage-failure'),
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
  previewPeerMergeBundle: (input) => previewPeerMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  confirmPeerMergeBundle: (input) => confirmPeerMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  queryReportRows: (input) => queryReportRows({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryUsageStoreGeneration: (input) =>
    queryUsageStoreGeneration({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
});
