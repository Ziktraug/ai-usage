import { deserializeMergeRow, isSerializedMergeRow } from '@ai-usage/report-core/merge-bundle';
import { IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE } from '@ai-usage/report-core/report-budgets';
import type { CollectedUsageRow } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { withUsageStoreReader, withUsageStoreWriter } from './connections';
import { type UsageStoreError, usageStoreError, usageStoreReadError } from './errors';
import { chunkRows } from './local-rows';
import {
  type EnrichmentImportResult,
  isRtkSavingsContribution,
  prepareEnrichmentStatements,
  type RtkSavingsContribution,
  stripRtkSavings,
  upsertRtkContribution,
} from './rtk-savings';
import type { StoredRowRecord, StoredSourceAuthority } from './stored-usage-row';

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
