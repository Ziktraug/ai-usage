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

/**
 * Session families one Work read takes from the served projection for a harness that declares no
 * turn status (ADR 0059): at most one page of Work roots (`WORK_ATTENTION_BOUNDS.maxRoots`), the
 * most recently active first; the others are counted, not read.
 */
export const MAX_WORK_HARNESS_SESSION_FAMILIES = 200;
/** Members read per family beside its root: the child titles a Work root shows, never the whole family. */
export const MAX_WORK_HARNESS_SESSION_MEMBERS = 5;
const MAX_MEMBER_TEXT = 4096;
const MAX_MEMBER_SHORT_TEXT = 64;

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): unknown;
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

export interface QueryRecentServedHarnessSessionsInput {
  /** Families with a member whose last activity (`endDate ?? date`) is at or after this epoch instant. */
  readonly activeSince: number;
  readonly dbPath: string;
  readonly harnessKey: string;
  /** Families read at most; defaults to and may not exceed `MAX_WORK_HARNESS_SESSION_FAMILIES`. */
  readonly limit?: number;
  readonly machineId?: string;
}

/** One served Session of a family, as the Work read needs it; nothing else of the row is read. */
export interface ServedHarnessSessionMember {
  /** The row's last activity (`endDate ?? date`), epoch milliseconds; `null` when undated. */
  readonly activeAt: number | null;
  /** The last branch the harness recorded for the Session (`source.vcs.branches`), never a derived one. */
  readonly branch: string | null;
  readonly campaignRoot: boolean;
  /** `source.sourcePath`: the working directory the harness recorded. */
  readonly checkoutPath: string | null;
  readonly machineId: string;
  readonly origin: string | null;
  /** The parent the harness declared (`source.parentSourceSessionId`); on a root, that parent is not served. */
  readonly parentSourceSessionId: string | null;
  readonly projectLabel: string;
  readonly rowId: string;
  readonly sourceSessionId: string;
  readonly startedAt: string | null;
  readonly title: string;
}

/** One served campaign: the lineage the report already folds from declared parents, nothing inferred. */
export interface ServedHarnessSessionFamily {
  readonly campaignKey: string;
  /** The latest member activity in the window, epoch milliseconds. */
  readonly lastActiveAt: number;
  /** Every member of the campaign at this revision, its root included. */
  readonly memberCount: number;
  /** The campaign root first, then at most `MAX_WORK_HARNESS_SESSION_MEMBERS` others, most recently active first. */
  readonly members: readonly ServedHarnessSessionMember[];
}

export interface QueryRecentServedHarnessSessionsResult {
  readonly families: readonly ServedHarnessSessionFamily[];
  /** Families active in the window, counted; more than `families.length` when the bound left some unread. */
  readonly familiesInWindow: number;
  /** The consulted revision's `generated_at`; `null` with `revision`. */
  readonly generatedAt: string | null;
  /** Member rows whose fields were absent or out of shape, plus families a refused root left unshown. */
  readonly refusedRows: number;
  /** The served revision consulted, or `null` when none is published (then nothing is read). */
  readonly revision: string | null;
}

interface FamilyRecord {
  campaign_key: unknown;
  last_active: unknown;
}

interface MemberRecord {
  active_time: unknown;
  branch: unknown;
  campaign_key: unknown;
  campaign_root: unknown;
  checkout_path: unknown;
  machine_id: unknown;
  member_count: unknown;
  origin: unknown;
  parent_source_session_id: unknown;
  project_label: unknown;
  row_id: unknown;
  source_session_id: unknown;
  started_at: unknown;
  title: unknown;
}

const identifier = (value: unknown): string | null =>
  typeof value === 'string' && validIdentifier(value) ? value : null;
const boundedText = (value: unknown, maxLength: number): string | null =>
  typeof value === 'string' && value.length <= maxLength ? value : null;
