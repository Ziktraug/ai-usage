import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  isNormalizedDatasetIdentity,
  isNormalizedDatasetItem,
  type NormalizedDatasetItem,
  type NormalizedDatasetKey,
} from '@ai-usage/report-core/datasets';
import {
  createUsageMergeBundle,
  deserializeMergeRow,
  isSerializedMergeRow,
  migrateLegacySerializedMergeRow,
  parseUsageMergeBundleValue,
  type SerializedMergeRow,
  toSerializedMergeRow,
  type UsageMergeBundle,
  usageContentHash,
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
import {
  inspectPrivateStoreForConfirmation,
  type PrivateStoreConfirmationIdentity,
  preparePrivateStoreFile,
  revalidatePrivateStoreForConfirmation,
} from './private-storage';

export type StoredUsageRowStatus = 'active' | 'superseded' | 'deleted';
export type StoredSourceAuthority = 'local-observed' | 'portable-opaque';

export interface ImportResult {
  deleted: number;
  fleetChanged: boolean;
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
  confirmationToken: string;
}

export interface ConfirmPeerMergeBundleInput extends ImportPeerMergeBundleInput {
  confirmationToken: string;
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

export interface QueryStoredReportCaptureInput extends QueryReportRowsInput {
  maximumMachines?: number;
}

export interface QueryStoredReportCaptureResult {
  generations: UsageStoreGenerations;
  machineFleet: QueryUsageMachineFleetResult;
  reportRows: QueryRowsResult;
}

export interface EnrichableUsageRow {
  readonly row: CollectedUsageRow;
  readonly rowKey: string;
}

export interface QueryEnrichableUsageRowsInput {
  dbPath: string;
  originMachineIds?: string[];
  sourceAuthorities?: StoredSourceAuthority[];
}

export interface QueryEnrichableUsageRowsResult {
  rows: EnrichableUsageRow[];
  skipped: number;
}

export interface RtkSavingsContribution {
  readonly rtkCommandCount: number;
  readonly rtkInputTokens: number;
  readonly rtkOutputTokens: number;
  readonly rtkSavedTokens: number;
}

export interface RtkSavingsContributionInput {
  readonly contribution: RtkSavingsContribution;
  readonly rowKey: string;
}

export interface UpsertRtkSavingsContributionsInput {
  readonly contributions: readonly RtkSavingsContributionInput[];
  readonly dbPath: string;
  readonly importedAt?: Date;
}

export interface EnrichmentImportResult {
  inserted: number;
  unchanged: number;
  updated: number;
}

export interface QueryUsageStoreGenerationInput {
  dbPath: string;
}

export interface UsageStoreGenerations {
  machineFleetGeneration: number;
  usageStoreGeneration: number;
}

export interface ImportNormalizedDatasetItemsInput {
  dbPath: string;
  importedAt?: Date;
  items: readonly NormalizedDatasetItem[];
}

export interface NormalizedDatasetImportResult {
  inserted: number;
  unchanged: number;
  updated: number;
}

export interface QueryNormalizedDatasetItemsInput {
  datasetKey?: NormalizedDatasetKey;
  dbPath: string;
  machineId?: string;
  maximumItems?: number;
  sourceId?: NormalizedDatasetItem['sourceId'];
}

export interface QueryNormalizedDatasetItemsResult {
  items: NormalizedDatasetItem[];
  skipped: number;
  truncated: boolean;
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
  importNormalizedDatasetItems(
    input: ImportNormalizedDatasetItemsInput,
  ): Effect.Effect<NormalizedDatasetImportResult, UsageStoreError>;
  importPeerMergeBundle(input: ImportPeerMergeBundleInput): Effect.Effect<ImportResult, UsageStoreError>;
  previewPeerMergeBundle(
    input: PreviewPeerMergeBundleInput,
  ): Effect.Effect<PreviewPeerMergeBundleResult, UsageStoreError>;
  queryEnrichableUsageRows(
    input?: QueryEnrichableUsageRowsInput,
  ): Effect.Effect<QueryEnrichableUsageRowsResult, UsageStoreError>;
  queryNormalizedDatasetItems(
    input?: QueryNormalizedDatasetItemsInput,
  ): Effect.Effect<QueryNormalizedDatasetItemsResult, UsageStoreError>;
  queryReportRows(input?: QueryReportRowsInput): Effect.Effect<QueryRowsResult, UsageStoreError>;
  queryStoredReportCapture(
    input?: QueryStoredReportCaptureInput,
  ): Effect.Effect<QueryStoredReportCaptureResult, UsageStoreError>;
  queryUsageMachineFleet(
    input?: QueryUsageMachineFleetInput,
  ): Effect.Effect<QueryUsageMachineFleetResult, UsageStoreError>;
  queryUsageStoreGeneration(input?: QueryUsageStoreGenerationInput): Effect.Effect<number, UsageStoreError>;
  queryUsageStoreGenerations(
    input?: QueryUsageStoreGenerationInput,
  ): Effect.Effect<UsageStoreGenerations, UsageStoreError>;
  upsertRtkSavingsContributions(
    input: UpsertRtkSavingsContributionsInput,
  ): Effect.Effect<EnrichmentImportResult, UsageStoreError>;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): unknown;
  query(sql: string): SqliteStatement;
}

interface ExistingRow {
  active_date: string | null;
  content_hash: string;
  fleet_metadata_valid: number;
  last_seen_at: string;
  machine_label: string;
  origin_machine_id: string;
  row_key: string;
  source_authority: StoredSourceAuthority;
  status: StoredUsageRowStatus;
}

interface StoredRowRecord {
  row_json: string;
  row_key: string;
  source_authority: StoredSourceAuthority;
}

interface StoredMachineFleetRow {
  active_date: string | null;
  last_seen_at: string;
  origin_machine_id: string;
  row_json: string;
  row_key: string;
  source_authority: StoredSourceAuthority;
  status: StoredUsageRowStatus;
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

interface StoredMachineFleetOrderRecord {
  label: string;
  origin_machine_id: string;
}

interface StoredEnrichmentRecord {
  content_hash: string;
  payload_json: string;
  row_key: string;
  schema_version: number;
  source_id: string;
}

interface UsageStoreGenerationRecord {
  value: number;
}

interface StoredNormalizedDatasetItemRecord {
  dataset_key: string;
  item_key: string;
  machine_id: string;
  payload_json: string;
  schema_version: number;
  source_id: string;
}

type MergeRowClassification = 'inserted' | 'updated' | 'unchanged' | 'superseded' | 'deleted';

interface ClassifiedMergeRow {
  classification: MergeRowClassification;
  fleetProjectionChanged: boolean;
  repairFleetMetadata: boolean;
  reportProjectionChanged: boolean;
  row: SerializedMergeRow;
}

interface PreparedMergeRow {
  contribution?: RtkSavingsContribution;
  row: SerializedMergeRow;
}

interface EnrichmentStatements {
  existing: SqliteStatement;
  insert: SqliteStatement;
  touch: SqliteStatement;
  update: SqliteStatement;
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

const fleetMetadataForStoredRow = (record: StoredMachineFleetRow): { machineLabel: string } | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.row_json) as unknown;
  } catch {
    return;
  }
  const parsedLastSeenAt = new Date(record.last_seen_at);
  if (
    !isSerializedMergeRow(parsed) ||
    parsed.source.machineId !== record.origin_machine_id ||
    parsed.status !== record.status ||
    (parsed.activeDate ?? null) !== record.active_date ||
    !Number.isFinite(parsedLastSeenAt.getTime()) ||
    parsedLastSeenAt.toISOString() !== record.last_seen_at
  ) {
    return;
  }
  return { machineLabel: parsed.source.machineLabel || record.origin_machine_id };
};

