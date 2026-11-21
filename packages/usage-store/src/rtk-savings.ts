import { createHash } from 'node:crypto';
import type { SqliteDatabase, SqliteStatement } from './sqlite-database';

export interface RtkSavingsContribution {
  readonly rtkCommandCount: number;
  readonly rtkInputTokens: number;
  readonly rtkOutputTokens: number;
  readonly rtkSavedTokens: number;
}

export interface EnrichmentImportResult {
  inserted: number;
  unchanged: number;
  updated: number;
}

export interface StoredEnrichmentRecord {
  content_hash: string;
  payload_json: string;
  row_key: string;
  schema_version: number;
  source_id: string;
}

interface EnrichmentStatements {
  existing: SqliteStatement;
  insert: SqliteStatement;
  touch: SqliteStatement;
  update: SqliteStatement;
}

export const RTK_SAVINGS_SOURCE_ID = 'rtk.savings';
export const RTK_SAVINGS_SCHEMA_VERSION = 1;
export const RTK_SAVINGS_KEYS = [
  'rtkCommandCount',
  'rtkInputTokens',
  'rtkOutputTokens',
  'rtkSavedTokens',
] as const satisfies readonly (keyof RtkSavingsContribution)[];

export const isRtkSavingsContribution = (value: unknown): value is RtkSavingsContribution => {
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

export const rtkSavingsFromRow = (row: {
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

export const stripRtkSavings = <Row extends Partial<RtkSavingsContribution>>(
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

export const enrichmentContentHash = (value: RtkSavingsContribution): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const prepareEnrichmentStatements = (db: SqliteDatabase): EnrichmentStatements => ({
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

export const upsertRtkContribution = (
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