/** `null` for an absent value, `undefined` for a present one out of shape. */
const optional = <Value>(value: unknown, parse: (present: unknown) => Value | null): Value | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  return parse(value) ?? undefined;
};
const epochMilliseconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const memberOf = (record: MemberRecord): ServedHarnessSessionMember | null => {
  const rowId = identifier(record.row_id);
  const sourceSessionId = identifier(record.source_session_id);
  const machineId = identifier(record.machine_id);
  const projectLabel = boundedText(record.project_label, MAX_MEMBER_TEXT);
  const title = boundedText(record.title, MAX_MEMBER_TEXT);
  const parentSourceSessionId = optional(record.parent_source_session_id, identifier);
  const checkoutPath = optional(record.checkout_path, (value) => boundedText(value, MAX_MEMBER_TEXT));
  const branch = optional(record.branch, (value) => boundedText(value, MAX_MEMBER_TEXT));
  const origin = optional(record.origin, (value) => boundedText(value, MAX_MEMBER_SHORT_TEXT));
  const startedAt = optional(record.started_at, (value) => boundedText(value, MAX_MEMBER_SHORT_TEXT));
  const activeAt = optional(record.active_time, epochMilliseconds);
  if (
    rowId === null ||
    sourceSessionId === null ||
    machineId === null ||
    projectLabel === null ||
    title === null ||
    parentSourceSessionId === undefined ||
    checkoutPath === undefined ||
    branch === undefined ||
    origin === undefined ||
    startedAt === undefined ||
    activeAt === undefined
  ) {
    return null;
  }
  return {
    activeAt,
    branch,
    campaignRoot: record.campaign_root === 1,
    checkoutPath,
    machineId,
    origin,
    parentSourceSessionId,
    projectLabel,
    rowId,
    sourceSessionId,
    startedAt,
    title,
  };
};

const FAMILY_WINDOW_WHERE = (machineFiltered: boolean): string => `
  WHERE revision = ?
    AND active_time >= ?
    ${machineFiltered ? 'AND machine_id = ?' : ''}
    AND campaign_key IS NOT NULL
    AND json_extract(source_row_json, '$.source.harnessKey') = ?
`;

const MEMBERS_SQL = (families: number): string => `
  SELECT * FROM (
    SELECT
      row_id,
      campaign_key,
      campaign_root,
      project_label,
      machine_id,
      origin,
      active_time,
      json_extract(source_row_json, '$.source.sourceSessionId') AS source_session_id,
      json_extract(source_row_json, '$.source.parentSourceSessionId') AS parent_source_session_id,
      json_extract(source_row_json, '$.source.sourcePath') AS checkout_path,
      json_extract(source_row_json, '$.source.vcs.branches[#-1].name') AS branch,
      json_extract(source_row_json, '$.sessionLabel') AS title,
      json_extract(source_row_json, '$.date') AS started_at,
      ROW_NUMBER() OVER (PARTITION BY campaign_key ORDER BY campaign_root DESC, active_time DESC, ordinal) AS position,
      COUNT(*) OVER (PARTITION BY campaign_key) AS member_count
    FROM served_report_rows
    WHERE revision = ? AND campaign_key IN (${Array.from({ length: families }, () => '?').join(', ')})
  )
  WHERE position <= ?
  ORDER BY campaign_key, position
`;