/**
 * Rebuilds the durable locale order only after machine membership or the
 * currently presented label changes. This is intentionally O(machines),
 * so the served query can apply the historical localeCompare order before LIMIT
 * without parsing JSON or depending on SQLite's ASCII-only NOCASE collation.
 */
const rebuildUsageMachineFleetOrder = (db: SqliteDatabase): void => {
  const records = [
    ...(db
      .query(`
      WITH ranked_labels AS (
        SELECT
          machine_label,
          origin_machine_id,
          ROW_NUMBER() OVER (
            PARTITION BY origin_machine_id
            ORDER BY last_seen_at DESC, row_key ASC
          ) AS freshness_rank
        FROM usage_rows
        WHERE fleet_metadata_valid = 1
      )
      SELECT
        COALESCE(NULLIF(machine_label, ''), origin_machine_id) AS label,
        origin_machine_id
      FROM ranked_labels
      WHERE freshness_rank = 1
      ORDER BY origin_machine_id
    `)
      .iterate() as IterableIterator<StoredMachineFleetOrderRecord>),
  ];
  records.sort(
    (left, right) =>
      left.label.localeCompare(right.label) || left.origin_machine_id.localeCompare(right.origin_machine_id),
  );
  db.query('DELETE FROM usage_machine_fleet_order').run();
  const insert = db.query(`
    INSERT INTO usage_machine_fleet_order (origin_machine_id, machine_label, sort_rank)
    VALUES (?, ?, ?)
  `);
  for (const [sortRank, record] of records.entries()) {
    insert.run(record.origin_machine_id, record.label, sortRank);
  }
};

const usageMachineFleetOrderChanged = (db: SqliteDatabase, machineIds: readonly string[]): boolean => {
  const uniqueMachineIds = [...new Set(machineIds)];
  for (let offset = 0; offset < uniqueMachineIds.length; offset += IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE) {
    const batch = uniqueMachineIds.slice(offset, offset + IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(', ');
    const currentLabels = db
      .query(`
        WITH ranked_labels AS (
          SELECT
            machine_label,
            origin_machine_id,
            ROW_NUMBER() OVER (
              PARTITION BY origin_machine_id
              ORDER BY last_seen_at DESC, row_key ASC
            ) AS freshness_rank
          FROM usage_rows
          WHERE fleet_metadata_valid = 1
            AND origin_machine_id IN (${placeholders})
        )
        SELECT
          COALESCE(NULLIF(machine_label, ''), origin_machine_id) AS label,
          origin_machine_id
        FROM ranked_labels
        WHERE freshness_rank = 1
      `)
      .all(...batch) as StoredMachineFleetOrderRecord[];
    const storedLabels = db
      .query(`
        SELECT machine_label AS label, origin_machine_id
        FROM usage_machine_fleet_order
        WHERE origin_machine_id IN (${placeholders})
      `)
      .all(...batch) as StoredMachineFleetOrderRecord[];
    const currentByMachine = new Map(currentLabels.map(({ label, origin_machine_id }) => [origin_machine_id, label]));
    const storedByMachine = new Map(storedLabels.map(({ label, origin_machine_id }) => [origin_machine_id, label]));
    if (batch.some((machineId) => currentByMachine.get(machineId) !== storedByMachine.get(machineId))) {
      return true;
    }
  }
  return false;
};

const RTK_SAVINGS_SOURCE_ID = 'rtk.savings';
const RTK_SAVINGS_SCHEMA_VERSION = 1;
const RTK_SAVINGS_KEYS = [
  'rtkCommandCount',
  'rtkInputTokens',
  'rtkOutputTokens',
  'rtkSavedTokens',
] as const satisfies readonly (keyof RtkSavingsContribution)[];

const isRtkSavingsContribution = (value: unknown): value is RtkSavingsContribution => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === RTK_SAVINGS_KEYS.length &&
    RTK_SAVINGS_KEYS.every((key) => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0) &&
    (record.rtkSavedTokens as number) > 0
  );
};

const rtkSavingsFromRow = (row: {
  readonly rtkCommandCount?: number;
  readonly rtkInputTokens?: number;
  readonly rtkOutputTokens?: number;
  readonly rtkSavedTokens?: number;
}): RtkSavingsContribution | undefined => {
  const contribution = {
    rtkCommandCount: row.rtkCommandCount,
    rtkInputTokens: row.rtkInputTokens,
    rtkOutputTokens: row.rtkOutputTokens,
    rtkSavedTokens: row.rtkSavedTokens,
  };
  return isRtkSavingsContribution(contribution) ? contribution : undefined;
};

const stripRtkSavings = <Row extends Partial<RtkSavingsContribution>>(
  row: Row,
): Omit<Row, keyof RtkSavingsContribution> => {
  const {
    rtkCommandCount: _rtkCommandCount,
    rtkInputTokens: _rtkInputTokens,
    rtkOutputTokens: _rtkOutputTokens,
    rtkSavedTokens: _rtkSavedTokens,
    ...base
  } = row;
  return base;
};

