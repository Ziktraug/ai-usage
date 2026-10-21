import { randomUUID } from 'node:crypto';
import {
  parseReviewAttempt,
  REVIEW_ATTEMPT_ACTION,
  REVIEW_ATTEMPT_BOUNDS,
  REVIEW_ATTEMPT_LIVE_STATES,
  type ReviewAttempt,
  type ReviewAttemptResultKind,
  type ReviewAttemptState,
  type ReviewAttemptTarget,
} from '@ai-usage/report-core/work-attempts';
import {
  type ExecutorDeclaration,
  type ExecutorHarness,
  parseExecutorDeclarations,
} from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import type { UsageStoreError, UsageStoreErrorReason } from './errors';

/**
 * Durable storage for review attempts (ADR 0053): the executions the product launched itself.
 * One row per attempt, written only by the engine and re-validated on the way out with the shared
 * `parseReviewAttempt`, so a tightened bound hides history rather than serving it.
 *
 * Three properties are load-bearing:
 *
 * - **One live attempt per identity.** A partial unique index on `idempotency_key` over the live
 *   states (`requested`, `starting`, `running`) makes a second request return the existing row
 *   instead of inserting a twin, whatever raced it.
 * - **Transitions are guarded.** A state write names the states it may leave from; a late
 *   heartbeat cannot resurrect a finished or lost attempt.
 * - **Outside the served revision.** Attempts never advance the store generation, never enter a
 *   publication, a snapshot or the replication outbox. They describe this machine only.
 */
export const REVIEW_ATTEMPT_TABLES = ['review_attempts'] as const;

export const reviewAttemptSchemaSql = `
  CREATE TABLE IF NOT EXISTS review_attempts (
    attempt_id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('read-only-review')),
    target_harness TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    desktop_session_id TEXT,
    checkout_path TEXT,
    checkout_origin TEXT CHECK (checkout_origin IS NULL OR checkout_origin IN ('desktop-worktree', 'desktop-cwd', 'served-session')),
    project_label TEXT,
    session_title TEXT,
    candidate_id TEXT NOT NULL,
    executor_harness TEXT NOT NULL CHECK (executor_harness IN ('claude-code', 'codex')),
    declaration_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('requested', 'starting', 'running', 'finished', 'failed', 'refused', 'lost')),
    requested_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL,
    native_session_id TEXT,
    pid INTEGER,
    exit_code INTEGER,
    result_kind TEXT CHECK (result_kind IS NULL OR result_kind IN ('review', 'error', 'timeout')),
    result_excerpt TEXT,
    num_turns INTEGER,
    duration_ms INTEGER,
    validations_json TEXT NOT NULL DEFAULT '[]',
    acceptance TEXT NOT NULL DEFAULT 'pending' CHECK (acceptance IN ('pending', 'accepted', 'rejected')),
    failure_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_review_attempts_target
    ON review_attempts(machine_id, target_harness, source_session_id, requested_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_attempts_live_identity
    ON review_attempts(idempotency_key)
    WHERE state IN ('requested', 'starting', 'running');
`;

export interface NewReviewAttempt {
  /** Defaults to a fresh UUID; tests may pin it. */
  readonly attemptId?: string;
  readonly candidateId: string;
  readonly declaration: ExecutorDeclaration | null;
  readonly executorHarness: ExecutorHarness;
  readonly failureReason?: string | null;
  readonly idempotencyKey: string;
  readonly machineId: string;
  readonly requestedAt: string;
  /** `requested` opens a live attempt; `refused` records a decision that launched nothing. */
  readonly state: 'refused' | 'requested';
  readonly target: ReviewAttemptTarget;
}

export interface RequestReviewAttemptInput {
  readonly attempt: NewReviewAttempt;
  readonly dbPath: string;
}

export interface RequestReviewAttemptResult {
  readonly attempt: ReviewAttempt;
  /** The identity already had a live attempt; nothing was inserted. */
  readonly reused: boolean;
}

export interface ReviewAttemptPatch {
  readonly durationMs?: number | null;
  readonly endedAt?: string | null;
  readonly exitCode?: number | null;
  readonly failureReason?: string | null;
  readonly nativeSessionId?: string | null;
  readonly numTurns?: number | null;
  readonly pid?: number | null;
  readonly resultExcerpt?: string | null;
  readonly resultKind?: ReviewAttemptResultKind | null;
  readonly startedAt?: string | null;
  readonly state?: ReviewAttemptState;
  readonly validations?: readonly string[];
}

