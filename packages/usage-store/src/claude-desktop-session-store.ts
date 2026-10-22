import { createHash } from 'node:crypto';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  type ClaudeDesktopCollectionCompleteness,
  type ClaudeDesktopSessionObservation,
  type ClaudeDesktopTurnDeclaration,
  parseClaudeDesktopSessionObservation,
  parseClaudeDesktopTurnDeclaration,
  WORK_ATTENTION_BOUNDS,
} from '@ai-usage/report-core/work-attention';
import {
  advanceClaudeDesktopDeclarationHistory,
  claudeDesktopDeclarationKey,
} from '@ai-usage/report-core/work-attention-native';
import { Effect } from 'effect';
import { UsageStoreError, type UsageStoreErrorReason } from './errors';
import { validWorkSessionReadScope, type WorkSessionReadScope, workSessionScopeSql } from './work-session-scope';

/**
 * Durable storage for the Claude Desktop session fact family (ADR 0050), modelled on
 * `skill-observation-store.ts`: its own tables, its own collector, a read path that never goes
 * through the report bootstrap, and rows re-validated on the way out.
 *
 * What is different from the skill family, and deliberately so:
 *
 * - **The family stays outside the served revision.** Nothing here touches `usage_rows`,
 *   `served_report_*`, the replication outbox or the merge bundle, and an import does not advance
 *   the store generation: the served revision is not stale because a Desktop registry file moved.
 *   The Work view reads this table directly on a collection-SWR policy.
 * - **One row per desktop session, overwritten in place.** The registry file is the app's current
 *   view of a session and is rewritten on every turn; keeping each rewrite would be history the
 *   product has not asked for. `file_modified_at` plus a hash of the normalized content decide
 *   whether a re-import changed anything.
 *   The one exception is the turn declaration (ADR 0056): the file keeps only the latest
 *   `postTurnSummary`, so each distinct declaration is kept in `claude_desktop_turn_declarations`,
 *   at most `maxDeclarationsPerSession` per session, with the dates that let a later read say a
 *   question was answered in the harness or replaced. The history is advanced by the same pure
 *   function the e2e composition uses (`advanceClaudeDesktopDeclarationHistory`).
 * - **Text is already bounded and a proposal's prompt never arrived.** The collector clamps to
 *   `WORK_ATTENTION_BOUNDS`; the contract parser refuses anything above them, on import and on read.
 */

/** Matches the collector's file bound: one sweep can never produce more rows than this. */
export const MAX_CLAUDE_DESKTOP_SESSION_BATCH = 2000;
export const MAX_CLAUDE_DESKTOP_SESSION_READ = 500;
/** Session ids one history or by-id read accepts. */
export const MAX_CLAUDE_DESKTOP_SESSION_ID_FILTER = 500;
const MAX_COLLECTION_STATES = 64;
/** The statuses that ask something of the person; the Work read keeps them beyond its recency bound. */
const PENDING_STATUS_CATEGORIES = ['blocked', 'review_ready'] as const;