const enrichmentContentHash = (value: RtkSavingsContribution): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const prepareMergeRow = (row: SerializedMergeRow): PreparedMergeRow => {
  const contribution = rtkSavingsFromRow(row);
  const hasRtkFields = RTK_SAVINGS_KEYS.some((key) => row[key] !== undefined);
  if (hasRtkFields && !contribution) {
    throw new Error('RTK savings contribution failed strict validation');
  }
  const { contentHash: _contentHash, ...base } = stripRtkSavings(row);
  return {
    ...(contribution === undefined ? {} : { contribution }),
    row: { ...base, contentHash: usageContentHash(base) },
  };
};

const prepareEnrichmentStatements = (db: SqliteDatabase): EnrichmentStatements => ({
  existing: db.query(`
    SELECT row_key, source_id, schema_version, content_hash, payload_json
    FROM usage_row_enrichments
    WHERE row_key = ? AND source_id = ?
  `),
  insert: db.query(`
    INSERT INTO usage_row_enrichments (
      row_key, source_id, schema_version, content_hash, payload_json,
      first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  touch: db.query(`
    UPDATE usage_row_enrichments SET last_seen_at = ? WHERE row_key = ? AND source_id = ?
  `),
  update: db.query(`
    UPDATE usage_row_enrichments
    SET schema_version = ?, content_hash = ?, payload_json = ?, last_seen_at = ?, updated_at = ?
    WHERE row_key = ? AND source_id = ?
  `),
});

const upsertRtkContribution = (
  statements: EnrichmentStatements,
  rowKey: string,
  contribution: RtkSavingsContribution,
  now: string,
): keyof EnrichmentImportResult => {
  const contentHash = enrichmentContentHash(contribution);
  const existing = statements.existing.get(rowKey, RTK_SAVINGS_SOURCE_ID) as StoredEnrichmentRecord | null;
  if (!existing) {
    statements.insert.run(
      rowKey,
      RTK_SAVINGS_SOURCE_ID,
      RTK_SAVINGS_SCHEMA_VERSION,
      contentHash,
      JSON.stringify(contribution),
      now,
      now,
      now,
    );
    return 'inserted';
  }
  if (existing.schema_version === RTK_SAVINGS_SCHEMA_VERSION && existing.content_hash === contentHash) {
    statements.touch.run(now, rowKey, RTK_SAVINGS_SOURCE_ID);
    return 'unchanged';
  }
  statements.update.run(
    RTK_SAVINGS_SCHEMA_VERSION,
    contentHash,
    JSON.stringify(contribution),
    now,
    now,
    rowKey,
    RTK_SAVINGS_SOURCE_ID,
  );
  return 'updated';
};

const migrate = (db: SqliteDatabase): boolean => {
  let schemaChanged =
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'usage_store_metadata'").get() === null;
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
      machine_label TEXT NOT NULL DEFAULT '',
      fleet_metadata_valid INTEGER NOT NULL DEFAULT 0 CHECK (fleet_metadata_valid IN (0, 1)),
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

    CREATE TABLE IF NOT EXISTS usage_machine_fleet_order (
      origin_machine_id TEXT PRIMARY KEY,
      machine_label TEXT NOT NULL,
      sort_rank INTEGER NOT NULL UNIQUE CHECK (sort_rank >= 0)
    );

    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('generation', 0);
    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('machine_fleet_generation', 0);
    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('migration.machine-fleet-metadata-v1', 0);
    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('migration.machine-fleet-order-v1', 0);
    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('migration.rtk-contributions-v1', 0);
    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('migration.merge-row-v3-vcs', 0);

    CREATE TABLE IF NOT EXISTS usage_row_enrichments (
      row_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (row_key, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_usage_row_enrichments_source
      ON usage_row_enrichments(source_id, row_key);

    CREATE TABLE IF NOT EXISTS collected_dataset_items (
      source_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      dataset_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      item_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_id, machine_id, dataset_key, schema_version, item_key)
    );

    CREATE INDEX IF NOT EXISTS idx_collected_dataset_items_query
      ON collected_dataset_items(dataset_key, machine_id, source_id, item_key);

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
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db.query('PRAGMA table_info(usage_rows)').all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === 'source_authority')) {
      schemaChanged = true;
      db.exec(
        "ALTER TABLE usage_rows ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'portable-opaque' CHECK (source_authority IN ('local-observed', 'portable-opaque'))",
      );
    }
    if (!columns.some((column) => column.name === 'machine_label')) {
      schemaChanged = true;
      db.exec("ALTER TABLE usage_rows ADD COLUMN machine_label TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some((column) => column.name === 'fleet_metadata_valid')) {
      schemaChanged = true;
      db.exec(
        'ALTER TABLE usage_rows ADD COLUMN fleet_metadata_valid INTEGER NOT NULL DEFAULT 0 CHECK (fleet_metadata_valid IN (0, 1))',
      );
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_rows_fleet
        ON usage_rows(fleet_metadata_valid, origin_machine_id, last_seen_at DESC, row_key ASC);

      CREATE TRIGGER IF NOT EXISTS usage_rows_invalidate_fleet_metadata_after_insert
      AFTER INSERT ON usage_rows
      BEGIN
        UPDATE usage_rows
        SET machine_label = '', fleet_metadata_valid = 0
        WHERE row_key = NEW.row_key;
      END;

      CREATE TRIGGER IF NOT EXISTS usage_rows_invalidate_fleet_metadata_after_update
      AFTER UPDATE OF origin_machine_id, row_json, status, active_date, last_seen_at, source_authority ON usage_rows
      BEGIN
        UPDATE usage_rows
        SET machine_label = '', fleet_metadata_valid = 0
        WHERE row_key = NEW.row_key;
      END;
    `);
    const mergeRowMigration = db
      .query("SELECT value FROM usage_store_metadata WHERE key = 'migration.merge-row-v3-vcs'")
      .get() as UsageStoreGenerationRecord | null;
    if (mergeRowMigration?.value === 0) {
      schemaChanged = true;
      const migratedAt = new Date().toISOString();
      const legacyRows = db
        .query('SELECT row_key, source_fingerprint, content_hash, row_json, status FROM usage_rows')
        .all() as Array<{
        content_hash: string;
        row_json: string;
        row_key: string;
        source_fingerprint: string;
        status: StoredUsageRowStatus;
      }>;
      const updateLegacyRow = db.query(`
        UPDATE usage_rows
        SET source_fingerprint = ?, content_hash = ?, row_json = ?, updated_at = ?
        WHERE row_key = ?
      `);
      let activeProjectionChanged = false;
      for (const legacy of legacyRows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(legacy.row_json) as unknown;
        } catch {
          continue;
        }
        const migrationResult = migrateLegacySerializedMergeRow(parsed);
        if (
          !migrationResult ||
          migrationResult.legacy.rowKey !== legacy.row_key ||
          migrationResult.legacy.sourceFingerprint !== legacy.source_fingerprint ||
          migrationResult.legacy.contentHash !== legacy.content_hash ||
          migrationResult.legacy.status !== legacy.status
        ) {
          continue;
        }
        const migrated = migrationResult.row;
        updateLegacyRow.run(
          migrated.sourceFingerprint,
          migrated.contentHash,
          JSON.stringify(migrated),
          migratedAt,
          migrated.rowKey,
        );
        activeProjectionChanged ||= migrated.status === 'active';
      }
      if (activeProjectionChanged) {
        db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
      }
      db.query("UPDATE usage_store_metadata SET value = 1 WHERE key = 'migration.merge-row-v3-vcs'").run();
    }
    const migration = db
      .query("SELECT value FROM usage_store_metadata WHERE key = 'migration.rtk-contributions-v1'")
      .get() as UsageStoreGenerationRecord | null;
    if (migration?.value === 0) {
      schemaChanged = true;
      const migratedAt = new Date().toISOString();
      const legacyRows = db.query('SELECT row_key, row_json FROM usage_rows').all() as Array<{
        row_json: string;
        row_key: string;
      }>;
      const insert = db.query(`
        INSERT OR IGNORE INTO usage_row_enrichments (
          row_key, source_id, schema_version, content_hash, payload_json,
          first_seen_at, last_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const legacy of legacyRows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(legacy.row_json) as unknown;
        } catch {
          continue;
        }
        if (!isSerializedMergeRow(parsed)) {
          continue;
        }
        const contribution = rtkSavingsFromRow(parsed);
        if (!contribution) {
          continue;
        }
        insert.run(
          legacy.row_key,
          RTK_SAVINGS_SOURCE_ID,
          RTK_SAVINGS_SCHEMA_VERSION,
          enrichmentContentHash(contribution),
          JSON.stringify(contribution),
          migratedAt,
          migratedAt,
          migratedAt,
        );
      }
      db.query("UPDATE usage_store_metadata SET value = 1 WHERE key = 'migration.rtk-contributions-v1'").run();
    }
    const fleetMetadataMigration = db
      .query("SELECT value FROM usage_store_metadata WHERE key = 'migration.machine-fleet-metadata-v1'")
      .get() as UsageStoreGenerationRecord | null;
    if (fleetMetadataMigration?.value === 0) {
      schemaChanged = true;
      const legacyRows = db
        .query(`
          SELECT active_date, last_seen_at, origin_machine_id, row_json, row_key, source_authority, status
          FROM usage_rows
          ORDER BY origin_machine_id, row_key
        `)
        .iterate() as IterableIterator<StoredMachineFleetRow>;
      const updateFleetMetadata = db.query(`
        UPDATE usage_rows
        SET machine_label = ?, fleet_metadata_valid = ?
        WHERE row_key = ?
      `);
      for (const row of legacyRows) {
        const metadata = fleetMetadataForStoredRow(row);
        updateFleetMetadata.run(metadata?.machineLabel ?? '', metadata ? 1 : 0, row.row_key);
      }
      db.query("UPDATE usage_store_metadata SET value = 1 WHERE key = 'migration.machine-fleet-metadata-v1'").run();
    }
    const fleetOrderMigration = db
      .query("SELECT value FROM usage_store_metadata WHERE key = 'migration.machine-fleet-order-v1'")
      .get() as UsageStoreGenerationRecord | null;
    if (fleetOrderMigration?.value === 0) {
      schemaChanged = true;
      rebuildUsageMachineFleetOrder(db);
      db.query("UPDATE usage_store_metadata SET value = 1 WHERE key = 'migration.machine-fleet-order-v1'").run();
    }
    db.exec('COMMIT');
    return schemaChanged;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
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
      const schemaChanged = migrate(db);
      if (schemaChanged) {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      }
      preparePrivateStoreFile(dbPath);
      return db;
    },
    catch: (cause) => usageStoreError('openUsageStore', dbPath, cause, 'storage-failure'),
  });

interface ConfirmationUsageStoreResource {
  readonly db: SqliteDatabase;
  readonly identity: PrivateStoreConfirmationIdentity;
}

const openConfirmationUsageStoreDatabase = (
  dbPath: string,
): Effect.Effect<ConfirmationUsageStoreResource, UsageStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const identity = inspectPrivateStoreForConfirmation(dbPath);
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { create: false, readwrite: true }) as SqliteDatabase;
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('PRAGMA foreign_keys = ON');
        revalidatePrivateStoreForConfirmation(dbPath, identity);
        return { db, identity };
      } catch (cause) {
        try {
          db.close();
        } catch {
          // The validation or setup failure remains authoritative.
        }
        throw cause;
      }
    },
    catch: (cause) => (cause instanceof UsageStoreError ? cause : previewStaleError(cause)),
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

const withConfirmationUsageStore = <A>(
  dbPath: string,
  use: (resource: ConfirmationUsageStoreResource) => Effect.Effect<A, UsageStoreError>,
): Effect.Effect<A, UsageStoreError> =>
  Effect.acquireUseRelease(openConfirmationUsageStoreDatabase(dbPath), use, ({ db }) =>
    closeUsageStoreDatabase(dbPath, db),
  );

const emptyImportResult = (): ImportResult => ({
  deleted: 0,
  fleetChanged: false,
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
  validateFleetMetadata: SqliteStatement;
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
      origin_machine_id = ?,
      harness_key = ?,
      source_session_id = ?,
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
      updated_at = ?,
      machine_label = '',
      fleet_metadata_valid = 0
    WHERE row_key = ?
  `),
  validateFleetMetadata: db.query(`
    UPDATE usage_rows
    SET machine_label = ?, fleet_metadata_valid = 1
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
    row.source.machineId,
    row.source.harnessKey,
    row.source.sourceSessionId,
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
    .query(`
      SELECT row_key, content_hash, status, source_authority, fleet_metadata_valid
        , active_date, last_seen_at, machine_label, origin_machine_id
      FROM usage_rows
      WHERE row_key IN (${placeholders})
    `)
    .all(...rowKeys) as ExistingRow[];
  return new Map(existingRows.map((row) => [row.row_key, row]));
};

const classifyMergeRows = (
  db: SqliteDatabase,
  rows: SerializedMergeRow[],
  incomingAuthority: StoredSourceAuthority,
  observedAt?: string,
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
    const machineLabel = row.source.machineLabel || row.source.machineId;
    const repairFleetMetadata = existing?.fleet_metadata_valid === 0;
    const fleetProjectionChanged =
      !existing ||
      observedAt === undefined ||
      repairFleetMetadata ||
      existing.active_date !== row.activeDate ||
      existing.last_seen_at !== observedAt ||
      existing.machine_label !== machineLabel ||
      existing.origin_machine_id !== row.source.machineId ||
      existing.source_authority !== incomingAuthority ||
      existing.status !== row.status;
    const reportProjectionChanged =
      existing?.status === 'active'
        ? row.status !== 'active' ||
          existing.content_hash !== row.contentHash ||
          existing.source_authority !== incomingAuthority
        : row.status === 'active';
    existingRows.set(row.rowKey, {
      active_date: row.activeDate,
      content_hash: row.contentHash,
      fleet_metadata_valid: 1,
      last_seen_at: observedAt ?? existing?.last_seen_at ?? '',
      machine_label: machineLabel,
      origin_machine_id: row.source.machineId,
      row_key: row.rowKey,
      source_authority: incomingAuthority,
      status: row.status,
    });
    return { classification, fleetProjectionChanged, repairFleetMetadata, reportProjectionChanged, row };
  });
};

const summarizeClassifications = (
  classifiedRows: Pick<ClassifiedMergeRow, 'classification' | 'fleetProjectionChanged'>[],
): ImportResult => {
  const result = emptyImportResult();
  for (const { classification } of classifiedRows) {
    result[classification]++;
  }
  result.fleetChanged = classifiedRows.some(({ fleetProjectionChanged }) => fleetProjectionChanged);
  return result;
};

const writeClassifiedMergeRows = (
  db: SqliteDatabase,
  preparedRows: PreparedMergeRow[],
  classifiedRows: ClassifiedMergeRow[],
  now: string,
  authority: StoredSourceAuthority,
): ImportResult => {
  const result = summarizeClassifications(classifiedRows);
  const statements = prepareImportStatements(db);
  const enrichmentStatements = prepareEnrichmentStatements(db);
  let enrichmentProjectionChanged = false;
  for (const [index, { classification, repairFleetMetadata, row }] of classifiedRows.entries()) {
    if (classification === 'inserted') {
      insertMergeRow(statements.insert, row, now, authority);
      statements.validateFleetMetadata.run(row.source.machineLabel || row.source.machineId, row.rowKey);
    } else if (classification === 'unchanged') {
      if (repairFleetMetadata) {
        updateMergeRow(statements.update, row, now, authority);
      } else {
        touchMergeRow(statements.touch, row.rowKey, now);
      }
      statements.validateFleetMetadata.run(row.source.machineLabel || row.source.machineId, row.rowKey);
    } else {
      updateMergeRow(statements.update, row, now, authority);
      statements.validateFleetMetadata.run(row.source.machineLabel || row.source.machineId, row.rowKey);
    }
    const contribution = preparedRows[index]?.contribution;
    if (contribution) {
      const enrichmentClassification = upsertRtkContribution(enrichmentStatements, row.rowKey, contribution, now);
      enrichmentProjectionChanged ||= row.status === 'active' && enrichmentClassification !== 'unchanged';
    }
  }
  if (enrichmentProjectionChanged || classifiedRows.some(({ reportProjectionChanged }) => reportProjectionChanged)) {
    db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
  }
  if (result.fleetChanged) {
    if (
      usageMachineFleetOrderChanged(
        db,
        classifiedRows.map(({ row }) => row.source.machineId),
      )
    ) {
      rebuildUsageMachineFleetOrder(db);
    }
    db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'machine_fleet_generation'").run();
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
        const now = importedAt.toISOString();
        const preparedRows = rows.map(prepareMergeRow);

        db.exec('BEGIN IMMEDIATE');
        try {
          const classifiedRows = classifyMergeRows(
            db,
            preparedRows.map(({ row }) => row),
            authority,
            now,
          );
          const result = writeClassifiedMergeRows(db, preparedRows, classifiedRows, now, authority);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
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

type PeerConfirmationOperation = 'confirmPeerMergeBundle' | 'previewPeerMergeBundle';

const validatePeerBundle = (
  bundleInput: UsageMergeBundle,
  localMachineId: string,
  operation: PeerConfirmationOperation,
): Effect.Effect<UsageMergeBundle, UsageStoreError> => {
  try {
    const bundle = parseUsageMergeBundleValue(bundleInput);
    if (bundle.machine.id === localMachineId) {
      return Effect.fail(
        new UsageStoreError({
          operation,
          message: 'Cannot import a peer merge bundle from the local machine.',
          reason: 'self-import',
        }),
      );
    }
    return Effect.succeed(bundle);
  } catch (cause) {
    return Effect.fail(
      new UsageStoreError({
        operation,
        message: `Cannot process an invalid peer merge bundle: ${cause instanceof Error ? cause.message : String(cause)}`,
        reason: 'invalid-input',
        cause,
      }),
    );
  }
};

const CONFIRMATION_TOKEN_VERSION = 'v1';
const CONFIRMATION_TOKEN_PATTERN = /^v1\.[0-9a-f]{64}$/;
const MAX_CONFIRMATION_TOKEN_CHARACTERS = 128;
const canonicalBundleDigest = (bundle: UsageMergeBundle, preparedRows: PreparedMergeRow[]): string => {
  const rows = preparedRows.map(({ contribution, row }) =>
    contribution === undefined ? row : { ...row, ...contribution },
  );
  return createHash('sha256')
    .update(canonicalJson({ ...bundle, rows }))
    .digest('hex');
};

const storeStateFingerprint = (db: SqliteDatabase, rows: SerializedMergeRow[]): string => {
  const metadata = db.query('SELECT key, value FROM usage_store_metadata ORDER BY key').all();
  const schema = db
    .query(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `)
    .all();
  const rowKeys = [...new Set(rows.map(({ rowKey }) => rowKey))].sort();
  const storedRows: unknown[] = [];
  const enrichments: unknown[] = [];
  for (const batch of chunkRows(rowKeys, IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE)) {
    const placeholders = batch.map(() => '?').join(', ');
    const storedBatch = db
      .query(`SELECT * FROM usage_rows WHERE row_key IN (${placeholders}) ORDER BY row_key`)
      .all(...batch);
    for (const storedRow of storedBatch) {
      storedRows.push(storedRow);
    }
    const enrichmentBatch = db
      .query(`
          SELECT *
          FROM usage_row_enrichments
          WHERE row_key IN (${placeholders})
          ORDER BY row_key, source_id
        `)
      .all(...batch);
    for (const enrichment of enrichmentBatch) {
      enrichments.push(enrichment);
    }
  }
  return createHash('sha256').update(canonicalJson({ enrichments, metadata, schema, storedRows })).digest('hex');
};

const readUsageStoreGeneration = (db: SqliteDatabase): number => {
  const record = db
    .query("SELECT value FROM usage_store_metadata WHERE key = 'generation'")
    .get() as UsageStoreGenerationRecord | null;
  if (!(record && Number.isSafeInteger(record.value) && record.value >= 0)) {
    throw new Error('Usage store generation metadata is missing or invalid.');
  }
  return record.value;
};

const confirmationTokenFor = (bundleDigest: string, generation: number, storeFingerprint: string): string => {
  const digest = createHash('sha256')
    .update(canonicalJson({ bundleDigest, generation, storeFingerprint }))
    .digest('hex');
  return `${CONFIRMATION_TOKEN_VERSION}.${digest}`;
};

const isConfirmationToken = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= MAX_CONFIRMATION_TOKEN_CHARACTERS &&
  CONFIRMATION_TOKEN_PATTERN.test(value);

const previewStaleError = (cause?: unknown): UsageStoreError =>
  new UsageStoreError({
    operation: 'confirmPeerMergeBundle',
    message: 'The usage-store state changed after preview; create a new preview before confirming.',
    reason: 'preview-stale',
    ...(cause === undefined ? {} : { cause }),
  });

const readCurrentUsageStoreGeneration = (db: SqliteDatabase): number => {
  try {
    const records = db
      .query(`
        SELECT key, value
        FROM usage_store_metadata
        WHERE key IN (
          'generation',
          'migration.machine-fleet-metadata-v1',
          'migration.machine-fleet-order-v1',
          'migration.rtk-contributions-v1',
          'migration.merge-row-v3-vcs'
        )
      `)
      .all() as Array<{ key: string; value: number }>;
    const metadata = new Map(records.map(({ key, value }) => [key, value]));
    const generation = metadata.get('generation');
    const hasCurrentSchema =
      metadata.get('migration.machine-fleet-metadata-v1') === 1 &&
      metadata.get('migration.machine-fleet-order-v1') === 1 &&
      metadata.get('migration.rtk-contributions-v1') === 1 &&
      metadata.get('migration.merge-row-v3-vcs') === 1;
    if (!(hasCurrentSchema && typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0)) {
      throw new Error('Usage store schema or generation metadata changed after preview.');
    }
    return generation;
  } catch (cause) {
    if (cause instanceof UsageStoreError) {
      throw cause;
    }
    throw previewStaleError(cause);
  }
};

const readStorePreview = (
  db: SqliteDatabase,
  bundle: UsageMergeBundle,
  observedAt: string,
): PreviewPeerMergeBundleResult => {
  const preparedRows = bundle.rows.map(prepareMergeRow);
  const rows = preparedRows.map(({ row }) => row);
  const bundleDigest = canonicalBundleDigest(bundle, preparedRows);
  db.exec('BEGIN');
  try {
    const generation = readUsageStoreGeneration(db);
    const result = summarizeClassifications(classifyMergeRows(db, rows, 'portable-opaque', observedAt));
    const storeFingerprint = storeStateFingerprint(db, rows);
    const confirmationToken = confirmationTokenFor(bundleDigest, generation, storeFingerprint);
    db.exec('ROLLBACK');
    return { ...result, confirmationToken };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original preview error remains authoritative.
    }
    throw error;
  }
};