export interface TransitionReviewAttemptInput {
  /** Becomes `updated_at`; a heartbeat is a transition with an empty patch. */
  readonly at: string;
  readonly attemptId: string;
  readonly dbPath: string;
  /** The transition applies only when the row is in one of these states; defaults to the live states. */
  readonly fromStates?: readonly ReviewAttemptState[];
  readonly patch: ReviewAttemptPatch;
}

export interface TransitionReviewAttemptResult {
  readonly applied: boolean;
}

export interface MarkReviewAttemptsLostInput {
  readonly at: string;
  readonly dbPath: string;
  readonly machineId: string;
  /** Bounded, per attempt; typically names why contact was lost (engine restart, shutdown). */
  readonly reason: (attempt: {
    readonly attemptId: string;
    readonly pid: number | null;
    readonly state: ReviewAttemptState;
  }) => string;
}

export interface MarkReviewAttemptsLostResult {
  readonly lost: readonly string[];
}

export interface QueryReviewAttemptsInput {
  readonly dbPath: string;
  /** Rows returned at most; defaults to and may not exceed `REVIEW_ATTEMPT_BOUNDS.maxListLimit`. */
  readonly limit?: number;
  readonly machineId?: string;
  readonly states?: readonly ReviewAttemptState[];
  readonly target?: { readonly harness: string; readonly sourceSessionId: string };
}

export interface QueryReviewAttemptsResult {
  /** Newest request first. */
  readonly attempts: readonly ReviewAttempt[];
  /** Persisted rows that no longer pass validation. Never silently omitted. */
  readonly skipped: number;
  readonly truncated: boolean;
}

export interface QueryReviewTargetResolutionInput {
  readonly dbPath: string;
  readonly desktopSessionId?: string | null;
  readonly harness: string;
  readonly machineId: string;
  readonly sourceSessionId: string;
}

export interface ReviewTargetResolutionFacts {
  /** The Claude Desktop session that declared this transcript (by desktop id, else by transcript id). */
  readonly desktop: {
    readonly cwd: string | null;
    readonly desktopSessionId: string;
    readonly title: string | null;
    readonly worktreePath: string | null;
  } | null;
  /** The served Session row for the native session at the current revision. */
  readonly session: {
    readonly name: string | null;
    readonly projectLabel: string | null;
    readonly sourcePath: string | null;
  } | null;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): unknown;
  query(sql: string): SqliteStatement;
}

interface ReviewAttemptStoreDependencies {
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

interface ReviewAttemptRecord {
  acceptance: string;
  action: string;
  attempt_id: string;
  candidate_id: string;
  checkout_origin: string | null;
  checkout_path: string | null;
  declaration_json: string | null;
  desktop_session_id: string | null;
  duration_ms: number | null;
  ended_at: string | null;
  executor_harness: string;
  exit_code: number | null;
  failure_reason: string | null;
  idempotency_key: string;
  machine_id: string;
  native_session_id: string | null;
  num_turns: number | null;
  pid: number | null;
  project_label: string | null;
  requested_at: string;
  result_excerpt: string | null;
  result_kind: string | null;
  session_title: string | null;
  source_session_id: string;
  started_at: string | null;
  state: string;
  target_harness: string;
  updated_at: string;
  validations_json: string;
}

const SELECT_COLUMNS = `
  attempt_id, machine_id, idempotency_key, action, target_harness, source_session_id, desktop_session_id,
  checkout_path, checkout_origin, project_label, session_title, candidate_id, executor_harness, declaration_json,
  state, requested_at, started_at, ended_at, updated_at, native_session_id, pid, exit_code, result_kind,
  result_excerpt, num_turns, duration_ms, validations_json, acceptance, failure_reason
`;

const parseJsonOrNull = (text: string | null): unknown => {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return;
  }
};

const declarationFromJson = (text: string | null, machineId: string): ExecutorDeclaration | null => {
  const value = parseJsonOrNull(text);
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = parseExecutorDeclarations({ executors: [value] }, { defaultMachineId: machineId });
  return parsed.declarations[0] ?? null;
};