export const claudeDesktopSessionSchemaSql = `
  -- Collection completeness per machine: what the last sweep of the Desktop registry saw.
  CREATE TABLE IF NOT EXISTS claude_desktop_collection_state (
    machine_id TEXT PRIMARY KEY,
    collected_at TEXT NOT NULL,
    files_seen INTEGER NOT NULL CHECK (files_seen >= 0),
    files_parsed INTEGER NOT NULL CHECK (files_parsed >= 0),
    unsupported INTEGER NOT NULL CHECK (unsupported >= 0),
    rejected INTEGER NOT NULL CHECK (rejected >= 0),
    truncated INTEGER NOT NULL CHECK (truncated IN (0, 1))
  ) WITHOUT ROWID;

  -- One row per (machine, desktop session). Scalar columns carry identity, dates and the
  -- declared turn outcome; *_json columns carry the bounded lists the contract defines. The
  -- vocabulary columns (format, title_source, status_category) carry no CHECK on purpose: rows
  -- are re-validated on read, and a narrower schema added later would hide history on disk.
  -- There is no prompt column, and there must never be one.
  CREATE TABLE IF NOT EXISTS claude_desktop_sessions (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    desktop_session_id TEXT NOT NULL,
    account_directory TEXT NOT NULL,
    organization_directory TEXT NOT NULL,
    cli_session_id TEXT NOT NULL,
    prior_cli_session_ids_json TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_modified_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    format TEXT NOT NULL,
    unsupported_reason TEXT,
    content_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    title_source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    completed_turns INTEGER CHECK (completed_turns IS NULL OR completed_turns >= 0),
    model TEXT,
    effort TEXT,
    cwd TEXT NOT NULL,
    origin_cwd TEXT,
    worktree_path TEXT,
    branch TEXT,
    source_branch TEXT,
    written_branches_json TEXT NOT NULL,
    status_category TEXT,
    status_detail TEXT,
    needs_action TEXT,
    summarizes_uuid TEXT,
    wrap_up_description TEXT,
    last_turn_report TEXT,
    spawned_from_session_id TEXT,
    spawned_from_task_id TEXT,
    spawned_from_title TEXT,
    spawned_from_side_session INTEGER CHECK (spawned_from_side_session IS NULL OR spawned_from_side_session IN (0, 1)),
    open_suggestions_json TEXT NOT NULL,
    resolved_suggestions_json TEXT NOT NULL,
    declared_pull_requests_json TEXT NOT NULL,
    side_session_notes_json TEXT NOT NULL,
    first_imported_at TEXT NOT NULL,
    last_imported_at TEXT NOT NULL,
    -- Added under the same user_version (ADR 0056); a table from before it gains the column on open.
    latest_user_frame_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_desktop_sessions_identity
    ON claude_desktop_sessions(machine_id, desktop_session_id);
  -- The Work read asks for the most recently active sessions of one machine.
  CREATE INDEX IF NOT EXISTS idx_claude_desktop_sessions_activity
    ON claude_desktop_sessions(machine_id, last_activity_at DESC, id DESC);
  -- The join to the collected Session: (machine, harness 'claude', sourceSessionId = cli_session_id).
  CREATE INDEX IF NOT EXISTS idx_claude_desktop_sessions_cli
    ON claude_desktop_sessions(machine_id, cli_session_id);

  -- One row per distinct turn declaration of a desktop session (ADR 0056), newest kept per
  -- session. Dates are the session's own (declared_at, superseded_at) or the harness's record of a
  -- message after the declaration (replied_at); first_observed_at is the sweep that first saw it.
  CREATE TABLE IF NOT EXISTS claude_desktop_turn_declarations (
    machine_id TEXT NOT NULL,
    desktop_session_id TEXT NOT NULL,
    declaration_key TEXT NOT NULL,
    status_category TEXT NOT NULL,
    status_detail TEXT NOT NULL,
    needs_action TEXT,
    declared_at TEXT NOT NULL,
    first_observed_at TEXT NOT NULL,
    replied_at TEXT,
    superseded_at TEXT,
    superseded_by_key TEXT,
    PRIMARY KEY (machine_id, desktop_session_id, declaration_key)
  ) WITHOUT ROWID;
`;

/** The tables this family owns; their absence is the additive-migration signal. */
export const CLAUDE_DESKTOP_SESSION_TABLES = [
  'claude_desktop_collection_state',
  'claude_desktop_sessions',
  'claude_desktop_turn_declarations',
] as const;

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  finalize(): void;
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  clearStatements(): void;
  close(throwOnError?: boolean): void;
  exec(sql: string): unknown;
  readonly inTransaction: boolean;
  query(sql: string): SqliteStatement;
}

interface ClaudeDesktopSessionStoreDependencies {
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
  readonly withUsageStoreWriter: <Value>(
    dbPath: string,
    use: (database: SqliteDatabase) => Effect.Effect<Value, UsageStoreError>,
  ) => Effect.Effect<Value, UsageStoreError>;
}

export interface ImportClaudeDesktopSessionsInput {
  readonly collectedAt?: Date;
  readonly completeness: ClaudeDesktopCollectionCompleteness;
  readonly dbPath: string;
  readonly machineId: string;
  /** Re-validated here against the contract; a candidate that fails is counted as `skipped`. */
  readonly observations: readonly unknown[];
}

export interface ClaudeDesktopSessionImportResult {
  readonly inserted: number;
  /** Candidates the contract parser refused, or that named another machine. Never dropped silently. */
  readonly skipped: number;
  readonly unchanged: number;
  readonly updated: number;
}

export interface QueryClaudeDesktopSessionsInput {
  readonly dbPath: string;
  /** Only these sessions (at most `MAX_CLAUDE_DESKTOP_SESSION_ID_FILTER`); an empty list reads nothing. */
  readonly desktopSessionIds?: readonly string[];
  /** Rows returned at most; defaults to and may not exceed `MAX_CLAUDE_DESKTOP_SESSION_READ`. */
  readonly limit?: number;
  readonly machineId?: string;
  /** ISO upper bound on `lastActivityAt`, exclusive: the page after an earlier one. */
  readonly olderThanLastActivityAt?: string;
  /**
   * Only sessions that may carry a wait: a current declaration that asks something of the person
   * (blocked, review ready), or a declared pull request, which an observation may show awaiting
   * someone else. The Work read keeps these beyond its recency bound.
   */
  readonly pendingOnly?: boolean;
  readonly scope?: WorkSessionReadScope;
  /** ISO lower bound on `lastActivityAt`, inclusive. */
  readonly sinceLastActivityAt?: string;
  readonly trace?: (query: { readonly params: readonly unknown[]; readonly sql: string }) => void;
}