export const previewPeerMergeBundle = (
  input: PreviewPeerMergeBundleInput,
): Effect.Effect<PreviewPeerMergeBundleResult, UsageStoreError> =>
  validatePeerBundle(input.bundle, input.localMachineId, 'previewPeerMergeBundle').pipe(
    Effect.flatMap((bundle) =>
      withUsageStore(input.dbPath, (db) =>
        Effect.try({
          try: () => readStorePreview(db, bundle, (input.importedAt ?? new Date()).toISOString()),
          catch: (cause) => usageStoreError('previewPeerMergeBundle', input.dbPath, cause, 'storage-failure'),
        }),
      ),
    ),
  );

export const confirmPeerMergeBundle = (
  input: ConfirmPeerMergeBundleInput,
): Effect.Effect<ImportResult, UsageStoreError> => {
  if (!isConfirmationToken(input.confirmationToken)) {
    return Effect.fail(
      new UsageStoreError({
        operation: 'confirmPeerMergeBundle',
        message: 'Usage merge confirmation token is invalid.',
        reason: 'invalid-input',
      }),
    );
  }
  return validatePeerBundle(input.bundle, input.localMachineId, 'confirmPeerMergeBundle').pipe(
    Effect.flatMap((bundle) =>
      withConfirmationUsageStore(input.dbPath, ({ db, identity }) =>
        Effect.try({
          try: () => {
            const preparedRows = bundle.rows.map(prepareMergeRow);
            const rows = preparedRows.map(({ row }) => row);
            const bundleDigest = canonicalBundleDigest(bundle, preparedRows);
            try {
              db.exec('BEGIN IMMEDIATE');
              try {
                revalidatePrivateStoreForConfirmation(input.dbPath, identity);
              } catch (cause) {
                throw previewStaleError(cause);
              }
              const generation = readCurrentUsageStoreGeneration(db);
              const storeFingerprint = storeStateFingerprint(db, rows);
              const confirmationToken = confirmationTokenFor(bundleDigest, generation, storeFingerprint);
              if (confirmationToken !== input.confirmationToken) {
                throw previewStaleError();
              }
              const now = (input.importedAt ?? new Date()).toISOString();
              const classifiedRows = classifyMergeRows(db, rows, 'portable-opaque', now);
              const result = writeClassifiedMergeRows(db, preparedRows, classifiedRows, now, 'portable-opaque');
              db.exec('COMMIT');
              return result;
            } catch (error) {
              try {
                db.exec('ROLLBACK');
              } catch {
                // The validation, stale-state, or write failure remains authoritative.
              }
              throw error;
            }
          },
          catch: (cause) =>
            cause instanceof UsageStoreError
              ? cause
              : usageStoreError('confirmPeerMergeBundle', input.dbPath, cause, 'storage-failure'),
        }),
      ),
    ),
  );
};

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
    const parsed = JSON.parse(record.row_json) as unknown;
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
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => readReportRows(db, input),
      catch: (cause) => usageStoreError('queryReportRows', input.dbPath, cause, 'storage-failure'),
    }),
  );