const attemptFromRecord = (record: ReviewAttemptRecord): ReviewAttempt | null => {
  const validations = parseJsonOrNull(record.validations_json);
  return parseReviewAttempt({
    acceptance: record.acceptance,
    action: record.action,
    attemptId: record.attempt_id,
    candidateId: record.candidate_id,
    declaration: declarationFromJson(record.declaration_json, record.machine_id),
    durationMs: record.duration_ms,
    endedAt: record.ended_at,
    executorHarness: record.executor_harness,
    exitCode: record.exit_code,
    failureReason: record.failure_reason,
    idempotencyKey: record.idempotency_key,
    machineId: record.machine_id,
    nativeSessionId: record.native_session_id,
    numTurns: record.num_turns,
    pid: record.pid,
    requestedAt: record.requested_at,
    resultExcerpt: record.result_excerpt,
    resultKind: record.result_kind,
    startedAt: record.started_at,
    state: record.state,
    target: {
      checkoutOrigin: record.checkout_origin,
      checkoutPath: record.checkout_path,
      desktopSessionId: record.desktop_session_id,
      harness: record.target_harness,
      projectLabel: record.project_label,
      sessionTitle: record.session_title,
      sourceSessionId: record.source_session_id,
    },
    updatedAt: record.updated_at,
    validations: validations === undefined ? null : validations,
  });
};

const boundedOrNull = (value: string | null | undefined, maximum: number): string | null =>
  value === null || value === undefined ? null : value.slice(0, maximum);

const readAttempt = (db: SqliteDatabase, attemptId: string): ReviewAttempt | null => {
  const record = db
    .query(`SELECT ${SELECT_COLUMNS} FROM review_attempts WHERE attempt_id = ?`)
    .get(attemptId) as ReviewAttemptRecord | null;
  return record === null ? null : attemptFromRecord(record);
};

const PATCH_COLUMNS: Readonly<Record<keyof ReviewAttemptPatch, string>> = {
  durationMs: 'duration_ms',
  endedAt: 'ended_at',
  exitCode: 'exit_code',
  failureReason: 'failure_reason',
  nativeSessionId: 'native_session_id',
  numTurns: 'num_turns',
  pid: 'pid',
  resultExcerpt: 'result_excerpt',
  resultKind: 'result_kind',
  startedAt: 'started_at',
  state: 'state',
  validations: 'validations_json',
};

const patchValue = (key: keyof ReviewAttemptPatch, value: unknown): unknown => {
  if (key === 'validations') {
    return JSON.stringify(Array.isArray(value) ? value.slice(0, REVIEW_ATTEMPT_BOUNDS.maxValidations) : []);
  }
  if (key === 'failureReason') {
    return boundedOrNull(value as string | null, REVIEW_ATTEMPT_BOUNDS.maxFailureReason);
  }
  if (key === 'resultExcerpt') {
    return boundedOrNull(value as string | null, REVIEW_ATTEMPT_BOUNDS.maxExcerpt);
  }
  return value ?? null;
};

