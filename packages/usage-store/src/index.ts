// biome-ignore-all lint/style/noExcessiveLinesPerFile: legacy, plan 127
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  createUsageMergeBundle,
  deserializeMergeRow,
  isSerializedMergeRow,
  parseUsageMergeBundleValue,
  type SerializedMergeRow,
  toSerializedMergeRow,
  type UsageMergeBundle,
  usageContentHash,
} from '@ai-usage/report-core/merge-bundle';
import { type MergeConfirmationToken, parseMergeConfirmationToken } from '@ai-usage/report-core/merge-proof';
import { MAX_PORTABLE_USAGE_ROWS } from '@ai-usage/report-core/portable-usage';
import { IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE } from '@ai-usage/report-core/report-budgets';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { CollectedUsageRow, UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { createClaudeDesktopSessionStore } from './claude-desktop-session-store';
import { createCodexWorkStore } from './codex-work-store';
import {
  withConfirmationUsageStore,
  withUsageStorePreview,
  withUsageStoreReader,
  withUsageStoreWriter,
} from './connections';
import { createDelegationStore } from './delegation-store';
import {
  previewStaleError,
  UsageStoreError,
  usageStoreError,
  usageStorePreviewStateError,
  usageStoreReadError,
  usageStoreServedReadError,
} from './errors';
import { createExecutorObservationStore } from './executor-observation-store';
import { rebuildUsageMachineFleetOrder, usageMachineFleetOrderChanged } from './machine-fleet-order';
import type { UsageStoreGenerationRecord } from './migration';
import { revalidatePrivateStoreForConfirmation } from './private-storage';
import { createProviderQuotaStore } from './provider-quota-store';
import type { UsageStoreGenerations } from './report-rows';
import { createReviewAttemptStore } from './review-attempt-store';
import {
  type EnrichmentImportResult,
  enrichmentContentHash,
  isRtkSavingsContribution,
  prepareEnrichmentStatements,
  RTK_SAVINGS_KEYS,
  RTK_SAVINGS_SCHEMA_VERSION,
  RTK_SAVINGS_SOURCE_ID,
  type RtkSavingsContribution,
  rtkSavingsFromRow,
  type StoredEnrichmentRecord,
  stripRtkSavings,
  upsertRtkContribution,
} from './rtk-savings';
import { createServedReportStore } from './served-report-store';
import { createSkillObservationStore } from './skill-observation-store';
import type { SqliteDatabase, SqliteStatement } from './sqlite-database';
import type { StoredRowRecord, StoredSourceAuthority, StoredUsageRowStatus } from './stored-usage-row';
import { createWorkFactStore } from './work-fact-store';
import { createWorkSessionJoinStore } from './work-session-join';
import { createWorkThreadStore } from './work-thread-store';

export type {
  CheckpointUsageStoreInput,
  CheckpointUsageStoreResult,
  InitializeUsageStoreInput,
  QuiesceUsageStoreForShutdownInput,
} from './connections';
export { checkpointUsageStore, initializeUsageStore, quiesceUsageStoreForShutdown } from './connections';

export { USAGE_STORE_SCHEMA_VERSION } from './migration';

export type {
  ImportProviderQuotaBatchInput,
  ProviderQuotaCheckpointUpdate,
  ProviderQuotaImportItem,
  ProviderQuotaImportResult,
  ProviderQuotaSourceState,
  QueryLatestLocalProviderQuotaObservationsInput,
  QueryLatestProviderQuotaObservationsInput,
  QueryProviderQuotaObservationsInput,
  QueryProviderQuotaObservationsResult,
  QueryProviderQuotaSourceStateInput,
  QueryProviderQuotaSourceStatesInput,
  RecordProviderQuotaSourceAttemptInput,
  RetainProviderQuotaObservationsInput,
  RetainProviderQuotaObservationsResult,
  StoredProviderQuotaObservation,
} from './provider-quota-store';
export type { UsageStoreGenerations } from './report-rows';
export type { EnrichmentImportResult, RtkSavingsContribution } from './rtk-savings';
export type {
  CurrentServedLocalProjectSources,
  PublishServedReportRevisionCapture,
  PublishServedReportRevisionContext,
  PublishServedReportRevisionInput,
  PublishServedReportRevisionResult,
  PublishServedRevisionValidationCache,
  QueryServedReportRevisionInput,
  QueryServedReportRevisionLocalSnapshotInput,
  QueryServedRevisionDataInput,
  QueryServedSessionPullRequestLinksInput,
  RetainServedReportRevisionsInput,
  RetainServedReportRevisionsResult,
  ServedLocalProjectSource,
  ServedReportPublicationPhase,
  ServedReportReadPhase,
  ServedReportRevisionBootstrap,
  ServedReportRevisionLocalSnapshot,
  ServedReportRevisionManifest,
  ServedReportRevisionPortableConfig,
  ServedReportRevisionRows,
  ServedReportRevisionSlices,
  ServedReportRevisionSupport,
  ServedSessionPullRequestLink,
  ServedSessionPullRequestLinks,
} from './served-report-store';
export type {
  ImportSkillObservationsInput,
  QuerySkillObservationsInput,
  QuerySkillObservationsResult,
  RetainSkillObservationsInput,
  RetainSkillObservationsResult,
  SkillObservationImportResult,
  StoredSkillObservation,
} from './skill-observation-store';
export type { StoredSourceAuthority, StoredUsageRowStatus } from './stored-usage-row';
export type {
  ImportCheckoutStatusObservationsInput,
  ImportJiraIssueObservationsInput,
  ImportPullRequestObservationsInput,
  LatestCheckoutStatusObservations,
  LatestJiraIssueObservations,
  LatestPullRequestObservations,
  QueryLatestCheckoutStatusObservationsInput,
  QueryLatestJiraIssueObservationsInput,
  QueryLatestPullRequestObservationsInput,
  QueryWorkFactRunStatesInput,
  RecordWorkFactRunInput,
  WorkFactImportResult,
  WorkFactRunState,
  WorkFactRunStates,
} from './work-fact-store';
// The web stale window is 30 days; per-minute heartbeats forced a full served-revision rewrite every cycle.
export const USAGE_ROW_FRESHNESS_HEARTBEAT_MS = 60 * 60 * 1000;

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

/**
 * Explicit, collector-declared retirement (ADR 0089). Only sessions a collector positively observed
 * and classified as "not a usage row of this harness" belong here; a session that is merely absent
 * from a source must never be listed, because source retention pruning must not erase history.
 */
export interface RetireLocalRowsInput {
  readonly dbPath: string;
  readonly harnessKey: string;
  readonly machine: UsageMachine;
  readonly retiredAt?: Date;
  readonly sourceSessionIds: readonly string[];
}

export interface RetireLocalRowsResult {
  /** Listed sessions whose local-observed row was already `deleted`; left untouched. */
  readonly alreadyRetired: number;
  /** Active local-observed rows of this machine and harness marked `deleted` by this call. */
  readonly retired: number;
  /** Matched active rows whose stored JSON failed strict validation; left untouched. */
  readonly skipped: number;
  /** Listed sessions with no active or retired local-observed row of this machine and harness. */
  readonly unmatched: number;
}

export interface UpdateUsageMachineLabelInput {
  readonly dbPath: string;
  readonly machine: UsageMachine;
  readonly updatedAt?: Date;
}

export interface UpdateUsageMachineLabelResult {
  readonly changed: boolean;
  readonly skippedRows: number;
  readonly updatedRows: number;
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

export interface ImportPeerMergeBundleInput {
  bundle: UsageMergeBundle;
  dbPath: string;
  importedAt?: Date;
  localMachineId: string;
}

export interface PreviewPeerMergeBundleInput extends ImportPeerMergeBundleInput {}

export interface PreviewPeerMergeBundleResult extends ImportResult {
  confirmationToken: MergeConfirmationToken;
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

export interface QueryUsageLocalMachineInput {
  readonly dbPath: string;
}

export interface QueryUsageSyncFleetResult extends QueryUsageMachineFleetResult {
  readonly currentMachine: UsageMachine;
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

/**
 * One active stored row as the incremental RTK read sees it. `known` means the caller already holds
 * this row under the same content hash, so its JSON was not read; `invalid` is a stored row that no
 * longer parses or validates (the full read counts it as skipped).
 */
export type EnrichableUsageRowChange =
  | { readonly contentHash: string; readonly rowKey: string; readonly state: 'known' }
  | { readonly contentHash: string; readonly rowKey: string; readonly state: 'invalid' }
  | { readonly contentHash: string; readonly row: CollectedUsageRow; readonly rowKey: string; readonly state: 'read' };

export interface QueryEnrichableUsageRowChangesInput extends QueryEnrichableUsageRowsInput {
  /** Row key to the content hash the caller last read it under. */
  knownContentHashes: ReadonlyMap<string, string>;
}

export interface QueryEnrichableUsageRowChangesResult {
  /** Every active row, in the order `queryEnrichableUsageRows` returns them. */
  entries: EnrichableUsageRowChange[];
}

export interface QueryLocalRowsWatermarkInput {
  dbPath: string;
  harnessKey: string;
  machineId: string;
}

/**
 * What the locally observed rows of one machine and harness looked like at one instant: their count
 * and the latest content rewrite. Every write that changes a row's content or status sets
 * `updated_at`; the freshness touch does not. Equal watermarks therefore mean no row of that harness
 * was rewritten, inserted or removed in between.
 */
export interface LocalRowsWatermark {
  readonly lastUpdatedAt: string | null;
  readonly rows: number;
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

export interface QueryUsageStoreGenerationInput {
  dbPath: string;
}

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

export type { UsageStoreErrorReason } from './errors';
export { UsageStoreError } from './errors';

export interface UsageStore {
  confirmPeerMergeBundle: (input: ConfirmPeerMergeBundleInput) => Effect.Effect<ImportResult, UsageStoreError>;
  exportLocalMergeBundle: (input: ExportLocalMergeBundleInput) => Effect.Effect<UsageMergeBundle, UsageStoreError>;
  importLocalRows: (input: ImportLocalRowsInput) => Effect.Effect<ImportResult, UsageStoreError>;
  importPeerMergeBundle: (input: ImportPeerMergeBundleInput) => Effect.Effect<ImportResult, UsageStoreError>;
  previewPeerMergeBundle: (
    input: PreviewPeerMergeBundleInput,
  ) => Effect.Effect<PreviewPeerMergeBundleResult, UsageStoreError>;
  queryEnrichableUsageRows: (
    input?: QueryEnrichableUsageRowsInput,
  ) => Effect.Effect<QueryEnrichableUsageRowsResult, UsageStoreError>;
  queryReportRows: (input?: QueryReportRowsInput) => Effect.Effect<QueryRowsResult, UsageStoreError>;
  queryStoredReportCapture: (
    input?: QueryStoredReportCaptureInput,
  ) => Effect.Effect<QueryStoredReportCaptureResult, UsageStoreError>;
  queryUsageMachineFleet: (
    input?: QueryUsageMachineFleetInput,
  ) => Effect.Effect<QueryUsageMachineFleetResult, UsageStoreError>;
  queryUsageStoreGeneration: (input?: QueryUsageStoreGenerationInput) => Effect.Effect<number, UsageStoreError>;
  queryUsageStoreGenerations: (
    input?: QueryUsageStoreGenerationInput,
  ) => Effect.Effect<UsageStoreGenerations, UsageStoreError>;
  retireLocalRows: (input: RetireLocalRowsInput) => Effect.Effect<RetireLocalRowsResult, UsageStoreError>;
  updateUsageMachineLabel: (
    input: UpdateUsageMachineLabelInput,
  ) => Effect.Effect<UpdateUsageMachineLabelResult, UsageStoreError>;
  upsertRtkSavingsContributions: (
    input: UpsertRtkSavingsContributionsInput,
  ) => Effect.Effect<EnrichmentImportResult, UsageStoreError>;
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

interface StoredUsageLocalMachineRecord {
  machine_id: string;
  machine_label: string;
  updated_at: string;
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

export const usageStorePath = (home: string) => path.join(home, '.config', 'ai-usage', 'usage-store.sqlite');

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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
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
    const lastSeenAt = Date.parse(existing?.last_seen_at ?? '');
    // Due per clock-hour bucket, not per row age: rows going idle at different minutes then share one
    // heartbeat (one fleet publication) per hour instead of each firing its own.
    const heartbeatDue =
      observedAt !== undefined &&
      (Number.isNaN(lastSeenAt) ||
        Math.floor(Date.parse(observedAt) / USAGE_ROW_FRESHNESS_HEARTBEAT_MS) >
          Math.floor(lastSeenAt / USAGE_ROW_FRESHNESS_HEARTBEAT_MS));
    const fleetProjectionChanged =
      !existing ||
      observedAt === undefined ||
      repairFleetMetadata ||
      existing.active_date !== row.activeDate ||
      heartbeatDue ||
      (classification !== 'unchanged' && existing.last_seen_at !== observedAt) ||
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
      last_seen_at:
        (classification !== 'unchanged' || fleetProjectionChanged ? observedAt : undefined) ??
        existing?.last_seen_at ??
        '',
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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
): ImportResult => {
  const result = summarizeClassifications(classifiedRows);
  const statements = prepareImportStatements(db);
  const enrichmentStatements = prepareEnrichmentStatements(db);
  let enrichmentProjectionChanged = false;
  for (const [
    index,
    { classification, fleetProjectionChanged, repairFleetMetadata, row },
  ] of classifiedRows.entries()) {
    if (classification === 'inserted') {
      insertMergeRow(statements.insert, row, now, authority);
      statements.validateFleetMetadata.run(row.source.machineLabel || row.source.machineId, row.rowKey);
    } else if (classification === 'unchanged') {
      if (repairFleetMetadata) {
        updateMergeRow(statements.update, row, now, authority);
        statements.validateFleetMetadata.run(row.source.machineLabel || row.source.machineId, row.rowKey);
      } else if (fleetProjectionChanged) {
        touchMergeRow(statements.touch, row.rowKey, now);
        statements.validateFleetMetadata.run(row.source.machineLabel || row.source.machineId, row.rowKey);
      }
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
  withUsageStoreWriter(dbPath, (db) =>
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

export const updateUsageMachineLabel = (
  input: UpdateUsageMachineLabelInput,
): Effect.Effect<UpdateUsageMachineLabelResult, UsageStoreError> => {
  if (input.machine.id.length === 0) {
    return Effect.fail(
      usageStoreError('updateUsageMachineLabel', input.dbPath, 'Machine identity must be non-empty.', 'invalid-input'),
    );
  }
  return withUsageStoreWriter(input.dbPath, (db) =>
    Effect.try({
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
      try: () => {
        const updatedAt = (input.updatedAt ?? new Date()).toISOString();
        const update = db.query(`
          UPDATE usage_rows
          SET content_hash = ?, row_json = ?, updated_at = ?
          WHERE row_key = ? AND origin_machine_id = ? AND source_authority = 'local-observed'
        `);
        const validateFleetMetadata = db.query(`
          UPDATE usage_rows
          SET machine_label = ?, fleet_metadata_valid = 1
          WHERE row_key = ?
        `);
        const upsertLocalMachine = db.query(`
          INSERT INTO usage_local_machine (singleton, machine_id, machine_label, updated_at)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            machine_id = excluded.machine_id,
            machine_label = excluded.machine_label,
            updated_at = excluded.updated_at
        `);
        let localMachineChanged = false;
        let skippedRows = 0;
        let updatedRows = 0;
        db.exec('BEGIN IMMEDIATE');
        try {
          const previousLocalMachine = db
            .query('SELECT machine_id, machine_label, updated_at FROM usage_local_machine WHERE singleton = 1')
            .get() as StoredUsageLocalMachineRecord | null;
          localMachineChanged =
            previousLocalMachine?.machine_id !== input.machine.id ||
            previousLocalMachine?.machine_label !== input.machine.label;
          if (localMachineChanged) {
            upsertLocalMachine.run(input.machine.id, input.machine.label, updatedAt);
          }
          const records = db
            .query(`
              SELECT fleet_metadata_valid, machine_label, row_json, row_key
              FROM usage_rows
              WHERE origin_machine_id = ? AND source_authority = 'local-observed'
              ORDER BY row_key
            `)
            .all(input.machine.id) as Array<{
            fleet_metadata_valid: number;
            machine_label: string;
            row_json: string;
            row_key: string;
          }>;
          for (const record of records) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(record.row_json) as unknown;
            } catch {
              skippedRows++;
              continue;
            }
            if (!(isSerializedMergeRow(parsed) && parsed.source.machineId === input.machine.id)) {
              skippedRows++;
              continue;
            }
            if (
              parsed.source.machineLabel === input.machine.label &&
              record.machine_label === input.machine.label &&
              Number(record.fleet_metadata_valid) === 1
            ) {
              continue;
            }
            const { contentHash: _contentHash, ...storedContent } = parsed;
            const content = {
              ...storedContent,
              source: { ...parsed.source, machineLabel: input.machine.label },
            };
            const relabeled = { ...content, contentHash: usageContentHash(content) };
            if (!isSerializedMergeRow(relabeled)) {
              throw new Error('Relabeled usage row failed strict validation.');
            }
            update.run(relabeled.contentHash, JSON.stringify(relabeled), updatedAt, record.row_key, input.machine.id);
            validateFleetMetadata.run(input.machine.label, record.row_key);
            updatedRows++;
          }
          if (updatedRows > 0) {
            rebuildUsageMachineFleetOrder(db);
          }
          if (updatedRows > 0 || localMachineChanged) {
            db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
            db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'machine_fleet_generation'").run();
          }
          db.exec('COMMIT');
        } catch (cause) {
          db.exec('ROLLBACK');
          throw cause;
        }
        return { changed: updatedRows > 0 || localMachineChanged, skippedRows, updatedRows };
      },
      catch: (cause) =>
        cause instanceof UsageStoreError
          ? cause
          : usageStoreError('updateUsageMachineLabel', input.dbPath, cause, 'storage-failure'),
    }),
  );
};

interface StoredRetirementCandidate {
  row_json: string;
  row_key: string;
  source_session_id: string;
  status: StoredUsageRowStatus;
}

const emptyRetireLocalRowsResult = (): RetireLocalRowsResult => ({
  alreadyRetired: 0,
  retired: 0,
  skipped: 0,
  unmatched: 0,
});

/**
 * Marks `deleted` every active, local-observed row of one origin machine and harness whose
 * `source_session_id` is listed. One IMMEDIATE transaction; idempotent; portable rows, other machines
 * and other harnesses are never touched; superseded rows are left alone and count as unmatched.
 * The stored JSON is rewritten with `status: 'deleted'` and a recomputed content hash so the row keeps
 * passing the strict re-validation every report read applies. A later collection that emits the
 * session again as a normal row reactivates it through the ordinary import path.
 */
export const retireLocalRows = (input: RetireLocalRowsInput): Effect.Effect<RetireLocalRowsResult, UsageStoreError> => {
  if (input.machine.id.length === 0 || input.harnessKey.length === 0) {
    return Effect.fail(
      usageStoreError(
        'retireLocalRows',
        input.dbPath,
        'Machine identity and harness key must be non-empty.',
        'invalid-input',
      ),
    );
  }
  const sourceSessionIds = [...new Set(input.sourceSessionIds)];
  if (sourceSessionIds.some((sourceSessionId) => sourceSessionId.length === 0)) {
    return Effect.fail(
      usageStoreError('retireLocalRows', input.dbPath, 'Source session ids must be non-empty.', 'invalid-input'),
    );
  }
  if (sourceSessionIds.length === 0) {
    return Effect.succeed(emptyRetireLocalRowsResult());
  }
  return withUsageStoreWriter(input.dbPath, (db) =>
    Effect.try({
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
      try: () => {
        const retiredAt = (input.retiredAt ?? new Date()).toISOString();
        const update = db.query(`
          UPDATE usage_rows
          SET content_hash = ?, row_json = ?, status = 'deleted', last_seen_at = ?, updated_at = ?
          WHERE row_key = ? AND status = 'active' AND source_authority = 'local-observed'
        `);
        // The update trigger clears fleet metadata on every row rewrite; re-validate it like the import does.
        const validateFleetMetadata = db.query(`
          UPDATE usage_rows
          SET machine_label = ?, fleet_metadata_valid = 1
          WHERE row_key = ?
        `);
        const result = { ...emptyRetireLocalRowsResult() };
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const batch of chunkRows(sourceSessionIds, IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE)) {
            const placeholders = batch.map(() => '?').join(', ');
            const candidates = db
              .query(`
                SELECT row_json, row_key, source_session_id, status
                FROM usage_rows
                WHERE origin_machine_id = ?
                  AND harness_key = ?
                  AND source_authority = 'local-observed'
                  AND status IN ('active', 'deleted')
                  AND source_session_id IN (${placeholders})
                ORDER BY row_key
              `)
              .all(input.machine.id, input.harnessKey, ...batch) as StoredRetirementCandidate[];
            const matched = new Set<string>();
            for (const candidate of candidates) {
              matched.add(candidate.source_session_id);
              if (candidate.status === 'deleted') {
                result.alreadyRetired++;
                continue;
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(candidate.row_json) as unknown;
              } catch {
                result.skipped++;
                continue;
              }
              if (
                !(
                  isSerializedMergeRow(parsed) &&
                  parsed.status === 'active' &&
                  parsed.source.machineId === input.machine.id &&
                  parsed.source.harnessKey === input.harnessKey
                )
              ) {
                result.skipped++;
                continue;
              }
              const { contentHash: _contentHash, ...content } = parsed;
              const retiredContent = { ...content, status: 'deleted' as const };
              const retired = { ...retiredContent, contentHash: usageContentHash(retiredContent) };
              if (!isSerializedMergeRow(retired)) {
                throw new Error('Retired usage row failed strict validation.');
              }
              update.run(retired.contentHash, JSON.stringify(retired), retiredAt, retiredAt, candidate.row_key);
              validateFleetMetadata.run(retired.source.machineLabel || retired.source.machineId, candidate.row_key);
              result.retired++;
            }
            result.unmatched += batch.length - matched.size;
          }
          if (result.retired > 0) {
            if (usageMachineFleetOrderChanged(db, [input.machine.id])) {
              rebuildUsageMachineFleetOrder(db);
            }
            db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
            db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'machine_fleet_generation'").run();
          }
          db.exec('COMMIT');
        } catch (cause) {
          db.exec('ROLLBACK');
          throw cause;
        }
        return result;
      },
      catch: (cause) =>
        cause instanceof UsageStoreError
          ? cause
          : usageStoreError('retireLocalRows', input.dbPath, cause, 'storage-failure'),
    }),
  );
};

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

const confirmationTokenFor = (
  bundleDigest: string,
  generation: number,
  storeFingerprint: string,
): MergeConfirmationToken => {
  const digest = createHash('sha256')
    .update(canonicalJson({ bundleDigest, generation, storeFingerprint }))
    .digest('hex');
  return parseMergeConfirmationToken(`v1.${digest}`);
};

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
      withUsageStorePreview(input.dbPath, (db) =>
        Effect.try({
          try: () => readStorePreview(db, bundle, (input.importedAt ?? new Date()).toISOString()),
          catch: (cause) => usageStorePreviewStateError('previewPeerMergeBundle', input.dbPath, cause),
        }),
      ),
    ),
  );

export const confirmPeerMergeBundle = (
  input: ConfirmPeerMergeBundleInput,
): Effect.Effect<ImportResult, UsageStoreError> => {
  let expectedConfirmationToken: MergeConfirmationToken;
  try {
    expectedConfirmationToken = parseMergeConfirmationToken(input.confirmationToken);
  } catch {
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
              if (confirmationToken !== expectedConfirmationToken) {
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
    catch: (cause) => usageStoreReadError('queryUsageMachineFleet', input.dbPath, cause),
  });
};

export const queryUsageMachineFleet = (
  input: QueryUsageMachineFleetInput,
): Effect.Effect<QueryUsageMachineFleetResult, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) => queryUsageMachineFleetWithDatabase(db, input));

const readUsageLocalMachineWithDatabase = (db: SqliteDatabase, dbPath: string): UsageMachine => {
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

const injectLocalProjectionReadPhase = (phase: LocalProjectionReadPhase): Promise<void> =>
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

const ENRICHABLE_ROWS_ORDER = "ORDER BY COALESCE(active_date, '') DESC, row_key ASC";

const enrichableUsageRowsFilter = (input: QueryEnrichableUsageRowsInput): { params: unknown[]; where: string } => {
  const params: unknown[] = [];
  let where = "status = 'active'";
  if (input.originMachineIds?.length) {
    where += ` AND origin_machine_id IN (${input.originMachineIds.map(() => '?').join(', ')})`;
    params.push(...input.originMachineIds);
  }
  if (input.sourceAuthorities?.length) {
    where += ` AND source_authority IN (${input.sourceAuthorities.map(() => '?').join(', ')})`;
    params.push(...input.sourceAuthorities);
  }
  return { params, where };
};

/**
 * The incremental form of `queryEnrichableUsageRows`: the same rows in the same order, but the
 * stored JSON is read, parsed and validated only for rows the caller does not already hold under
 * the same content hash. The content hash covers the whole stored row, so a row whose hash is
 * unchanged would parse to what the caller kept.
 */
export const queryEnrichableUsageRowChanges = (
  input: QueryEnrichableUsageRowChangesInput,
): Effect.Effect<QueryEnrichableUsageRowChangesResult, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.try({
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
      try: () => {
        const { params, where } = enrichableUsageRowsFilter(input);
        const listed = db
          .query(`SELECT row_key, content_hash FROM usage_rows WHERE ${where} ${ENRICHABLE_ROWS_ORDER}`)
          .all(...params) as Array<{ content_hash: string; row_key: string }>;
        const unknownRowKeys = listed
          .filter((record) => input.knownContentHashes.get(record.row_key) !== record.content_hash)
          .map((record) => record.row_key);
        const read = new Map<string, EnrichableUsageRowChange>();
        for (const batch of chunkRows(unknownRowKeys, IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE)) {
          const records = db
            .query(
              `SELECT row_key, content_hash, row_json FROM usage_rows
               WHERE ${where} AND row_key IN (${batch.map(() => '?').join(', ')})`,
            )
            .all(...params, ...batch) as Array<{ content_hash: string; row_json: string; row_key: string }>;
          for (const record of records) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(record.row_json) as unknown;
            } catch {
              parsed = undefined;
            }
            read.set(
              record.row_key,
              isSerializedMergeRow(parsed)
                ? {
                    contentHash: record.content_hash,
                    row: stripRtkSavings(deserializeMergeRow(parsed)),
                    rowKey: record.row_key,
                    state: 'read',
                  }
                : { contentHash: record.content_hash, rowKey: record.row_key, state: 'invalid' },
            );
          }
        }
        const entries: EnrichableUsageRowChange[] = [];
        for (const record of listed) {
          // A row rewritten between the two statements comes back under its newer hash and is
          // returned as read; one that stopped being active in between leaves the result.
          const change = read.get(record.row_key);
          if (change) {
            entries.push(change);
          } else if (input.knownContentHashes.get(record.row_key) === record.content_hash) {
            entries.push({ contentHash: record.content_hash, rowKey: record.row_key, state: 'known' });
          }
        }
        return { entries };
      },
      catch: (cause) => usageStoreReadError('queryEnrichableUsageRowChanges', input.dbPath, cause),
    }),
  );

