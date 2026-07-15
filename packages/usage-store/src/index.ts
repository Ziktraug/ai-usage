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
import {
  type ProviderQuotaObservation,
  parseProviderQuotaObservation,
  providerQuotaObservationFingerprintInput,
} from '@ai-usage/report-core/provider-quota';
import { IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE } from '@ai-usage/report-core/report-budgets';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { CollectedUsageRow, UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { Data, Effect } from 'effect';
import { preparePrivateStoreFile } from './private-storage';

export type StoredUsageRowStatus = 'active' | 'superseded' | 'deleted';
export type StoredSourceAuthority = 'local-observed' | 'portable-opaque';

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
  sourceAuthorities?: StoredSourceAuthority[];
  statuses?: StoredUsageRowStatus[];
}

export interface QueryRowsResult {
  rows: CollectedUsageRow[];
  /** Stored rows that failed validation and were skipped so a single corrupt row cannot block the report. */
  skipped: number;
  sourceAuthorities: StoredSourceAuthority[];
}

export interface QueryUsageStoreGenerationInput {
  dbPath: string;
}

export interface ProviderQuotaCheckpointUpdate {
  cursor: unknown;
  cursorKey: string;
  machineId: string;
  providerKey: string;
  sourceKey: string;
}

export interface ProviderQuotaImportItem {
  observation: ProviderQuotaObservation;
  sourceEventKey?: string;
}

export interface ImportProviderQuotaBatchInput {
  checkpointUpdates: ProviderQuotaCheckpointUpdate[];
  dbPath: string;
  importedAt?: Date;
  items: ProviderQuotaImportItem[];
}

export interface ProviderQuotaImportResult {
  coalesced: number;
  inserted: number;
  unchanged: number;
}

export interface QueryProviderQuotaObservationsInput {
  accountScope?: string | null;
  dbPath: string;
  from: string;
  machineId?: string;
  maximumObservations?: number;
  providerKey?: string;
  to: string;
}

export interface StoredProviderQuotaObservation {
  firstObservedAt: string;
  id: number;
  lastObservedAt: string;
  observation: ProviderQuotaObservation;
}

export interface QueryProviderQuotaObservationsResult {
  observations: StoredProviderQuotaObservation[];
  skipped: number;
  truncated: boolean;
}

export interface QueryProviderQuotaSourceStateInput {
  cursorKey: string;
  dbPath: string;
  machineId: string;
  providerKey: string;
  sourceKey: string;
}

export interface QueryProviderQuotaSourceStatesInput {
  dbPath: string;
  machineId: string;
  providerKey: string;
  sourceKey: string;
}

export interface QueryLatestProviderQuotaObservationsInput {
  dbPath: string;
  machineId?: string;
  providerKey?: string;
}

export interface ProviderQuotaSourceState extends Omit<QueryProviderQuotaSourceStateInput, 'dbPath'> {
  cursor: unknown;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  updatedAt: string;
}

export interface RecordProviderQuotaSourceAttemptInput extends QueryProviderQuotaSourceStateInput {
  attemptedAt?: Date;
  succeeded: boolean;
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
  source_authority: StoredSourceAuthority;
  status: StoredUsageRowStatus;
}

interface StoredRowRecord {
  row_json: string;
  source_authority: StoredSourceAuthority;
}

interface UsageStoreGenerationRecord {
  value: number;
}

type MergeRowClassification = 'inserted' | 'updated' | 'unchanged' | 'superseded' | 'deleted';

interface ClassifiedMergeRow {
  classification: MergeRowClassification;
  reportProjectionChanged: boolean;
  row: SerializedMergeRow;
}

interface ProviderQuotaObservationRecord {
  account_scope: string | null;
  content_hash: string;
  first_observed_at: string;
  id: number;
  last_observed_at: string;
  machine_id: string;
  machine_label: string | null;
  plan: string | null;
  provider_generated_at: string | null;
  provider_key: string;
  provider_label: string;
  source_confidence: ProviderQuotaObservation['source']['confidence'];
  source_key: string;
  source_mode: ProviderQuotaObservation['source']['mode'];
  state: ProviderQuotaObservation['state'];
}