export interface QueryClaudeDesktopSessionsResult {
  readonly observations: readonly ClaudeDesktopSessionObservation[];
  /** Persisted rows the contract parser refused on the way out. */
  readonly skipped: number;
  /** More rows matched than `limit`; the page is a selection, not the whole. */
  readonly truncated: boolean;
}

export interface QueryClaudeDesktopTurnDeclarationsInput {
  readonly dbPath: string;
  /** At most `MAX_CLAUDE_DESKTOP_SESSION_ID_FILTER`; an empty list reads nothing. */
  readonly desktopSessionIds: readonly string[];
  readonly machineId?: string;
}

export interface QueryClaudeDesktopTurnDeclarationsResult {
  /** Oldest first within each session. */
  readonly declarations: readonly ClaudeDesktopTurnDeclaration[];
  /** Persisted rows the contract parser refused on the way out. */
  readonly skipped: number;
}

export interface ClaudeDesktopCollectionState {
  readonly collectedAt: string;
  readonly completeness: ClaudeDesktopCollectionCompleteness;
  readonly machineId: string;
}

export interface QueryClaudeDesktopCollectionStateInput {
  readonly dbPath: string;
  readonly machineId?: string;
}

export interface QueryClaudeDesktopCollectionStateResult {
  readonly states: readonly ClaudeDesktopCollectionState[];
}

interface ClaudeDesktopSessionRecord {
  account_directory: string;
  archived: number;
  branch: string | null;
  cli_session_id: string;
  completed_turns: number | null;
  content_hash: string;
  created_at: string;
  cwd: string;
  declared_pull_requests_json: string;
  desktop_session_id: string;
  effort: string | null;
  file_modified_at: string;
  file_path: string;
  format: string;
  id: number;
  last_activity_at: string;
  last_turn_report: string | null;
  /** Absent on a table the engine has not reopened since ADR 0056 added it. */
  latest_user_frame_at?: string | null;
  machine_id: string;
  model: string | null;
  needs_action: string | null;
  observed_at: string;
  open_suggestions_json: string;
  organization_directory: string;
  origin_cwd: string | null;
  prior_cli_session_ids_json: string;
  resolved_suggestions_json: string;
  side_session_notes_json: string;
  source_branch: string | null;
  spawned_from_session_id: string | null;
  spawned_from_side_session: number | null;
  spawned_from_task_id: string | null;
  spawned_from_title: string | null;
  status_category: string | null;
  status_detail: string | null;
  summarizes_uuid: string | null;
  title: string;
  title_source: string;
  unsupported_reason: string | null;
  worktree_path: string | null;
  wrap_up_description: string | null;
  written_branches_json: string;
}

interface ClaudeDesktopCollectionStateRecord {
  collected_at: string;
  files_parsed: number;
  files_seen: number;
  machine_id: string;
  rejected: number;
  truncated: number;
  unsupported: number;
}

interface StoredIdentityRecord {
  content_hash: string;
  file_modified_at: string;
}

interface ClaudeDesktopTurnDeclarationRecord {
  declaration_key: string;
  declared_at: string;
  desktop_session_id: string;
  first_observed_at: string;
  machine_id: string;
  needs_action: string | null;
  replied_at: string | null;
  status_category: string;
  status_detail: string;
  superseded_at: string | null;
  superseded_by_key: string | null;
}

const declarationFromRecord = (record: ClaudeDesktopTurnDeclarationRecord): ClaudeDesktopTurnDeclaration | null =>
  parseClaudeDesktopTurnDeclaration({
    declarationKey: record.declaration_key,
    declaredAt: record.declared_at,
    desktopSessionId: record.desktop_session_id,
    detail: record.status_detail,
    firstObservedAt: record.first_observed_at,
    machineId: record.machine_id,
    needsAction: record.needs_action,
    repliedAt: record.replied_at,
    status: record.status_category,
    supersededAt: record.superseded_at,
    supersededByKey: record.superseded_by_key,
  });

const DECLARATION_FIELDS = [
  'declarationKey',
  'declaredAt',
  'desktopSessionId',
  'detail',
  'firstObservedAt',
  'machineId',
  'needsAction',
  'repliedAt',
  'status',
  'supersededAt',
  'supersededByKey',
] as const satisfies readonly (keyof ClaudeDesktopTurnDeclaration)[];

const sameDeclaration = (left: ClaudeDesktopTurnDeclaration, right: ClaudeDesktopTurnDeclaration): boolean =>
  DECLARATION_FIELDS.every((field) => left[field] === right[field]);

const booleanColumn = (value: boolean | null): number | null => {
  if (value === null) {
    return null;
  }
  return value ? 1 : 0;
};