export const queryLocalRowsWatermark = (
  input: QueryLocalRowsWatermarkInput,
): Effect.Effect<LocalRowsWatermark, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const record = db
          .query(`
            SELECT COUNT(*) AS row_count, MAX(updated_at) AS last_updated_at
            FROM usage_rows
            WHERE origin_machine_id = ? AND harness_key = ? AND source_authority = 'local-observed'
          `)
          .get(input.machineId, input.harnessKey) as { last_updated_at: string | null; row_count: number } | null;
        return { lastUpdatedAt: record?.last_updated_at ?? null, rows: Number(record?.row_count ?? 0) };
      },
      catch: (cause) => usageStoreReadError('queryLocalRowsWatermark', input.dbPath, cause),
    }),
  );

export const queryEnrichableUsageRows = (
  input: QueryEnrichableUsageRowsInput,
): Effect.Effect<QueryEnrichableUsageRowsResult, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        const { params, where } = enrichableUsageRowsFilter(input);
        const records = db
          .query(`SELECT row_key, row_json, source_authority FROM usage_rows WHERE ${where} ${ENRICHABLE_ROWS_ORDER}`)
          .all(...params) as StoredRowRecord[];
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
      catch: (cause) => usageStoreReadError('queryEnrichableUsageRows', input.dbPath, cause),
    }),
  );