interface ProviderQuotaWindowRecord {
  blocked: number;
  label: string;
  limit_seconds: number | null;
  observation_id: number;
  provider_window_id: string;
  remaining_percent: number | null;
  reset_at: string | null;
  scope: ProviderQuotaObservation['windows'][number]['scope'];
  semantic_group: string | null;
  used_percent: number | null;
}

interface ProviderQuotaSourceStateRecord {
  cursor_json: string | null;
  cursor_key: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  machine_id: string;
  provider_key: string;
  source_key: string;
  updated_at: string;
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
      source_authority TEXT NOT NULL DEFAULT 'portable-opaque' CHECK (source_authority IN ('local-observed', 'portable-opaque')),
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

    CREATE TABLE IF NOT EXISTS provider_quota_observations (
      id INTEGER PRIMARY KEY,
      provider_key TEXT NOT NULL,
      provider_label TEXT NOT NULL,
      account_scope TEXT,
      machine_id TEXT NOT NULL,
      machine_label TEXT,
      source_key TEXT NOT NULL,
      source_mode TEXT NOT NULL CHECK (source_mode IN ('poll', 'push', 'backfill')),
      source_confidence TEXT NOT NULL CHECK (source_confidence IN ('authoritative', 'historical', 'derived')),
      source_event_key TEXT,
      state TEXT NOT NULL,
      plan TEXT,
      provider_generated_at TEXT,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_quota_windows (
      observation_id INTEGER NOT NULL REFERENCES provider_quota_observations(id) ON DELETE CASCADE,
      provider_window_id TEXT NOT NULL,
      label TEXT NOT NULL,
      semantic_group TEXT,
      scope TEXT NOT NULL,
      limit_seconds INTEGER,
      used_percent REAL,
      remaining_percent REAL,
      reset_at TEXT,
      blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
      PRIMARY KEY (observation_id, provider_window_id)
    );

    CREATE TABLE IF NOT EXISTS provider_quota_source_state (
      provider_key TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      cursor_key TEXT NOT NULL,
      cursor_json TEXT,
      last_attempt_at TEXT,
      last_success_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_key, machine_id, source_key, cursor_key)
    );