const booleanFromColumn = (value: number | null): boolean | null => {
  if (value === null) {
    return null;
  }
  return value === 1;
};

/**
 * Identity of the content, excluding `observedAt` (the sweep time, which changes on every import
 * without the file changing) and `fileModifiedAt` (compared separately). The contract parser
 * returns keys in one fixed order, so the serialization is stable across processes.
 */
export const claudeDesktopSessionContentHash = (observation: ClaudeDesktopSessionObservation): string => {
  const { fileModifiedAt: _fileModifiedAt, observedAt: _observedAt, ...content } = observation;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
};

const validCompleteness = (value: unknown): value is ClaudeDesktopCollectionCompleteness =>
  isRecord(value) &&
  typeof value.truncated === 'boolean' &&
  (['filesSeen', 'filesParsed', 'unsupported', 'rejected'] as const).every((key) => {
    const count = value[key];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  });

/** A JSON column that does not parse is a refused row, never an empty list. */
const JSON_PARSE_FAILED: unique symbol = Symbol('json-parse-failed');

const parseJsonColumn = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return JSON_PARSE_FAILED;
  }
};

const observationFromRecord = (record: ClaudeDesktopSessionRecord): ClaudeDesktopSessionObservation | null => {
  const jsonColumns = {
    declaredPullRequests: parseJsonColumn(record.declared_pull_requests_json),
    openSuggestions: parseJsonColumn(record.open_suggestions_json),
    priorCliSessionIds: parseJsonColumn(record.prior_cli_session_ids_json),
    resolvedSuggestions: parseJsonColumn(record.resolved_suggestions_json),
    sideSessionNotes: parseJsonColumn(record.side_session_notes_json),
    writtenBranches: parseJsonColumn(record.written_branches_json),
  };
  if (Object.values(jsonColumns).some((column) => column === JSON_PARSE_FAILED)) {
    return null;
  }
  return parseClaudeDesktopSessionObservation({
    ...jsonColumns,
    accountDirectory: record.account_directory,
    archived: booleanFromColumn(record.archived),
    branch: record.branch,
    cliSessionId: record.cli_session_id,
    completedTurns: record.completed_turns,
    createdAt: record.created_at,
    cwd: record.cwd,
    desktopSessionId: record.desktop_session_id,
    effort: record.effort,
    fileModifiedAt: record.file_modified_at,
    filePath: record.file_path,
    format: record.format,
    lastActivityAt: record.last_activity_at,
    lastTurnReport: record.last_turn_report,
    latestUserFrameAt: record.latest_user_frame_at ?? null,
    machineId: record.machine_id,
    model: record.model,
    observedAt: record.observed_at,
    organizationDirectory: record.organization_directory,
    originCwd: record.origin_cwd,
    sourceBranch: record.source_branch,
    spawnedFrom:
      record.spawned_from_session_id === null
        ? null
        : {
            sessionId: record.spawned_from_session_id,
            sideSession: booleanFromColumn(record.spawned_from_side_session),
            taskId: record.spawned_from_task_id,
            title: record.spawned_from_title,
          },
    title: record.title,
    titleSource: record.title_source,
    turnSummary:
      record.status_category === null
        ? null
        : {
            detail: record.status_detail,
            needsAction: record.needs_action,
            status: record.status_category,
            summarizesUuid: record.summarizes_uuid,
          },
    unsupportedReason: record.unsupported_reason,
    worktreePath: record.worktree_path,
    wrapUpDescription: record.wrap_up_description,
  });
};

const stateFromRecord = (record: ClaudeDesktopCollectionStateRecord): ClaudeDesktopCollectionState | null => {
  const collectedAt = normalizeIsoTimestamp(record.collected_at);
  const completeness = {
    filesParsed: record.files_parsed,
    filesSeen: record.files_seen,
    rejected: record.rejected,
    truncated: record.truncated === 1,
    unsupported: record.unsupported,
  };
  return collectedAt === null || !validCompleteness(completeness)
    ? null
    : { collectedAt, completeness, machineId: record.machine_id };
};

