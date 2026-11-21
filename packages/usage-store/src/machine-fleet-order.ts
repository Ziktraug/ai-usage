import { isSerializedMergeRow } from '@ai-usage/report-core/merge-bundle';
import { IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE } from '@ai-usage/report-core/report-budgets';
import type { SqliteDatabase } from './sqlite-database';
import type { StoredSourceAuthority, StoredUsageRowStatus } from './stored-usage-row';

export interface StoredMachineFleetRow {
  active_date: string | null;
  last_seen_at: string;
  origin_machine_id: string;
  row_json: string;
  row_key: string;
  source_authority: StoredSourceAuthority;
  status: StoredUsageRowStatus;
}

interface StoredMachineFleetOrderRecord {
  label: string;
  origin_machine_id: string;
}

export const fleetMetadataForStoredRow = (record: StoredMachineFleetRow): { machineLabel: string } | undefined => {
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
export const rebuildUsageMachineFleetOrder = (db: SqliteDatabase): void => {
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

export const usageMachineFleetOrderChanged = (db: SqliteDatabase, machineIds: readonly string[]): boolean => {
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