const queryUsageMachineFleetWithDatabase = (
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
    catch: (cause) => usageStoreError('queryUsageMachineFleet', input.dbPath, cause, 'storage-failure'),
  });
};

export const queryUsageMachineFleet = (
  input: QueryUsageMachineFleetInput,
): Effect.Effect<QueryUsageMachineFleetResult, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) => queryUsageMachineFleetWithDatabase(db, input));

export const queryEnrichableUsageRows = (
  input: QueryEnrichableUsageRowsInput,
): Effect.Effect<QueryEnrichableUsageRowsResult, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const params: unknown[] = [];
        let sql = "SELECT row_key, row_json, source_authority FROM usage_rows WHERE status = 'active'";
        if (input.originMachineIds?.length) {
          sql += ` AND origin_machine_id IN (${input.originMachineIds.map(() => '?').join(', ')})`;
          params.push(...input.originMachineIds);
        }
        if (input.sourceAuthorities?.length) {
          sql += ` AND source_authority IN (${input.sourceAuthorities.map(() => '?').join(', ')})`;
          params.push(...input.sourceAuthorities);
        }
        sql += " ORDER BY COALESCE(active_date, '') DESC, row_key ASC";
        const records = db.query(sql).all(...params) as StoredRowRecord[];
        const rows: EnrichableUsageRow[] = [];
        let skipped = 0;
        for (const record of records) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(record.row_json) as unknown;
          } catch {
            skipped += 1;
            continue;
          }
          if (!isSerializedMergeRow(parsed)) {
            skipped += 1;
            continue;
          }
          rows.push({ row: stripRtkSavings(deserializeMergeRow(parsed)), rowKey: record.row_key });
        }
        return { rows, skipped };
      },
      catch: (cause) => usageStoreError('queryEnrichableUsageRows', input.dbPath, cause, 'storage-failure'),
    }),
  );