export const createReviewAttemptStore = (dependencies: ReviewAttemptStoreDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader, withUsageStoreWriter } = dependencies;

  const requestReviewAttempt = (
    input: RequestReviewAttemptInput,
  ): Effect.Effect<RequestReviewAttemptResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const { attempt } = input;
          db.exec('BEGIN IMMEDIATE');
          try {
            if (attempt.state === 'requested') {
              const live = db
                .query(
                  `SELECT ${SELECT_COLUMNS} FROM review_attempts WHERE idempotency_key = ? AND state IN ('requested', 'starting', 'running') LIMIT 1`,
                )
                .get(attempt.idempotencyKey) as ReviewAttemptRecord | null;
              if (live !== null) {
                const existing = attemptFromRecord(live);
                db.exec('COMMIT');
                if (existing === null) {
                  throw new Error(`Live review attempt ${live.attempt_id} does not satisfy its own contract`);
                }
                return { attempt: existing, reused: true };
              }
            }
            const attemptId = attempt.attemptId ?? randomUUID();
            const declarationJson = attempt.declaration === null ? null : JSON.stringify(attempt.declaration);
            if (declarationJson !== null && declarationJson.length > REVIEW_ATTEMPT_BOUNDS.maxDeclarationJson) {
              throw new Error('Review attempt declaration snapshot exceeds its bound');
            }
            db.query(`
              INSERT INTO review_attempts (
                attempt_id, machine_id, idempotency_key, action, target_harness, source_session_id, desktop_session_id,
                checkout_path, checkout_origin, project_label, session_title, candidate_id, executor_harness,
                declaration_json, state, requested_at, updated_at, validations_json, acceptance, failure_reason
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'pending', ?)
            `).run(
              attemptId,
              attempt.machineId,
              attempt.idempotencyKey,
              REVIEW_ATTEMPT_ACTION,
              attempt.target.harness,
              attempt.target.sourceSessionId,
              attempt.target.desktopSessionId,
              attempt.target.checkoutPath,
              attempt.target.checkoutOrigin,
              boundedOrNull(attempt.target.projectLabel, REVIEW_ATTEMPT_BOUNDS.maxText),
              boundedOrNull(attempt.target.sessionTitle, REVIEW_ATTEMPT_BOUNDS.maxText),
              attempt.candidateId,
              attempt.executorHarness,
              declarationJson,
              attempt.state,
              attempt.requestedAt,
              attempt.requestedAt,
              boundedOrNull(attempt.failureReason, REVIEW_ATTEMPT_BOUNDS.maxFailureReason),
            );
            const inserted = readAttempt(db, attemptId);
            db.exec('COMMIT');
            if (inserted === null) {
              throw new Error(`Review attempt ${attemptId} does not satisfy its own contract after insert`);
            }
            return { attempt: inserted, reused: false };
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
        catch: (cause) => usageStoreError('requestReviewAttempt', input.dbPath, cause, 'storage-failure'),
      }),
    );

  const transitionReviewAttempt = (
    input: TransitionReviewAttemptInput,
  ): Effect.Effect<TransitionReviewAttemptResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const fromStates = input.fromStates ?? REVIEW_ATTEMPT_LIVE_STATES;
          if (fromStates.length === 0) {
            return { applied: false };
          }
          const assignments: string[] = ['updated_at = ?'];
          const values: unknown[] = [input.at];
          for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof ReviewAttemptPatch, string][]) {
            if (!(key in input.patch)) {
              continue;
            }
            assignments.push(`${column} = ?`);
            values.push(patchValue(key, input.patch[key]));
          }
          db.query(`
            UPDATE review_attempts
            SET ${assignments.join(', ')}
            WHERE attempt_id = ? AND state IN (${fromStates.map(() => '?').join(', ')})
          `).run(...values, input.attemptId, ...fromStates);
          const changed = (db.query('SELECT changes() AS changed').get() as { changed: number }).changed;
          return { applied: changed > 0 };
        },
        catch: (cause) => usageStoreError('transitionReviewAttempt', input.dbPath, cause, 'storage-failure'),
      }),
    );

  const markReviewAttemptsLost = (
    input: MarkReviewAttemptsLostInput,
  ): Effect.Effect<MarkReviewAttemptsLostResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          db.exec('BEGIN IMMEDIATE');
          try {
            const live = db
              .query(
                `SELECT attempt_id, pid, state FROM review_attempts WHERE machine_id = ? AND state IN ('requested', 'starting', 'running') ORDER BY requested_at`,
              )
              .all(input.machineId) as { attempt_id: string; pid: number | null; state: ReviewAttemptState }[];
            const update = db.query(`
              UPDATE review_attempts
              SET state = 'lost', ended_at = COALESCE(ended_at, ?), updated_at = ?, failure_reason = ?
              WHERE attempt_id = ? AND state IN ('requested', 'starting', 'running')
            `);
            const lost: string[] = [];
            for (const row of live) {
              const reason = input
                .reason({ attemptId: row.attempt_id, pid: row.pid, state: row.state })
                .slice(0, REVIEW_ATTEMPT_BOUNDS.maxFailureReason);
              update.run(input.at, input.at, reason, row.attempt_id);
              lost.push(row.attempt_id);
            }
            db.exec('COMMIT');
            return { lost };
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
        catch: (cause) => usageStoreError('markReviewAttemptsLost', input.dbPath, cause, 'storage-failure'),
      }),
    );

  const queryReviewAttempts = (
    input: QueryReviewAttemptsInput,
  ): Effect.Effect<QueryReviewAttemptsResult, UsageStoreError> => {
    const limit = input.limit ?? REVIEW_ATTEMPT_BOUNDS.maxListLimit;
    if (!(Number.isSafeInteger(limit) && limit > 0 && limit <= REVIEW_ATTEMPT_BOUNDS.maxListLimit)) {
      return Effect.fail(
        usageStoreError(
          'queryReviewAttempts',
          input.dbPath,
          `Review attempt limit must be between 1 and ${REVIEW_ATTEMPT_BOUNDS.maxListLimit}`,
          'invalid-input',
        ),
      );
    }
    const states = input.states ?? [];
    return withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const clauses: string[] = [];
          const params: unknown[] = [];
          if (input.machineId !== undefined) {
            clauses.push('machine_id = ?');
            params.push(input.machineId);
          }
          if (input.target !== undefined) {
            clauses.push('target_harness = ? AND source_session_id = ?');
            params.push(input.target.harness, input.target.sourceSessionId);
          }
          if (states.length > 0) {
            clauses.push(`state IN (${states.map(() => '?').join(', ')})`);
            params.push(...states);
          }
          const rows = db
            .query(`
              SELECT ${SELECT_COLUMNS} FROM review_attempts
              ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
              ORDER BY requested_at DESC, attempt_id DESC
              LIMIT ?
            `)
            .all(...params, limit + 1) as ReviewAttemptRecord[];
          const attempts: ReviewAttempt[] = [];
          let skipped = 0;
          for (const row of rows.slice(0, limit)) {
            const attempt = attemptFromRecord(row);
            if (attempt) {
              attempts.push(attempt);
            } else {
              skipped++;
            }
          }
          return { attempts, skipped, truncated: rows.length > limit };
        },
        catch: (cause) => usageStoreReadError('queryReviewAttempts', input.dbPath, cause),
      }),
    );
  };

  const queryReviewTargetResolution = (
    input: QueryReviewTargetResolutionInput,
  ): Effect.Effect<ReviewTargetResolutionFacts, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const desktopSessionId = input.desktopSessionId ?? null;
          const desktopRecord =
            input.harness === 'claude' || desktopSessionId !== null
              ? (db
                  .query(`
                    SELECT desktop_session_id, cwd, worktree_path, title
                    FROM claude_desktop_sessions
                    WHERE machine_id = ? AND (desktop_session_id = ? OR cli_session_id = ?)
                    ORDER BY (desktop_session_id = ?) DESC, last_activity_at DESC, id DESC
                    LIMIT 1
                  `)
                  .get(
                    input.machineId,
                    desktopSessionId ?? '',
                    input.harness === 'claude' ? input.sourceSessionId : '',
                    desktopSessionId ?? '',
                  ) as {
                  cwd: string | null;
                  desktop_session_id: string;
                  title: string | null;
                  worktree_path: string | null;
                } | null)
              : null;
          const current = db
            .query(`
              SELECT revisions.revision AS revision
              FROM served_report_current AS current
              INNER JOIN served_report_revisions AS revisions USING (revision)
              WHERE current.singleton = 1 AND revisions.complete = 1
            `)
            .get() as { revision: string } | null;
          const sessionRecord =
            current === null
              ? null
              : (db
                  .query(`
                    SELECT
                      project_label,
                      json_extract(source_row_json, '$.source.sourcePath') AS source_path,
                      json_extract(source_row_json, '$.name') AS name
                    FROM served_report_rows
                    WHERE revision = ?
                      AND machine_id = ?
                      AND json_extract(source_row_json, '$.source.harnessKey') = ?
                      AND json_extract(source_row_json, '$.source.sourceSessionId') = ?
                    ORDER BY ordinal
                    LIMIT 1
                  `)
                  .get(current.revision, input.machineId, input.harness, input.sourceSessionId) as {
                  name: string | null;
                  project_label: string | null;
                  source_path: string | null;
                } | null);
          return {
            desktop:
              desktopRecord === null
                ? null
                : {
                    cwd: desktopRecord.cwd,
                    desktopSessionId: desktopRecord.desktop_session_id,
                    title: desktopRecord.title,
                    worktreePath: desktopRecord.worktree_path,
                  },
            session:
              sessionRecord === null
                ? null
                : {
                    name: typeof sessionRecord.name === 'string' ? sessionRecord.name : null,
                    projectLabel: sessionRecord.project_label,
                    sourcePath: typeof sessionRecord.source_path === 'string' ? sessionRecord.source_path : null,
                  },
          };
        },
        catch: (cause) => usageStoreReadError('queryReviewTargetResolution', input.dbPath, cause),
      }),
    );

  return {
    markReviewAttemptsLost,
    queryReviewAttempts,
    queryReviewTargetResolution,
    requestReviewAttempt,
    transitionReviewAttempt,
  };
};