export const upsertRtkSavingsContributions = (
  input: UpsertRtkSavingsContributionsInput,
): Effect.Effect<EnrichmentImportResult, UsageStoreError> =>
  withUsageStoreWriter(input.dbPath, (db) =>
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

export const {
  setServedReportPublicationFaultInjectorForTesting,
  setServedReportReadFaultInjectorForTesting,
  queryServedRevisionData,
  queryCurrentServedReportRevision,
  queryCurrentServedReportRevisionBootstrap,
  queryCurrentServedLocalProjectSources,
  queryServedSessionPullRequestLinks,
  queryServedReportRevisionSupport,
  queryServedReportRevisionRows,
  queryServedReportRevisionSlices,
  queryServedReportRevisionPortableConfig,
  queryServedReportRevisionLocalSnapshot,
  publishServedReportRevision,
  retainServedReportRevisions,
} = createServedReportStore({
  readUsageLocalMachineWithDatabase,
  readUsageStoreGenerations,
  usageStoreError,
  usageStoreServedReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});

export const {
  importProviderQuotaBatch,
  queryProviderQuotaObservations,
  queryProviderQuotaSourceState,
  queryProviderQuotaSourceStates,
  queryLatestProviderQuotaObservations,
  queryLatestLocalProviderQuotaObservations,
  recordProviderQuotaSourceAttempt,
  retainProviderQuotaObservations,
} = createProviderQuotaStore({
  readUsageLocalMachineWithDatabase,
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});

export const { importSkillObservations, querySkillObservations, retainSkillObservations } = createSkillObservationStore(
  {
    usageStoreError,
    usageStoreReadError,
    withUsageStoreReader,
    withUsageStoreWriter,
  },
);

export const {
  importExecutorObservations,
  queryExecutorAccountChanges,
  queryExecutorObservationHistory,
  queryLatestExecutorObservations,
} = createExecutorObservationStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});
export const {
  importCheckoutStatusObservations,
  importJiraIssueObservations,
  importPullRequestObservations,
  queryLatestCheckoutStatusObservations,
  queryLatestJiraIssueObservations,
  queryLatestPullRequestObservations,
  queryWorkFactRunStates,
  recordWorkFactRun,
  queryJiraSyncState,
  recordJiraSyncState,
} = createWorkFactStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});
export { WORK_FACT_SOURCE_IDS, type WorkFactSourceId } from './work-fact-store';
export const {
  countClaudeDesktopSessions,
  importClaudeDesktopSessions,
  queryClaudeDesktopCollectionState,
  queryClaudeDesktopSessions,
  queryClaudeDesktopTurnDeclarations,
} = createClaudeDesktopSessionStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});
export const {
  markReviewAttemptsLost,
  queryReviewAttempts,
  queryReviewReservations,
  queryReviewTargetResolution,
  releaseReviewAttemptReservation,
  requestReviewAttempt,
  transitionReviewAttempt,
} = createReviewAttemptStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});
export const {
  countDelegationRetryChain,
  markDelegationJobsLost,
  queryDelegationEvaluations,
  queryDelegationJobs,
  readDelegationJob,
  readDelegationJobs,
  readDelegationQualification,
  recordDelegationEvaluation,
  recordDelegationQualification,
  releaseDelegationJobReservation,
  requestDelegationCancel,
  requestDelegationJob,
  transitionDelegationJob,
} = createDelegationStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});