    CREATE TABLE IF NOT EXISTS provider_quota_source_events (
      provider_key TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_event_key TEXT NOT NULL,
      observation_id INTEGER NOT NULL REFERENCES provider_quota_observations(id) ON DELETE CASCADE,
      PRIMARY KEY (provider_key, machine_id, source_key, source_event_key)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_quota_observed_range
      ON provider_quota_observations(provider_key, machine_id, first_observed_at);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_latest
      ON provider_quota_observations(provider_key, machine_id, account_scope, source_key, first_observed_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_quota_source_event
      ON provider_quota_observations(provider_key, machine_id, source_key, source_event_key)
      WHERE source_event_key IS NOT NULL;
  `);
  const columns = db.query('PRAGMA table_info(usage_rows)').all() as Array<{ name?: unknown }>;
  if (!columns.some((column) => column.name === 'source_authority')) {
    db.exec(
      "ALTER TABLE usage_rows ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'portable-opaque' CHECK (source_authority IN ('local-observed', 'portable-opaque'))",
    );
  }
};

const openUsageStoreDatabase = (dbPath: string): Effect.Effect<SqliteDatabase, UsageStoreError> =>
  Effect.tryPromise({
    try: async () => {
      preparePrivateStoreFile(dbPath);
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath) as SqliteDatabase;
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
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
      source_authority,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  touch: db.query('UPDATE usage_rows SET last_seen_at = ? WHERE row_key = ?'),
  update: db.query(`
    UPDATE usage_rows
    SET
      source_fingerprint = ?,
      source_authority = ?,
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

const insertMergeRow = (
  statement: SqliteStatement,
  row: SerializedMergeRow,
  now: string,
  authority: StoredSourceAuthority,
) => {
  statement.run(
    row.source.machineId,
    row.source.harnessKey,
    row.source.sourceSessionId,
    row.sourceFingerprint,
    authority,
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

const updateMergeRow = (
  statement: SqliteStatement,
  row: SerializedMergeRow,
  now: string,
  authority: StoredSourceAuthority,
) => {
  statement.run(
    row.sourceFingerprint,
    authority,
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
    .query(`SELECT row_key, content_hash, status, source_authority FROM usage_rows WHERE row_key IN (${placeholders})`)
    .all(...rowKeys) as ExistingRow[];
  return new Map(existingRows.map((row) => [row.row_key, row]));
};

const classifyMergeRows = (
  db: SqliteDatabase,
  rows: SerializedMergeRow[],
  incomingAuthority: StoredSourceAuthority,
): ClassifiedMergeRow[] => {
  const existingRows = new Map<string, ExistingRow>();
  for (const batch of chunkRows(rows, IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE)) {
    for (const [key, value] of loadExistingRows(db, batch)) {
      existingRows.set(key, value);
    }
  }
  return rows.map((row) => {
    const existing = existingRows.get(row.rowKey);
    if (existing?.source_authority === 'local-observed' && incomingAuthority === 'portable-opaque') {
      throw new Error('A portable row collides with locally observed usage.');
    }
    let classification: MergeRowClassification;
    if (!existing) {
      classification = 'inserted';
    } else if (
      existing.content_hash === row.contentHash &&
      existing.status === row.status &&
      existing.source_authority === incomingAuthority
    ) {
      classification = 'unchanged';
    } else if (row.status === 'deleted') {
      classification = 'deleted';
    } else if (row.status === 'superseded') {
      classification = 'superseded';
    } else {
      classification = 'updated';
    }
    const reportProjectionChanged =
      existing?.status === 'active'
        ? row.status !== 'active' ||
          existing.content_hash !== row.contentHash ||
          existing.source_authority !== incomingAuthority
        : row.status === 'active';
    existingRows.set(row.rowKey, {
      content_hash: row.contentHash,
      row_key: row.rowKey,
      source_authority: incomingAuthority,
      status: row.status,
    });
    return { classification, reportProjectionChanged, row };
  });
};

const summarizeClassifications = (classifiedRows: Pick<ClassifiedMergeRow, 'classification'>[]): ImportResult => {
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
  authority: StoredSourceAuthority = 'portable-opaque',
): Effect.Effect<ImportResult, UsageStoreError> =>
  withUsageStore(dbPath, (db) =>
    Effect.try({
      try: () => {
        const result = emptyImportResult();
        const now = importedAt.toISOString();
        const statements = prepareImportStatements(db);

        db.exec('BEGIN IMMEDIATE');
        try {
          const classifiedRows = classifyMergeRows(db, rows, authority);
          for (const { classification, row } of classifiedRows) {
            if (classification === 'inserted') {
              insertMergeRow(statements.insert, row, now, authority);
              result.inserted++;
              continue;
            }

            if (classification === 'unchanged') {
              touchMergeRow(statements.touch, row.rowKey, now);
              result.unchanged++;
              continue;
            }

            updateMergeRow(statements.update, row, now, authority);
            result[classification]++;
          }
          if (classifiedRows.some(({ reportProjectionChanged }) => reportProjectionChanged)) {
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
    'local-observed',
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
  return importMergeRows(input.dbPath, bundle.rows, input.importedAt, 'portable-opaque');
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
    const result = summarizeClassifications(classifyMergeRows(db, rows, 'portable-opaque'));
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
        let sql = `SELECT row_json, source_authority FROM usage_rows WHERE status IN (${statuses.map(() => '?').join(', ')})`;

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
        const rows: CollectedUsageRow[] = [];
        const sourceAuthorities: StoredSourceAuthority[] = [];
        let skipped = 0;
        for (const record of records) {
          const parsed = JSON.parse(record.row_json) as unknown;
          if (isSerializedMergeRow(parsed)) {
            rows.push(deserializeMergeRow(parsed));
            sourceAuthorities.push(record.source_authority);
          } else {
            skipped += 1;
          }
        }
        return { rows, skipped, sourceAuthorities };
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

const providerQuotaContentHash = (observation: ProviderQuotaObservation): string =>
  createHash('sha256').update(providerQuotaObservationFingerprintInput(observation)).digest('hex');

const latestQuotaObservation = (
  db: SqliteDatabase,
  observation: ProviderQuotaObservation,
): ProviderQuotaObservationRecord | null =>
  db
    .query(`
      SELECT * FROM provider_quota_observations
      WHERE provider_key = ? AND machine_id = ? AND account_scope IS ? AND source_key = ?
      ORDER BY first_observed_at DESC, id DESC
      LIMIT 1
    `)
    .get(
      observation.providerKey,
      observation.machineId,
      observation.accountScope,
      observation.source.key,
    ) as ProviderQuotaObservationRecord | null;

const insertQuotaObservation = (db: SqliteDatabase, item: ProviderQuotaImportItem, contentHash: string): number => {
  const observation = item.observation;
  const result = db
    .query(`
      INSERT INTO provider_quota_observations (
        provider_key, provider_label, account_scope, machine_id, machine_label,
        source_key, source_mode, source_confidence, source_event_key, state, plan,
        provider_generated_at, first_observed_at, last_observed_at, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `)
    .get(
      observation.providerKey,
      observation.providerLabel,
      observation.accountScope,
      observation.machineId,
      observation.machineLabel,
      observation.source.key,
      observation.source.mode,
      observation.source.confidence,
      item.sourceEventKey ?? null,
      observation.state,
      observation.plan,
      observation.providerGeneratedAt,
      observation.observedAt,
      observation.observedAt,
      contentHash,
    ) as { id: number };
  const insertWindow = db.query(`
    INSERT INTO provider_quota_windows (
      observation_id, provider_window_id, label, semantic_group, scope, limit_seconds,
      used_percent, remaining_percent, reset_at, blocked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const window of observation.windows) {
    insertWindow.run(
      result.id,
      window.id,
      window.label,
      window.group,
      window.scope,
      window.limitSeconds,
      window.usedPercent,
      window.remainingPercent,
      window.resetsAt,
      window.blocked ? 1 : 0,
    );
  }
  return result.id;
};

const insertQuotaSourceEvent = (
  db: SqliteDatabase,
  observation: ProviderQuotaObservation,
  sourceEventKey: string | undefined,
  observationId: number,
): void => {
  if (!sourceEventKey) {
    return;
  }
  db.query(`
    INSERT INTO provider_quota_source_events (
      provider_key, machine_id, source_key, source_event_key, observation_id
    ) VALUES (?, ?, ?, ?, ?)
  `).run(observation.providerKey, observation.machineId, observation.source.key, sourceEventKey, observationId);
};

const upsertQuotaCheckpoint = (
  db: SqliteDatabase,
  checkpoint: ProviderQuotaCheckpointUpdate,
  updatedAt: string,
): void => {
  db.query(`
    INSERT INTO provider_quota_source_state (
      provider_key, machine_id, source_key, cursor_key, cursor_json,
      last_attempt_at, last_success_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
    ON CONFLICT(provider_key, machine_id, source_key, cursor_key) DO UPDATE SET
      cursor_json = excluded.cursor_json,
      updated_at = excluded.updated_at
  `).run(
    checkpoint.providerKey,
    checkpoint.machineId,
    checkpoint.sourceKey,
    checkpoint.cursorKey,
    JSON.stringify(checkpoint.cursor),
    updatedAt,
  );
};

export const importProviderQuotaBatch = (
  input: ImportProviderQuotaBatchInput,
): Effect.Effect<ProviderQuotaImportResult, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const result: ProviderQuotaImportResult = { coalesced: 0, inserted: 0, unchanged: 0 };
        const updatedAt = (input.importedAt ?? new Date()).toISOString();
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const item of input.items) {
            const observation = parseProviderQuotaObservation(item.observation);
            if (!observation) {
              throw new Error('Provider quota observation failed strict validation');
            }
            if (item.sourceEventKey) {
              const existingEvent = db
                .query(`
                  SELECT observation_id FROM provider_quota_source_events
                  WHERE provider_key = ? AND machine_id = ? AND source_key = ? AND source_event_key = ?
                `)
                .get(observation.providerKey, observation.machineId, observation.source.key, item.sourceEventKey);
              if (existingEvent) {
                result.unchanged++;
                continue;
              }
            }
            const contentHash = providerQuotaContentHash(observation);
            const latest = latestQuotaObservation(db, observation);
            const elapsedSinceFirst = latest
              ? Date.parse(observation.observedAt) - Date.parse(latest.first_observed_at)
              : Number.POSITIVE_INFINITY;
            if (latest?.content_hash === contentHash && elapsedSinceFirst < 30 * 60 * 1000) {
              db.query('UPDATE provider_quota_observations SET last_observed_at = ? WHERE id = ?').run(
                observation.observedAt,
                latest.id,
              );
              insertQuotaSourceEvent(db, observation, item.sourceEventKey, latest.id);
              result.coalesced++;
              continue;
            }
            const observationId = insertQuotaObservation(db, { ...item, observation }, contentHash);
            insertQuotaSourceEvent(db, observation, item.sourceEventKey, observationId);
            result.inserted++;
          }
          for (const checkpoint of input.checkpointUpdates) {
            upsertQuotaCheckpoint(db, checkpoint, updatedAt);
          }
          if (result.inserted > 0 || result.coalesced > 0 || input.checkpointUpdates.length > 0) {
            db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return result;
      },
      catch: (cause) => usageStoreError('importProviderQuotaBatch', input.dbPath, cause, 'storage-failure'),
    }),
  );

const quotaObservationFromRecords = (
  record: ProviderQuotaObservationRecord,
  windows: ProviderQuotaWindowRecord[],
): StoredProviderQuotaObservation | null => {
  const observation = parseProviderQuotaObservation({
    accountScope: record.account_scope,
    machineId: record.machine_id,
    machineLabel: record.machine_label,
    observedAt: record.first_observed_at,
    plan: record.plan,
    providerGeneratedAt: record.provider_generated_at,
    providerKey: record.provider_key,
    providerLabel: record.provider_label,
    source: {
      confidence: record.source_confidence,
      key: record.source_key,
      mode: record.source_mode,
    },
    state: record.state,
    windows: windows.map((window) => ({
      blocked: window.blocked === 1,
      group: window.semantic_group,
      id: window.provider_window_id,
      label: window.label,
      limitSeconds: window.limit_seconds,
      remainingPercent: window.remaining_percent,
      resetsAt: window.reset_at,
      scope: window.scope,
      usedPercent: window.used_percent,
    })),
  });
  return observation
    ? {
        firstObservedAt: record.first_observed_at,
        id: record.id,
        lastObservedAt: record.last_observed_at,
        observation,
      }
    : null;
};

const quotaQueryFilters = (input: QueryProviderQuotaObservationsInput): { clauses: string[]; params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.providerKey) {
    clauses.push('provider_key = ?');
    params.push(input.providerKey);
  }
  if (input.machineId) {
    clauses.push('machine_id = ?');
    params.push(input.machineId);
  }
  if (input.accountScope !== undefined) {
    clauses.push('account_scope IS ?');
    params.push(input.accountScope);
  }
  return { clauses, params };
};

export const queryProviderQuotaObservations = (
  input: QueryProviderQuotaObservationsInput,
): Effect.Effect<QueryProviderQuotaObservationsResult, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const maximum = input.maximumObservations ?? 10_000;
        const filters = quotaQueryFilters(input);
        const filterSql = filters.clauses.length ? ` AND ${filters.clauses.join(' AND ')}` : '';
        const rangeRows = db
          .query(`
            SELECT * FROM provider_quota_observations
            WHERE first_observed_at >= ? AND first_observed_at <= ?${filterSql}
            ORDER BY first_observed_at ASC, id ASC
            LIMIT ?
          `)
          .all(input.from, input.to, ...filters.params, maximum + 1) as ProviderQuotaObservationRecord[];
        const beforeRows = db
          .query(`
            SELECT * FROM provider_quota_observations
            WHERE first_observed_at < ?${filterSql}
            ORDER BY first_observed_at DESC, id DESC
          `)
          .all(input.from, ...filters.params) as ProviderQuotaObservationRecord[];
        const anchors = new Map<string, ProviderQuotaObservationRecord>();
        for (const row of beforeRows) {
          const key = `${row.provider_key}|${row.machine_id}|${row.account_scope ?? ''}|${row.source_key}`;
          if (!anchors.has(key)) {
            anchors.set(key, row);
          }
        }
        const rows = [...anchors.values(), ...rangeRows]
          .sort((left, right) => left.first_observed_at.localeCompare(right.first_observed_at) || left.id - right.id)
          .slice(0, maximum);
        if (rows.length === 0) {
          return { observations: [], skipped: 0, truncated: rangeRows.length > maximum };
        }
        const placeholders = rows.map(() => '?').join(', ');
        const windowRows = db
          .query(
            `SELECT * FROM provider_quota_windows WHERE observation_id IN (${placeholders}) ORDER BY provider_window_id`,
          )
          .all(...rows.map((row) => row.id)) as ProviderQuotaWindowRecord[];
        const windowsByObservation = new Map<number, ProviderQuotaWindowRecord[]>();
        for (const window of windowRows) {
          const windows = windowsByObservation.get(window.observation_id) ?? [];
          windows.push(window);
          windowsByObservation.set(window.observation_id, windows);
        }
        const observations: StoredProviderQuotaObservation[] = [];
        let skipped = 0;
        for (const row of rows) {
          const parsed = quotaObservationFromRecords(row, windowsByObservation.get(row.id) ?? []);
          if (parsed) {
            observations.push(parsed);
          } else {
            skipped++;
          }
        }
        return { observations, skipped, truncated: rangeRows.length > maximum };
      },
      catch: (cause) => usageStoreError('queryProviderQuotaObservations', input.dbPath, cause, 'storage-failure'),
    }),
  );

export const queryProviderQuotaSourceState = (
  input: QueryProviderQuotaSourceStateInput,
): Effect.Effect<ProviderQuotaSourceState | null, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const row = db
          .query(`
            SELECT * FROM provider_quota_source_state
            WHERE provider_key = ? AND machine_id = ? AND source_key = ? AND cursor_key = ?
          `)
          .get(
            input.providerKey,
            input.machineId,
            input.sourceKey,
            input.cursorKey,
          ) as ProviderQuotaSourceStateRecord | null;
        if (!row) {
          return null;
        }
        return {
          cursor: row.cursor_json === null ? null : (JSON.parse(row.cursor_json) as unknown),
          cursorKey: row.cursor_key,
          lastAttemptAt: row.last_attempt_at,
          lastSuccessAt: row.last_success_at,
          machineId: row.machine_id,
          providerKey: row.provider_key,
          sourceKey: row.source_key,
          updatedAt: row.updated_at,
        };
      },
      catch: (cause) => usageStoreError('queryProviderQuotaSourceState', input.dbPath, cause, 'storage-failure'),
    }),
  );

export const queryProviderQuotaSourceStates = (
  input: QueryProviderQuotaSourceStatesInput,
): Effect.Effect<ProviderQuotaSourceState[], UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const rows = db
          .query(`
            SELECT * FROM provider_quota_source_state
            WHERE provider_key = ? AND machine_id = ? AND source_key = ?
            ORDER BY cursor_key
          `)
          .all(input.providerKey, input.machineId, input.sourceKey) as ProviderQuotaSourceStateRecord[];
        return rows.map((row) => ({
          cursor: row.cursor_json === null ? null : (JSON.parse(row.cursor_json) as unknown),
          cursorKey: row.cursor_key,
          lastAttemptAt: row.last_attempt_at,
          lastSuccessAt: row.last_success_at,
          machineId: row.machine_id,
          providerKey: row.provider_key,
          sourceKey: row.source_key,
          updatedAt: row.updated_at,
        }));
      },
      catch: (cause) => usageStoreError('queryProviderQuotaSourceStates', input.dbPath, cause, 'storage-failure'),
    }),
  );

export const queryLatestProviderQuotaObservations = (
  input: QueryLatestProviderQuotaObservationsInput,
): Effect.Effect<QueryProviderQuotaObservationsResult, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const filters = quotaQueryFilters({
          dbPath: input.dbPath,
          from: '1970-01-01T00:00:00.000Z',
          ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
          ...(input.providerKey === undefined ? {} : { providerKey: input.providerKey }),
          to: '9999-12-31T23:59:59.999Z',
        });
        const filterSql = filters.clauses.length ? `WHERE ${filters.clauses.join(' AND ')}` : '';
        const candidates = db
          .query(`
            SELECT * FROM provider_quota_observations
            ${filterSql}
            ORDER BY
              CASE source_confidence WHEN 'authoritative' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END,
              first_observed_at DESC,
              id DESC
          `)
          .all(...filters.params) as ProviderQuotaObservationRecord[];
        const latest = new Map<string, ProviderQuotaObservationRecord>();
        for (const row of candidates) {
          const key = `${row.provider_key}|${row.machine_id}|${row.account_scope ?? ''}`;
          if (!latest.has(key)) {
            latest.set(key, row);
          }
        }
        const rows = [...latest.values()];
        if (rows.length === 0) {
          return { observations: [], skipped: 0, truncated: false };
        }
        const windows = db
          .query(`SELECT * FROM provider_quota_windows WHERE observation_id IN (${rows.map(() => '?').join(', ')})`)
          .all(...rows.map((row) => row.id)) as ProviderQuotaWindowRecord[];
        const byObservation = new Map<number, ProviderQuotaWindowRecord[]>();
        for (const window of windows) {
          const list = byObservation.get(window.observation_id) ?? [];
          list.push(window);
          byObservation.set(window.observation_id, list);
        }
        const observations: StoredProviderQuotaObservation[] = [];
        let skipped = 0;
        for (const row of rows) {
          const parsed = quotaObservationFromRecords(row, byObservation.get(row.id) ?? []);
          if (parsed) {
            observations.push(parsed);
          } else {
            skipped++;
          }
        }
        return { observations, skipped, truncated: false };
      },
      catch: (cause) => usageStoreError('queryLatestProviderQuotaObservations', input.dbPath, cause, 'storage-failure'),
    }),
  );

export const recordProviderQuotaSourceAttempt = (
  input: RecordProviderQuotaSourceAttemptInput,
): Effect.Effect<void, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const attemptedAt = (input.attemptedAt ?? new Date()).toISOString();
        db.query(`
          INSERT INTO provider_quota_source_state (
            provider_key, machine_id, source_key, cursor_key, cursor_json,
            last_attempt_at, last_success_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
          ON CONFLICT(provider_key, machine_id, source_key, cursor_key) DO UPDATE SET
            last_attempt_at = excluded.last_attempt_at,
            last_success_at = CASE WHEN ? THEN excluded.last_success_at ELSE provider_quota_source_state.last_success_at END,
            updated_at = excluded.updated_at
        `).run(
          input.providerKey,
          input.machineId,
          input.sourceKey,
          input.cursorKey,
          attemptedAt,
          input.succeeded ? attemptedAt : null,
          attemptedAt,
          input.succeeded ? 1 : 0,
        );
      },
      catch: (cause) => usageStoreError('recordProviderQuotaSourceAttempt', input.dbPath, cause, 'storage-failure'),
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