export const upsertRtkSavingsContributions = (
  input: UpsertRtkSavingsContributionsInput,
): Effect.Effect<EnrichmentImportResult, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const unique = new Map<string, RtkSavingsContribution>();
        for (const item of input.contributions) {
          if (
            !(typeof item.rowKey === 'string' && item.rowKey.length > 0 && isRtkSavingsContribution(item.contribution))
          ) {
            throw new Error('RTK savings contribution failed strict validation');
          }
          unique.set(item.rowKey, item.contribution);
        }
        const result: EnrichmentImportResult = { inserted: 0, unchanged: 0, updated: 0 };
        const now = (input.importedAt ?? new Date()).toISOString();
        const enrichmentStatements = prepareEnrichmentStatements(db);
        const activeStatement = db.query("SELECT row_key FROM usage_rows WHERE row_key = ? AND status = 'active'");
        let projectionChanged = false;
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const [rowKey, contribution] of unique) {
            const active = activeStatement.get(rowKey) !== null;
            const classification = upsertRtkContribution(enrichmentStatements, rowKey, contribution, now);
            result[classification] += 1;
            projectionChanged ||= active && classification !== 'unchanged';
          }
          if (projectionChanged) {
            db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return result;
      },
      catch: (cause) => usageStoreError('upsertRtkSavingsContributions', input.dbPath, cause, 'storage-failure'),
    }),
  );