export const { importCodexWorkObservations, queryCodexWorkObservations } = createCodexWorkStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});

export const {
  applyWorkThreadCommand,
  applyWorkThreadWaitObservations,
  attachDeclaredWorkThreadSessions,
  countWorkThreads,
  queryActiveWorkThreadLinks,
  queryJiraIntake,
  queryWorkThreadById,
  queryWorkThreadCombinations,
  queryWorkThreadCombineSuggestions,
  queryWorkThreadEvents,
  queryWorkThreadLinks,
  queryWorkThreadProjects,
  queryWorkThreadWaitCandidates,
  queryWorkThreadSessionEvidence,
  queryWorkThreadsPage,
  reconcileWorkBranches,
  recordJiraIntake,
  seedWorkThreads,
} = createWorkThreadStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});
export type {
  ApplyWorkThreadCommandInput,
  ApplyWorkThreadWaitObservationsInput,
  ApplyWorkThreadWaitObservationsResult,
  AttachDeclaredWorkThreadSessionsInput,
  AttachDeclaredWorkThreadSessionsResult,
  DeclaredWorkThreadSession,
  JiraIntakeEntry,
  QueryActiveWorkThreadLinksInput,
  QueryActiveWorkThreadLinksResult,
  QueryJiraIntakeInput,
  QueryJiraIntakeResult,
  QueryWorkThreadByIdInput,
  QueryWorkThreadCombineSuggestionsResult,
  QueryWorkThreadLinksInput,
  QueryWorkThreadSessionEvidenceInput,
  QueryWorkThreadsPageInput,
  QueryWorkThreadsPageResult,
  QueryWorkThreadWaitCandidatesInput,
  QueryWorkThreadWaitCandidatesResult,
  ReconcileWorkBranchesInput,
  ReconcileWorkBranchesResult,
  RecordJiraIntakeInput,
  SeedWorkThreadsInput,
  SeedWorkThreadsResult,
  WorkThreadCombination,
  WorkThreadCombineSuggestionEntry,
  WorkThreadPageRow,
  WorkThreadSeed,
  WorkThreadSessionEvidence,
  WorkThreadWaitCandidate,
} from './work-thread-store';

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
  queryStoredReportCapture: (input) => queryStoredReportCapture({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryEnrichableUsageRows: (input) => queryEnrichableUsageRows({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryUsageMachineFleet: (input) => queryUsageMachineFleet({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryUsageStoreGenerations: (input) =>
    queryUsageStoreGenerations({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryUsageStoreGeneration: (input) =>
    queryUsageStoreGeneration({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  retireLocalRows: (input) => retireLocalRows({ ...input, dbPath: input.dbPath ?? dbPath }),
  updateUsageMachineLabel: (input) => updateUsageMachineLabel({ ...input, dbPath: input.dbPath ?? dbPath }),
  upsertRtkSavingsContributions: (input) => upsertRtkSavingsContributions({ ...input, dbPath: input.dbPath ?? dbPath }),
});

export const { queryRecentServedHarnessSessions, querySessionRowsBySourceSessionIds } = createWorkSessionJoinStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
});