/** Groups member records per campaign, root first as the query orders them; out-of-shape rows are counted. */
const familiesOf = (
  keys: readonly { readonly campaignKey: string; readonly lastActiveAt: number }[],
  records: readonly MemberRecord[],
): { readonly families: ServedHarnessSessionFamily[]; readonly refusedRows: number } => {
  const byKey = new Map<string, { count: number; members: ServedHarnessSessionMember[] }>();
  let refusedRows = 0;
  for (const record of records) {
    const member = typeof record.campaign_key === 'string' ? memberOf(record) : null;
    if (member === null || typeof record.campaign_key !== 'string') {
      refusedRows += 1;
      continue;
    }
    const entry = byKey.get(record.campaign_key) ?? { count: 0, members: [] };
    entry.count = typeof record.member_count === 'number' ? record.member_count : entry.count;
    entry.members.push(member);
    byKey.set(record.campaign_key, entry);
  }
  const families: ServedHarnessSessionFamily[] = [];
  for (const key of keys) {
    const entry = byKey.get(key.campaignKey);
    // A campaign whose root row was refused is not shown under another member: that would promote it.
    if (entry?.members[0]?.campaignRoot !== true) {
      refusedRows += entry === undefined ? 0 : 1;
      continue;
    }
    families.push({ ...key, memberCount: entry.count, members: entry.members });
  }
  return { families, refusedRows };
};

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

  /**
   * The recent session families of one harness in the current served revision (ADR 0059): the
   * campaigns with a member of `harnessKey` active since `activeSince`, most recently active
   * first, each with its root and its latest few members, and how many such families exist. A
   * campaign is the lineage the report already folds from declared parents; nothing here links a
   * session by checkout, branch or time. One read transaction, bounded by the family limit and
   * the per-family member bound.
   */
  const queryRecentServedHarnessSessions = (
    input: QueryRecentServedHarnessSessionsInput,
  ): Effect.Effect<QueryRecentServedHarnessSessionsResult, UsageStoreError> => {
    const limit = input.limit ?? MAX_WORK_HARNESS_SESSION_FAMILIES;
    if (
      !(
        validIdentifier(input.harnessKey) &&
        (input.machineId === undefined || validIdentifier(input.machineId)) &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= MAX_WORK_HARNESS_SESSION_FAMILIES &&
        Number.isSafeInteger(input.activeSince)
      )
    ) {
      return Effect.fail(
        usageStoreError(
          'queryRecentServedHarnessSessions',
          input.dbPath,
          'Harness session family query is invalid or exceeds its budget',
          'invalid-input',
        ),
      );
    }
    return withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: (): QueryRecentServedHarnessSessionsResult => {
          db.exec('BEGIN');
          try {
            const current = db
              .query(`
                SELECT revisions.revision AS revision, revisions.generated_at AS generated_at
                FROM served_report_current AS current
                INNER JOIN served_report_revisions AS revisions USING (revision)
                WHERE current.singleton = 1 AND revisions.complete = 1
              `)
              .get() as { generated_at: string; revision: string } | null;
            if (current === null) {
              return { families: [], familiesInWindow: 0, generatedAt: null, refusedRows: 0, revision: null };
            }
            const where = FAMILY_WINDOW_WHERE(input.machineId !== undefined);
            const params = [
              current.revision,
              input.activeSince,
              ...(input.machineId === undefined ? [] : [input.machineId]),
              input.harnessKey,
            ];
            const counted = db
              .query(`SELECT COUNT(DISTINCT campaign_key) AS families FROM served_report_rows ${where}`)
              .get(...params) as { families: number } | null;
            const keys = (
              db
                .query(`
                  SELECT campaign_key, MAX(active_time) AS last_active
                  FROM served_report_rows ${where}
                  GROUP BY campaign_key
                  ORDER BY last_active DESC, campaign_key
                  LIMIT ?
                `)
                .all(...params, limit) as FamilyRecord[]
            ).flatMap((record) =>
              typeof record.campaign_key === 'string' && typeof record.last_active === 'number'
                ? [{ campaignKey: record.campaign_key, lastActiveAt: record.last_active }]
                : [],
            );
            const records =
              keys.length === 0
                ? []
                : (db
                    .query(MEMBERS_SQL(keys.length))
                    .all(
                      current.revision,
                      ...keys.map((key) => key.campaignKey),
                      MAX_WORK_HARNESS_SESSION_MEMBERS + 1,
                    ) as MemberRecord[]);
            const { families, refusedRows } = familiesOf(keys, records);
            return {
              families,
              familiesInWindow: Math.max(counted?.families ?? 0, keys.length),
              generatedAt: current.generated_at,
              refusedRows,
              revision: current.revision,
            };
          } finally {
            db.exec('COMMIT');
          }
        },
        catch: (cause) => usageStoreReadError('queryRecentServedHarnessSessions', input.dbPath, cause),
      }),
    );
  };

  return { queryRecentServedHarnessSessions, querySessionRowsBySourceSessionIds };
};