const readUsageStoreGenerations = (db: SqliteDatabase): UsageStoreGenerations => {
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
  withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => readUsageStoreGenerations(db),
      catch: (cause) => usageStoreError('queryUsageStoreGenerations', input.dbPath, cause, 'storage-failure'),
    }),
  );

export const queryUsageStoreGeneration = (
  input: QueryUsageStoreGenerationInput,
): Effect.Effect<number, UsageStoreError> =>
  queryUsageStoreGenerations(input).pipe(Effect.map(({ usageStoreGeneration }) => usageStoreGeneration));

export const queryStoredReportCapture = (
  input: QueryStoredReportCaptureInput,
): Effect.Effect<QueryStoredReportCaptureResult, UsageStoreError> =>
  withUsageStore(input.dbPath, (db) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => db.exec('BEGIN'),
        catch: (cause) => usageStoreError('queryStoredReportCapture', input.dbPath, cause, 'storage-failure'),
      });
      return yield* Effect.gen(function* () {
        const generations = yield* Effect.try({
          try: () => readUsageStoreGenerations(db),
          catch: (cause) => usageStoreError('queryStoredReportCapture', input.dbPath, cause, 'storage-failure'),
        });
        const reportRows = yield* Effect.try({
          try: () => readReportRows(db, input),
          catch: (cause) => usageStoreError('queryStoredReportCapture', input.dbPath, cause, 'storage-failure'),
        });
        const machineFleet = yield* queryUsageMachineFleetWithDatabase(db, {
          dbPath: input.dbPath,
          ...(input.maximumMachines === undefined ? {} : { maximumMachines: input.maximumMachines }),
        });
        yield* Effect.try({
          try: () => db.exec('COMMIT'),
          catch: (cause) => usageStoreError('queryStoredReportCapture', input.dbPath, cause, 'storage-failure'),
        });
        return { generations, machineFleet, reportRows };
      }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            try {
              db.exec('ROLLBACK');
            } catch {
              // The capture failure remains authoritative.
            }
          }).pipe(Effect.zipRight(Effect.fail(error))),
        ),
      );
    }),
  );

const maximumNormalizedDatasetItems = 50_000;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const normalizedDatasetContentHash = (item: NormalizedDatasetItem): string =>
  createHash('sha256').update(canonicalJson(item.payload)).digest('hex');

const invalidNormalizedDatasetInput = (operation: string, message: string): UsageStoreError =>
  new UsageStoreError({
    message,
    operation,
    reason: 'invalid-input',
  });

