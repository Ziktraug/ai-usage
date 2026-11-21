import {
  isSerializedMergeRow,
  type SerializedMergeRow,
  toSerializedMergeRow,
  usageContentHash,
} from '@ai-usage/report-core/merge-bundle';
import { IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE } from '@ai-usage/report-core/report-budgets';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { withUsageStoreWriter } from './connections';
import { UsageStoreError, usageStoreError } from './errors';
import type { StoredUsageLocalMachineRecord } from './machine-fleet';
import { rebuildUsageMachineFleetOrder, usageMachineFleetOrderChanged } from './machine-fleet-order';
import {
  prepareEnrichmentStatements,
  RTK_SAVINGS_KEYS,
  type RtkSavingsContribution,
  rtkSavingsFromRow,
  stripRtkSavings,
  upsertRtkContribution,
} from './rtk-savings';
import type { SqliteDatabase, SqliteStatement } from './sqlite-database';
import type { StoredSourceAuthority, StoredUsageRowStatus } from './stored-usage-row';

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

type MergeRowClassification = 'inserted' | 'updated' | 'unchanged' | 'superseded' | 'deleted';

interface ClassifiedMergeRow {
  classification: MergeRowClassification;
  fleetProjectionChanged: boolean;
  repairFleetMetadata: boolean;
  reportProjectionChanged: boolean;
  row: SerializedMergeRow;
}

export interface PreparedMergeRow {
  contribution?: RtkSavingsContribution;
  row: SerializedMergeRow;
}

export const prepareMergeRow = (row: SerializedMergeRow): PreparedMergeRow => {
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

export const chunkRows = <T>(rows: T[], size: number): T[][] => {
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

export const classifyMergeRows = (
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

export const summarizeClassifications = (
  classifiedRows: Pick<ClassifiedMergeRow, 'classification' | 'fleetProjectionChanged'>[],
): ImportResult => {
  const result = emptyImportResult();
  for (const { classification } of classifiedRows) {
    result[classification]++;
  }
  result.fleetChanged = classifiedRows.some(({ fleetProjectionChanged }) => fleetProjectionChanged);
  return result;
};

export const writeClassifiedMergeRows = (
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

export const importMergeRows = (
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
