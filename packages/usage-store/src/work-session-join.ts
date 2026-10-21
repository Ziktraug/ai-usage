import { Effect } from 'effect';
import type { UsageStoreError, UsageStoreErrorReason } from './errors';

/**
 * The bounded join from a native session identity to the served Session row it corresponds to:
 * `(machineId, harnessKey, sourceSessionId)` → `(rowId, campaignKey, projectLabel)` in the current
 * served revision. The Work read model uses it to attach a Desktop session to the Session the
 * report already shows, so "Open session detail" lands on the right row.
 *
 * It reads the served projection, never `usage_rows`, so it answers from the same revision the
 * rest of the application presents. The identity lives inside `source_row_json`; the read is
 * bounded by the id list, the current revision and the machine, which is small enough for the
 * cadence this is read on.
 */

export const MAX_WORK_SESSION_JOIN_IDS = 500;

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  query(sql: string): SqliteStatement;
}

interface WorkSessionJoinDependencies {
  readonly usageStoreError: (
    operation: string,
    dbPath: string,
    cause: unknown,
    reason: UsageStoreErrorReason,
  ) => UsageStoreError;
  readonly usageStoreReadError: (operation: string, dbPath: string, cause: unknown) => UsageStoreError;
  readonly withUsageStoreReader: <Value>(
    dbPath: string,
    use: (database: SqliteDatabase) => Effect.Effect<Value, UsageStoreError>,
  ) => Effect.Effect<Value, UsageStoreError>;
}

export interface QuerySessionRowsBySourceSessionIdsInput {
  readonly dbPath: string;
  readonly harnessKey: string;
  readonly machineId: string;
  readonly sourceSessionIds: readonly string[];
}

export interface ServedSessionRowIdentity {
  readonly campaignKey: string | null;
  readonly projectLabel: string;
  readonly rowId: string;
  readonly sourceSessionId: string;
}

export interface QuerySessionRowsBySourceSessionIdsResult {
  /** The served revision consulted, or `null` when none is published (then `rows` is empty). */
  readonly revision: string | null;
  readonly rows: readonly ServedSessionRowIdentity[];
}

interface JoinRecord {
  campaign_key: string | null;
  project_label: string;
  row_id: string;
  source_session_id: string;
}

const validIdentifier = (value: string): boolean => value.trim().length > 0 && value.length <= 512;

export const createWorkSessionJoinStore = (dependencies: WorkSessionJoinDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader } = dependencies;

  const querySessionRowsBySourceSessionIds = (
    input: QuerySessionRowsBySourceSessionIdsInput,
  ): Effect.Effect<QuerySessionRowsBySourceSessionIdsResult, UsageStoreError> => {
    const ids = [...new Set(input.sourceSessionIds)];
    if (
      ids.length > MAX_WORK_SESSION_JOIN_IDS ||
      !(validIdentifier(input.machineId) && validIdentifier(input.harnessKey)) ||
      !ids.every(validIdentifier)
    ) {
      return Effect.fail(
        usageStoreError(
          'querySessionRowsBySourceSessionIds',
          input.dbPath,
          'Session join identities are invalid or exceed their budget',
          'invalid-input',
        ),
      );
    }
    return withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const current = db
            .query(`
              SELECT revisions.revision AS revision
              FROM served_report_current AS current
              INNER JOIN served_report_revisions AS revisions USING (revision)
              WHERE current.singleton = 1 AND revisions.complete = 1
            `)
            .get() as { revision: string } | null;
          if (current === null) {
            return { revision: null, rows: [] };
          }
          if (ids.length === 0) {
            return { revision: current.revision, rows: [] };
          }
          const rows = db
            .query(`
              SELECT
                row_id,
                campaign_key,
                project_label,
                json_extract(source_row_json, '$.source.sourceSessionId') AS source_session_id
              FROM served_report_rows
              WHERE revision = ?
                AND machine_id = ?
                AND json_extract(source_row_json, '$.source.harnessKey') = ?
                AND json_extract(source_row_json, '$.source.sourceSessionId') IN (${ids.map(() => '?').join(', ')})
              ORDER BY ordinal
            `)
            .all(current.revision, input.machineId, input.harnessKey, ...ids) as JoinRecord[];
          return {
            revision: current.revision,
            rows: rows
              .filter((record) => typeof record.source_session_id === 'string' && typeof record.row_id === 'string')
              .map((record) => ({
                campaignKey: record.campaign_key,
                projectLabel: record.project_label,
                rowId: record.row_id,
                sourceSessionId: record.source_session_id,
              })),
          };
        },
        catch: (cause) => usageStoreReadError('querySessionRowsBySourceSessionIds', input.dbPath, cause),
      }),
    );
  };

  return { querySessionRowsBySourceSessionIds };
};