export const importNormalizedDatasetItems = (
  input: ImportNormalizedDatasetItemsInput,
): Effect.Effect<NormalizedDatasetImportResult, UsageStoreError> => {
  if (input.items.length > maximumNormalizedDatasetItems) {
    return Effect.fail(
      invalidNormalizedDatasetInput(
        'importNormalizedDatasetItems',
        `A normalized dataset import cannot exceed ${maximumNormalizedDatasetItems} items.`,
      ),
    );
  }
  if (!input.items.every(isNormalizedDatasetItem)) {
    return Effect.fail(
      invalidNormalizedDatasetInput(
        'importNormalizedDatasetItems',
        'A normalized dataset item failed strict validation.',
      ),
    );
  }

  return withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const result: NormalizedDatasetImportResult = { inserted: 0, unchanged: 0, updated: 0 };
        const observedAt = (input.importedAt ?? new Date()).toISOString();
        const selectExisting = db.query(`
          SELECT content_hash
          FROM collected_dataset_items
          WHERE source_id = ? AND machine_id = ? AND dataset_key = ? AND schema_version = ? AND item_key = ?
        `);
        const insertItem = db.query(`
          INSERT INTO collected_dataset_items (
            source_id, machine_id, dataset_key, schema_version, item_key, content_hash,
            payload_json, first_seen_at, last_seen_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const touchItem = db.query(`
          UPDATE collected_dataset_items
          SET last_seen_at = ?
          WHERE source_id = ? AND machine_id = ? AND dataset_key = ? AND schema_version = ? AND item_key = ?
        `);
        const updateItem = db.query(`
          UPDATE collected_dataset_items
          SET content_hash = ?, payload_json = ?, last_seen_at = ?, updated_at = ?
          WHERE source_id = ? AND machine_id = ? AND dataset_key = ? AND schema_version = ? AND item_key = ?
        `);

        db.exec('BEGIN IMMEDIATE');
        try {
          for (const item of input.items) {
            const identity = [
              item.sourceId,
              item.machineId,
              item.datasetKey,
              item.schemaVersion,
              item.itemKey,
            ] as const;
            const payloadJson = canonicalJson(item.payload);
            const contentHash = normalizedDatasetContentHash(item);
            const existing = selectExisting.get(...identity) as { content_hash: string } | null;
            if (!existing) {
              insertItem.run(...identity, contentHash, payloadJson, observedAt, observedAt, observedAt);
              result.inserted++;
              continue;
            }
            if (existing.content_hash === contentHash) {
              touchItem.run(observedAt, ...identity);
              result.unchanged++;
              continue;
            }
            updateItem.run(contentHash, payloadJson, observedAt, observedAt, ...identity);
            result.updated++;
          }
          if (result.inserted > 0 || result.updated > 0) {
            db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return result;
      },
      catch: (cause) => usageStoreError('importNormalizedDatasetItems', input.dbPath, cause, 'storage-failure'),
    }),
  );
};

export const queryNormalizedDatasetItems = (
  input: QueryNormalizedDatasetItemsInput,
): Effect.Effect<QueryNormalizedDatasetItemsResult, UsageStoreError> => {
  const maximumItems = input.maximumItems ?? maximumNormalizedDatasetItems;
  if (!(Number.isSafeInteger(maximumItems) && maximumItems > 0 && maximumItems <= maximumNormalizedDatasetItems)) {
    return Effect.fail(
      invalidNormalizedDatasetInput(
        'queryNormalizedDatasetItems',
        `maximumItems must be an integer from 1 through ${maximumNormalizedDatasetItems}.`,
      ),
    );
  }

  return withUsageStore(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const filters: string[] = [];
        const params: unknown[] = [];
        if (input.sourceId !== undefined) {
          filters.push('source_id = ?');
          params.push(input.sourceId);
        }
        if (input.machineId !== undefined) {
          filters.push('machine_id = ?');
          params.push(input.machineId);
        }
        if (input.datasetKey !== undefined) {
          filters.push('dataset_key = ?');
          params.push(input.datasetKey);
        }
        const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
        const records = db
          .query(`
            SELECT source_id, machine_id, dataset_key, schema_version, item_key, payload_json
            FROM collected_dataset_items
            ${where}
            ORDER BY dataset_key, machine_id, source_id, item_key
            LIMIT ?
          `)
          .all(...params, maximumItems + 1) as StoredNormalizedDatasetItemRecord[];
        const truncated = records.length > maximumItems;
        const items: NormalizedDatasetItem[] = [];
        let skipped = 0;
        for (const record of records.slice(0, maximumItems)) {
          try {
            if (
              !isNormalizedDatasetIdentity({
                datasetKey: record.dataset_key,
                schemaVersion: record.schema_version,
                sourceId: record.source_id,
              })
            ) {
              skipped++;
              continue;
            }
            const item = {
              datasetKey: record.dataset_key,
              itemKey: record.item_key,
              machineId: record.machine_id,
              payload: JSON.parse(record.payload_json) as unknown,
              schemaVersion: record.schema_version,
              sourceId: record.source_id,
            };
            if (!isNormalizedDatasetItem(item)) {
              skipped++;
              continue;
            }
            items.push(item);
          } catch {
            skipped++;
          }
        }
        return { items, skipped, truncated };
      },
      catch: (cause) => usageStoreError('queryNormalizedDatasetItems', input.dbPath, cause, 'storage-failure'),
    }),
  );
};

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
  importNormalizedDatasetItems: (input) => importNormalizedDatasetItems({ ...input, dbPath: input.dbPath ?? dbPath }),
  importPeerMergeBundle: (input) => importPeerMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  previewPeerMergeBundle: (input) => previewPeerMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  confirmPeerMergeBundle: (input) => confirmPeerMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  queryReportRows: (input) => queryReportRows({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryStoredReportCapture: (input) => queryStoredReportCapture({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryEnrichableUsageRows: (input) => queryEnrichableUsageRows({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryNormalizedDatasetItems: (input) =>
    queryNormalizedDatasetItems({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryUsageMachineFleet: (input) => queryUsageMachineFleet({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryUsageStoreGenerations: (input) =>
    queryUsageStoreGenerations({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryUsageStoreGeneration: (input) =>
    queryUsageStoreGeneration({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  upsertRtkSavingsContributions: (input) => upsertRtkSavingsContributions({ ...input, dbPath: input.dbPath ?? dbPath }),
});
