import { createHash } from 'node:crypto';
import {
  parseUsageMergeBundleValue,
  type SerializedMergeRow,
  type UsageMergeBundle,
} from '@ai-usage/report-core/merge-bundle';
import { type MergeConfirmationToken, parseMergeConfirmationToken } from '@ai-usage/report-core/merge-proof';
import { IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE } from '@ai-usage/report-core/report-budgets';
import { Effect } from 'effect';
import { withConfirmationUsageStore, withUsageStorePreview } from './connections';
import { previewStaleError, UsageStoreError, usageStoreError, usageStorePreviewStateError } from './errors';
import {
  chunkRows,
  classifyMergeRows,
  type ImportResult,
  importMergeRows,
  type PreparedMergeRow,
  prepareMergeRow,
  summarizeClassifications,
  writeClassifiedMergeRows,
} from './local-rows';
import type { UsageStoreGenerationRecord } from './migration';
import { revalidatePrivateStoreForConfirmation } from './private-storage';
import type { SqliteDatabase } from './sqlite-database';

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