export const createClaudeDesktopSessionStore = (dependencies: ClaudeDesktopSessionStoreDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader, withUsageStoreWriter } = dependencies;

  /**
   * Re-import of an unchanged registry is the normal case: the engine sweeps it every minute. A
   * row whose file mtime and normalized content both match counts as unchanged and issues no
   * write. The store generation is left alone either way (see the module note).
   */
  const importClaudeDesktopSessions = (
    input: ImportClaudeDesktopSessionsInput,
  ): Effect.Effect<ClaudeDesktopSessionImportResult, UsageStoreError> => {
    if (
      input.observations.length > MAX_CLAUDE_DESKTOP_SESSION_BATCH ||
      !validCompleteness(input.completeness) ||
      input.machineId.trim().length === 0
    ) {
      return Effect.fail(
        usageStoreError(
          'importClaudeDesktopSessions',
          input.dbPath,
          'Claude Desktop session batch metadata is invalid or exceeds its budget',
          'invalid-input',
        ),
      );
    }
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const result = { inserted: 0, skipped: 0, unchanged: 0, updated: 0 };
          const importedAt = (input.collectedAt ?? new Date()).toISOString();
          db.exec('BEGIN IMMEDIATE');
          try {
            const existing = db.query(`
              SELECT file_modified_at, content_hash
              FROM claude_desktop_sessions
              WHERE machine_id = ? AND desktop_session_id = ?
            `);
            const upsert = db.query(`
              INSERT INTO claude_desktop_sessions (
                machine_id, desktop_session_id, account_directory, organization_directory,
                cli_session_id, prior_cli_session_ids_json, file_path, file_modified_at, observed_at,
                format, unsupported_reason, content_hash, title, title_source, created_at,
                last_activity_at, archived, completed_turns, model, effort, cwd, origin_cwd,
                worktree_path, branch, source_branch, written_branches_json, status_category,
                status_detail, needs_action, summarizes_uuid, wrap_up_description, last_turn_report,
                spawned_from_session_id, spawned_from_task_id, spawned_from_title,
                spawned_from_side_session, open_suggestions_json, resolved_suggestions_json,
                declared_pull_requests_json, side_session_notes_json, first_imported_at, last_imported_at,
                latest_user_frame_at
              ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              )
              ON CONFLICT(machine_id, desktop_session_id) DO UPDATE SET
                account_directory = excluded.account_directory,
                organization_directory = excluded.organization_directory,
                cli_session_id = excluded.cli_session_id,
                prior_cli_session_ids_json = excluded.prior_cli_session_ids_json,
                file_path = excluded.file_path,
                file_modified_at = excluded.file_modified_at,
                observed_at = excluded.observed_at,
                format = excluded.format,
                unsupported_reason = excluded.unsupported_reason,
                content_hash = excluded.content_hash,
                title = excluded.title,
                title_source = excluded.title_source,
                created_at = excluded.created_at,
                last_activity_at = excluded.last_activity_at,
                archived = excluded.archived,
                completed_turns = excluded.completed_turns,
                model = excluded.model,
                effort = excluded.effort,
                cwd = excluded.cwd,
                origin_cwd = excluded.origin_cwd,
                worktree_path = excluded.worktree_path,
                branch = excluded.branch,
                source_branch = excluded.source_branch,
                written_branches_json = excluded.written_branches_json,
                status_category = excluded.status_category,
                status_detail = excluded.status_detail,
                needs_action = excluded.needs_action,
                summarizes_uuid = excluded.summarizes_uuid,
                wrap_up_description = excluded.wrap_up_description,
                last_turn_report = excluded.last_turn_report,
                spawned_from_session_id = excluded.spawned_from_session_id,
                spawned_from_task_id = excluded.spawned_from_task_id,
                spawned_from_title = excluded.spawned_from_title,
                spawned_from_side_session = excluded.spawned_from_side_session,
                open_suggestions_json = excluded.open_suggestions_json,
                resolved_suggestions_json = excluded.resolved_suggestions_json,
                declared_pull_requests_json = excluded.declared_pull_requests_json,
                side_session_notes_json = excluded.side_session_notes_json,
                last_imported_at = excluded.last_imported_at,
                latest_user_frame_at = excluded.latest_user_frame_at
            `);
            const currentDeclaration = db.query(`
              SELECT 1 AS present FROM claude_desktop_turn_declarations
              WHERE machine_id = ? AND desktop_session_id = ? AND declaration_key = ? AND superseded_at IS NULL
            `);
            const sessionDeclarations = db.query(`
              SELECT machine_id, desktop_session_id, declaration_key, status_category, status_detail, needs_action,
                declared_at, first_observed_at, replied_at, superseded_at, superseded_by_key
              FROM claude_desktop_turn_declarations
              WHERE machine_id = ? AND desktop_session_id = ?
            `);
            const upsertDeclaration = db.query(`
              INSERT INTO claude_desktop_turn_declarations (
                machine_id, desktop_session_id, declaration_key, status_category, status_detail, needs_action,
                declared_at, first_observed_at, replied_at, superseded_at, superseded_by_key
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(machine_id, desktop_session_id, declaration_key) DO UPDATE SET
                status_category = excluded.status_category,
                status_detail = excluded.status_detail,
                needs_action = excluded.needs_action,
                declared_at = excluded.declared_at,
                first_observed_at = excluded.first_observed_at,
                replied_at = excluded.replied_at,
                superseded_at = excluded.superseded_at,
                superseded_by_key = excluded.superseded_by_key
            `);
            const deleteDeclaration = db.query(`
              DELETE FROM claude_desktop_turn_declarations
              WHERE machine_id = ? AND desktop_session_id = ? AND declaration_key = ?
            `);
            /**
             * Advances the session's declaration history with this sweep and writes only the rows
             * that moved. A stored row the contract refuses is not read into the history; the read
             * counts it as refused, and this sweep's own observation replaces it only when it names
             * the same declaration.
             */
            const recordDeclarationHistory = (observation: ClaudeDesktopSessionObservation): void => {
              const records = sessionDeclarations.all(
                observation.machineId,
                observation.desktopSessionId,
              ) as ClaudeDesktopTurnDeclarationRecord[];
              const stored = new Map<string, ClaudeDesktopTurnDeclaration>();
              for (const record of records) {
                const declaration = declarationFromRecord(record);
                if (declaration !== null) {
                  stored.set(declaration.declarationKey, declaration);
                }
              }
              const next = advanceClaudeDesktopDeclarationHistory([...stored.values()], observation);
              const kept = new Set(next.map((row) => row.declarationKey));
              for (const key of stored.keys()) {
                if (!kept.has(key)) {
                  deleteDeclaration.run(observation.machineId, observation.desktopSessionId, key);
                }
              }
              for (const row of next) {
                const previous = stored.get(row.declarationKey);
                if (previous !== undefined && sameDeclaration(previous, row)) {
                  continue;
                }
                upsertDeclaration.run(
                  row.machineId,
                  row.desktopSessionId,
                  row.declarationKey,
                  row.status,
                  row.detail,
                  row.needsAction,
                  row.declaredAt,
                  row.firstObservedAt,
                  row.repliedAt,
                  row.supersededAt,
                  row.supersededByKey,
                );
              }
            };
            for (const candidate of input.observations) {
              const observation = parseClaudeDesktopSessionObservation(candidate);
              if (observation === null || observation.machineId !== input.machineId) {
                // A malformed candidate, or one that names another machine, is counted: the
                // collector that produced it is the thing to fix.
                result.skipped++;
                continue;
              }
              const contentHash = claudeDesktopSessionContentHash(observation);
              const stored = existing.get(input.machineId, observation.desktopSessionId) as StoredIdentityRecord | null;
              if (
                stored !== null &&
                stored.content_hash === contentHash &&
                stored.file_modified_at === observation.fileModifiedAt
              ) {
                result.unchanged++;
                // An unchanged file changes no declaration, unless its current one was never recorded
                // (a store from before the history existed): then the history starts from this sweep.
                if (
                  observation.turnSummary !== null &&
                  currentDeclaration.get(
                    input.machineId,
                    observation.desktopSessionId,
                    claudeDesktopDeclarationKey(observation.turnSummary),
                  ) === null
                ) {
                  recordDeclarationHistory(observation);
                }
                continue;
              }
              upsert.run(
                observation.machineId,
                observation.desktopSessionId,
                observation.accountDirectory,
                observation.organizationDirectory,
                observation.cliSessionId,
                JSON.stringify(observation.priorCliSessionIds),
                observation.filePath,
                observation.fileModifiedAt,
                observation.observedAt,
                observation.format,
                observation.unsupportedReason,
                contentHash,
                observation.title,
                observation.titleSource,
                observation.createdAt,
                observation.lastActivityAt,
                booleanColumn(observation.archived),
                observation.completedTurns,
                observation.model,
                observation.effort,
                observation.cwd,
                observation.originCwd,
                observation.worktreePath,
                observation.branch,
                observation.sourceBranch,
                JSON.stringify(observation.writtenBranches),
                observation.turnSummary?.status ?? null,
                observation.turnSummary?.detail ?? null,
                observation.turnSummary?.needsAction ?? null,
                observation.turnSummary?.summarizesUuid ?? null,
                observation.wrapUpDescription,
                observation.lastTurnReport,
                observation.spawnedFrom?.sessionId ?? null,
                observation.spawnedFrom?.taskId ?? null,
                observation.spawnedFrom?.title ?? null,
                booleanColumn(observation.spawnedFrom?.sideSession ?? null),
                JSON.stringify(observation.openSuggestions),
                JSON.stringify(observation.resolvedSuggestions),
                JSON.stringify(observation.declaredPullRequests),
                JSON.stringify(observation.sideSessionNotes),
                importedAt,
                importedAt,
                observation.latestUserFrameAt,
              );
              if (stored === null) {
                result.inserted++;
              } else {
                result.updated++;
              }
              recordDeclarationHistory(observation);
            }
            db.query(`
              INSERT INTO claude_desktop_collection_state (
                machine_id, collected_at, files_seen, files_parsed, unsupported, rejected, truncated
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(machine_id) DO UPDATE SET
                collected_at = excluded.collected_at,
                files_seen = excluded.files_seen,
                files_parsed = excluded.files_parsed,
                unsupported = excluded.unsupported,
                rejected = excluded.rejected,
                truncated = excluded.truncated
            `).run(
              input.machineId,
              importedAt,
              input.completeness.filesSeen,
              input.completeness.filesParsed,
              input.completeness.unsupported,
              input.completeness.rejected,
              Number(input.completeness.truncated),
            );
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          return result;
        },
        catch: (cause) =>
          cause instanceof UsageStoreError
            ? cause
            : usageStoreError('importClaudeDesktopSessions', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

  /**
   * Most recently active first. Asks for `limit + 1` and reports the overflow, so a page that stops
   * exactly at its budget is distinguishable from a complete one.
   */
  const queryClaudeDesktopSessions = (
    input: QueryClaudeDesktopSessionsInput,
  ): Effect.Effect<QueryClaudeDesktopSessionsResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const limit = input.limit ?? MAX_CLAUDE_DESKTOP_SESSION_READ;
          const since =
            input.sinceLastActivityAt === undefined ? undefined : normalizeIsoTimestamp(input.sinceLastActivityAt);
          const olderThan =
            input.olderThanLastActivityAt === undefined
              ? undefined
              : normalizeIsoTimestamp(input.olderThanLastActivityAt);
          const ids = input.desktopSessionIds;
          if (
            !(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_CLAUDE_DESKTOP_SESSION_READ) ||
            since === null ||
            olderThan === null ||
            (ids !== undefined &&
              (ids.length > MAX_CLAUDE_DESKTOP_SESSION_ID_FILTER || ids.some((id) => id.trim().length === 0))) ||
            (input.machineId !== undefined && input.machineId.trim().length === 0) ||
            (input.scope !== undefined && !validWorkSessionReadScope(input.scope))
          ) {
            throw usageStoreError(
              'queryClaudeDesktopSessions',
              input.dbPath,
              'Claude Desktop session query bounds are invalid',
              'invalid-input',
            );
          }
          if (ids !== undefined && ids.length === 0) {
            // An empty id filter selects nothing; it never widens into "every session".
            return { observations: [], skipped: 0, truncated: false };
          }
          const clauses: string[] = [];
          const params: unknown[] = [];
          if (input.scope !== undefined) {
            const scoped = workSessionScopeSql(input.scope, {
              checkout: 'coalesce(worktree_path, cwd)',
              project: 'coalesce(origin_cwd, cwd)',
            });
            clauses.push(scoped.sql);
            params.push(...scoped.params);
          }
          if (input.machineId !== undefined) {
            clauses.push('machine_id = ?');
            params.push(input.machineId);
          }
          if (since !== undefined) {
            clauses.push('last_activity_at >= ?');
            params.push(since);
          }
          if (olderThan !== undefined) {
            clauses.push('last_activity_at < ?');
            params.push(olderThan);
          }
          if (input.pendingOnly === true) {
            clauses.push(
              `(status_category IN (${PENDING_STATUS_CATEGORIES.map(() => '?').join(', ')}) OR declared_pull_requests_json <> '[]')`,
            );
            params.push(...PENDING_STATUS_CATEGORIES);
          }
          if (ids !== undefined) {
            clauses.push(`desktop_session_id IN (${ids.map(() => '?').join(', ')})`);
            params.push(...ids);
          }
          const sql = `
            SELECT * FROM claude_desktop_sessions
            ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
            ORDER BY last_activity_at DESC, id DESC
            LIMIT ?
          `;
          const queryParams = [...params, limit + 1];
          input.trace?.({ params: queryParams, sql });
          const rows = db.query(sql).all(...queryParams) as ClaudeDesktopSessionRecord[];
          const observations: ClaudeDesktopSessionObservation[] = [];
          let skipped = 0;
          for (const row of rows.slice(0, limit)) {
            const observation = observationFromRecord(row);
            if (observation === null) {
              skipped++;
            } else {
              observations.push(observation);
            }
          }
          return { observations, skipped, truncated: rows.length > limit };
        },
        catch: (cause) => usageStoreReadError('queryClaudeDesktopSessions', input.dbPath, cause),
      }),
    );

  /**
   * The recorded declarations of the named sessions, oldest first within each session. Bounded by
   * the id filter and by `maxDeclarationsPerSession` per session, which the import enforces.
   */
  const queryClaudeDesktopTurnDeclarations = (
    input: QueryClaudeDesktopTurnDeclarationsInput,
  ): Effect.Effect<QueryClaudeDesktopTurnDeclarationsResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const ids = input.desktopSessionIds;
          if (
            ids.length > MAX_CLAUDE_DESKTOP_SESSION_ID_FILTER ||
            ids.some((id) => id.trim().length === 0) ||
            (input.machineId !== undefined && input.machineId.trim().length === 0)
          ) {
            throw usageStoreError(
              'queryClaudeDesktopTurnDeclarations',
              input.dbPath,
              'Claude Desktop declaration query bounds are invalid',
              'invalid-input',
            );
          }
          if (ids.length === 0) {
            return { declarations: [], skipped: 0 };
          }
          // The query-only reader cannot create the table (ADR 0056): a store the engine has not
          // reopened since is reported as typed `schema-too-old`, never as a raw storage failure.
          if (
            db
              .query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'claude_desktop_turn_declarations'")
              .get() === null
          ) {
            throw usageStoreError(
              'queryClaudeDesktopTurnDeclarations',
              input.dbPath,
              'The usage store has not been upgraded for the declaration history yet; it is upgraded at the next engine start',
              'schema-too-old',
            );
          }
          const clauses = [`desktop_session_id IN (${ids.map(() => '?').join(', ')})`];
          const params: unknown[] = [...ids];
          if (input.machineId !== undefined) {
            clauses.push('machine_id = ?');
            params.push(input.machineId);
          }
          const rows = db
            .query(`
              SELECT machine_id, desktop_session_id, declaration_key, status_category, status_detail, needs_action,
                declared_at, first_observed_at, replied_at, superseded_at, superseded_by_key
              FROM claude_desktop_turn_declarations
              WHERE ${clauses.join(' AND ')}
              ORDER BY machine_id, desktop_session_id, declared_at, declaration_key
              LIMIT ?
            `)
            .all(
              ...params,
              ids.length * WORK_ATTENTION_BOUNDS.maxDeclarationsPerSession,
            ) as ClaudeDesktopTurnDeclarationRecord[];
          const declarations: ClaudeDesktopTurnDeclaration[] = [];
          let skipped = 0;
          for (const row of rows) {
            const declaration = declarationFromRecord(row);
            if (declaration === null) {
              skipped++;
            } else {
              declarations.push(declaration);
            }
          }
          return { declarations, skipped };
        },
        catch: (cause) => usageStoreReadError('queryClaudeDesktopTurnDeclarations', input.dbPath, cause),
      }),
    );

  /** How many desktop sessions are stored, for one machine or all; the Work read states what it left out. */
  const countClaudeDesktopSessions = (input: {
    readonly dbPath: string;
    readonly machineId?: string;
    readonly scope?: WorkSessionReadScope;
  }): Effect.Effect<number, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          if (input.scope !== undefined && !validWorkSessionReadScope(input.scope)) {
            throw usageStoreError('countClaudeDesktopSessions', input.dbPath, 'Invalid Work scope', 'invalid-input');
          }
          const scope =
            input.scope === undefined
              ? null
              : workSessionScopeSql(input.scope, {
                  checkout: 'coalesce(worktree_path, cwd)',
                  project: 'coalesce(origin_cwd, cwd)',
                });
          const clauses = [
            ...(input.machineId === undefined ? [] : ['machine_id = ?']),
            ...(scope === null ? [] : [scope.sql]),
          ];
          const row = db
            .query(
              `SELECT COUNT(*) AS count FROM claude_desktop_sessions ${clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`}`,
            )
            .get(...(input.machineId === undefined ? [] : [input.machineId]), ...(scope?.params ?? [])) as {
            count: number;
          };
          return row.count;
        },
        catch: (cause) => usageStoreReadError('countClaudeDesktopSessions', input.dbPath, cause),
      }),
    );

  const queryClaudeDesktopCollectionState = (
    input: QueryClaudeDesktopCollectionStateInput,
  ): Effect.Effect<QueryClaudeDesktopCollectionStateResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const sql = `
            SELECT machine_id, collected_at, files_seen, files_parsed, unsupported, rejected, truncated
            FROM claude_desktop_collection_state
            ${input.machineId === undefined ? '' : 'WHERE machine_id = ?'}
            ORDER BY machine_id
            LIMIT ?
          `;
          const params =
            input.machineId === undefined ? [MAX_COLLECTION_STATES] : [input.machineId, MAX_COLLECTION_STATES];
          const rows = db.query(sql).all(...params) as ClaudeDesktopCollectionStateRecord[];
          return { states: rows.flatMap((row) => stateFromRecord(row) ?? []) };
        },
        catch: (cause) => usageStoreReadError('queryClaudeDesktopCollectionState', input.dbPath, cause),
      }),
    );

  return {
    countClaudeDesktopSessions,
    importClaudeDesktopSessions,
    queryClaudeDesktopCollectionState,
    queryClaudeDesktopSessions,
    queryClaudeDesktopTurnDeclarations,
  };
};
