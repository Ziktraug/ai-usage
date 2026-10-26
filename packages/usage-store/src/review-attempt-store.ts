import { randomUUID } from 'node:crypto';
import {
  parseReviewAttempt,
  REVIEW_ATTEMPT_ACTION,
  REVIEW_ATTEMPT_BOUNDS,
  REVIEW_ATTEMPT_LIVE_STATES,
  REVIEW_RESERVATION_RELEASE_EVIDENCE,
  type ReviewAttempt,
  type ReviewAttemptResultKind,
  type ReviewAttemptScope,
  type ReviewAttemptState,
  type ReviewAttemptTarget,
  type ReviewHarnessGuarantee,
  type ReviewReservationReleaseEvidence,
} from '@ai-usage/report-core/work-attempts';
import {
  type ExecutorDeclaration,
  type ExecutorHarness,
  parseExecutorDeclarations,
} from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import type { UsageStoreError, UsageStoreErrorReason } from './errors';
import {
  checkReviewReservations,
  type ReviewReservationCheck,
  type ReviewReservationHolder,
  readReviewReservationHolders,
} from './review-reservations';

/**
 * Durable storage for review attempts (ADR 0053, 0055): the executions the product launched
 * itself. One row per attempt, written only by the engine and re-validated on the way out with the
 * shared `parseReviewAttempt`, so a tightened bound hides history rather than serving it.
 *
 * Four properties are load-bearing:
 *
 * - **One reservation per identity.** A partial unique index on `idempotency_key` over the live
 *   states and over `lost` rows not yet released makes a second request return the existing row
 *   instead of inserting a twin, whatever raced it. Losing contact with a process does not end it.
 * - **Release needs evidence.** A lost row is released only by a write that names its evidence
 *   (`process-absent`, `outcome-recorded-late`); nothing releases a row by age.
 * - **Transitions are guarded.** A state write names the states it may leave from; a late
 *   heartbeat cannot resurrect a finished or lost attempt.
 * - **Outside the served revision.** Attempts never advance the store generation, never enter a
 *   publication, a snapshot or the replication outbox. They describe this machine only.
 */
export const REVIEW_ATTEMPT_TABLES = ['review_attempts'] as const;

/** The reserving predicate, shared by the unique index and the reads that must agree with it. */
const RESERVING_SQL = "(state IN ('requested', 'starting', 'running') OR (state = 'lost' AND released_at IS NULL))";

/** The release evidence the table accepts; a stored table that predates a value is rebuilt. */
const RELEASE_EVIDENCE_SQL = `(${REVIEW_RESERVATION_RELEASE_EVIDENCE.map((evidence) => `'${evidence}'`).join(', ')})`;

const reviewAttemptColumnsSql = `
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
    native_turn_id TEXT,
    stop_requested_at TEXT,
    stop_confirmed_at TEXT,
    pid INTEGER,
    exit_code INTEGER,
    result_kind TEXT CHECK (result_kind IS NULL OR result_kind IN ('review', 'error', 'timeout')),
    result_excerpt TEXT,
    num_turns INTEGER,
    duration_ms INTEGER,
    validations_json TEXT NOT NULL DEFAULT '[]',
    acceptance TEXT NOT NULL DEFAULT 'pending' CHECK (acceptance IN ('pending', 'accepted', 'rejected')),
    failure_reason TEXT,
    launch_session_id TEXT,
    released_at TEXT,
    release_evidence TEXT CHECK (release_evidence IS NULL OR release_evidence IN ${RELEASE_EVIDENCE_SQL}),
    scope_json TEXT,
    guarantee_json TEXT,
    base_sha TEXT,
    head_sha TEXT
`;

const TARGET_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_review_attempts_target
    ON review_attempts(machine_id, target_harness, source_session_id, requested_at DESC);
`;

const reviewAttemptTableSql = `
  CREATE TABLE IF NOT EXISTS review_attempts (${reviewAttemptColumnsSql});
  ${TARGET_INDEX_SQL}
`;

/** Columns added after the first version of the table (ADR 0055), with their additive definitions. */
const ADDED_COLUMNS: readonly (readonly [string, string])[] = [
  ['launch_session_id', 'launch_session_id TEXT'],
  ['released_at', 'released_at TEXT'],
  [
    'release_evidence',
    `release_evidence TEXT CHECK (release_evidence IS NULL OR release_evidence IN ${RELEASE_EVIDENCE_SQL})`,
  ],
  ['scope_json', 'scope_json TEXT'],
  ['guarantee_json', 'guarantee_json TEXT'],
  // The revision frozen at request time (PR #73 F1): what the attempt reserves across both review
  // families, written before any spawn. Older rows keep NULL and reserve what their recorded scope
  // names, else their whole checkout (`review-reservations.ts`).
  ['base_sha', 'base_sha TEXT'],
  ['head_sha', 'head_sha TEXT'],
  ['native_turn_id', 'native_turn_id TEXT'],
  ['stop_requested_at', 'stop_requested_at TEXT'],
  ['stop_confirmed_at', 'stop_confirmed_at TEXT'],
];

interface MigrationDatabase {
  exec: (sql: string) => unknown;
  query: (sql: string) => { all: (...params: unknown[]) => unknown[]; get: (...params: unknown[]) => unknown };
}

/**
 * A column check cannot be altered in SQLite. A table whose `release_evidence` check predates a
 * value of `REVIEW_RESERVATION_RELEASE_EVIDENCE` (the operator declaration, ADR 0055) is rebuilt
 * under the same name with every row copied, inside the caller's migration transaction; its
 * indexes are recreated by the rest of the migration. `true` when a rebuild ran.
 */
const rebuildForReleaseEvidence = (db: MigrationDatabase): boolean => {
  const stored = db.query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'review_attempts'").get() as {
    sql?: unknown;
  } | null;
  if (typeof stored?.sql !== 'string' || stored.sql.includes(RELEASE_EVIDENCE_SQL)) {
    return false;
  }
  db.exec('DROP TABLE IF EXISTS review_attempts_rebuilt');
  db.exec(`CREATE TABLE review_attempts_rebuilt (${reviewAttemptColumnsSql})`);
  const names = (db.query('PRAGMA table_info(review_attempts_rebuilt)').all() as { name?: unknown }[])
    .map((column) => column.name)
    .filter((name): name is string => typeof name === 'string')
    .join(', ');
  db.exec(`INSERT INTO review_attempts_rebuilt (${names}) SELECT ${names} FROM review_attempts`);
  db.exec('DROP TABLE review_attempts');
  db.exec('ALTER TABLE review_attempts_rebuilt RENAME TO review_attempts');
  db.exec(TARGET_INDEX_SQL);
  return true;
};

/**
 * Creates or upgrades the table inside the caller's migration transaction; `true` when the schema
 * changed. Idempotent: a second open finds the columns and the index and changes nothing.
 *
 * A table from the first version gains the nullable columns; its `lost` rows were recorded by a
 * rule that kept no reservation, so they are released with `recorded-before-reservations` at the
 * instant they were marked lost, never with a process fact nobody observed. The first version's
 * live-only unique index is dropped and the reserving one created (an older binary that recreates
 * the old index alongside does not weaken the new one; it fails visibly on a held identity).
 */
export const migrateReviewAttemptSchema = (db: MigrationDatabase): boolean => {
  let changed = false;
  db.exec(reviewAttemptTableSql);
  const columns = new Set(
    (db.query('PRAGMA table_info(review_attempts)').all() as { name?: unknown }[]).map((column) => column.name),
  );
  for (const [name, definition] of ADDED_COLUMNS) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE review_attempts ADD COLUMN ${definition}`);
      changed = true;
    }
  }
  if (!columns.has('released_at')) {
    db.exec(`
      UPDATE review_attempts
      SET released_at = COALESCE(ended_at, updated_at), release_evidence = 'recorded-before-reservations'
      WHERE state = 'lost' AND released_at IS NULL
    `);
  }
  if (rebuildForReleaseEvidence(db)) {
    changed = true;
  }
  const hasIndex = (name: string): boolean =>
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name) !== null;
  if (hasIndex('idx_review_attempts_live_identity')) {
    db.exec('DROP INDEX idx_review_attempts_live_identity');
    changed = true;
  }
  if (!hasIndex('idx_review_attempts_reserved_identity')) {
    db.exec(
      `CREATE UNIQUE INDEX idx_review_attempts_reserved_identity ON review_attempts(idempotency_key) WHERE ${RESERVING_SQL}`,
    );
    changed = true;
  }
  return changed;
};

/**
 * What a `requested` attempt reserves, checked inside the insert transaction against both review
 * families (`review-reservations.ts`): the frozen revision it will review and the quota pool it
 * occupies, under the admitted route's concurrency limit.
 */
export interface ReviewAttemptReservation {
  readonly baseSha: string;
  readonly headSha: string;
  readonly maxConcurrent: number;
  readonly poolId: string;
}

interface NewReviewAttemptFields {
  /** Defaults to a fresh UUID; tests may pin it. */
  readonly attemptId?: string;
  readonly candidateId: string;
  readonly declaration: ExecutorDeclaration | null;
  readonly executorHarness: ExecutorHarness;
  readonly failureReason?: string | null;
  readonly idempotencyKey: string;
  /** The `--session-id` the launch will pass, chosen before any spawn; `null` for a refusal. */
  readonly launchSessionId?: string | null;
  readonly machineId: string;
  readonly requestedAt: string;
  readonly target: ReviewAttemptTarget;
}

/**
 * A row to record. A `requested` row opens a live attempt and must carry its reservation: no
 * caller opens a live attempt without the shared pool and target check, and `requestReviewAttempt`
 * refuses (typed `invalid-input`, nothing inserted) a `requested` row whose reservation it cannot
 * check. A `refused` row records a decision that launched nothing and reserves nothing.
 */
export type NewReviewAttempt =
  | (NewReviewAttemptFields & { readonly reservation: ReviewAttemptReservation; readonly state: 'requested' })
  | (NewReviewAttemptFields & { readonly reservation?: undefined; readonly state: 'refused' });

export interface RequestReviewAttemptInput {
  readonly attempt: NewReviewAttempt;
  readonly dbPath: string;
}

export type RequestReviewAttemptResult =
  /** The inserted row. */
  | { readonly attempt: ReviewAttempt; readonly kind: 'inserted'; readonly reused: false }
  /** The row already holding the identity's reservation (live, or lost and unreleased); nothing was inserted. */
  | { readonly attempt: ReviewAttempt; readonly kind: 'reused'; readonly reused: true }
  /** Another row of either family reserves the target; nothing was inserted. */
  | { readonly holder: ReviewReservationHolder; readonly kind: 'target-reserved'; readonly message: string }
  /** The pool has no slot left under the limit, both families counted; nothing was inserted. */
  | {
      readonly count: number;
      readonly holders: readonly ReviewReservationHolder[];
      readonly kind: 'pool-busy';
      readonly message: string;
    };

export interface ReviewAttemptPatch {
  readonly durationMs?: number | null;
  readonly endedAt?: string | null;
  readonly exitCode?: number | null;
  readonly failureReason?: string | null;
  readonly guarantee?: ReviewHarnessGuarantee | null;
  readonly nativeSessionId?: string | null;
  readonly nativeTurnId?: string | null;
  readonly numTurns?: number | null;
  readonly pid?: number | null;
  readonly resultExcerpt?: string | null;
  readonly resultKind?: ReviewAttemptResultKind | null;
  readonly scope?: ReviewAttemptScope | null;
  readonly startedAt?: string | null;
  readonly state?: ReviewAttemptState;
  readonly stopConfirmedAt?: string | null;
  readonly stopRequestedAt?: string | null;
  readonly validations?: readonly string[];
}

export interface ReleaseReviewAttemptReservationInput {
  /** Becomes `updated_at`, and `released_at` unless the row was already released. */
  readonly at: string;
  readonly attemptId: string;
  readonly dbPath: string;
  /** The first evidence recorded stands; a later release only adds outcome fields. */
  readonly evidence: Exclude<ReviewReservationReleaseEvidence, 'recorded-before-reservations'>;
  /** What the launching engine observed at the process's end, recorded on the lost row; never a state. */
  readonly outcome?: Omit<ReviewAttemptPatch, 'guarantee' | 'scope' | 'startedAt' | 'state'>;
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
  /** Only rows holding their identity's reservation, with the unique index's own predicate. */
  readonly reserving?: boolean;
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

export interface QueryReviewReservationsInput {
  readonly dbPath: string;
  readonly machineId: string;
}

export interface QueryReviewReservationsResult {
  /** Every reserving row of both families on the machine, earliest request first. */
  readonly holders: readonly ReviewReservationHolder[];
}

export interface QueryReviewTargetResolutionInput {
  readonly dbPath: string;
  /** When given, the Desktop row must carry both this id and `sourceSessionId`; a mismatch resolves no Desktop session. */
  readonly desktopSessionId?: string | null;
  readonly harness: string;
  readonly machineId: string;
  readonly sourceSessionId: string;
}

export interface ReviewTargetResolutionFacts {
  /**
   * The Claude Desktop session that declared this transcript (`cli_session_id`), and the one the
   * command named when it named one; `null` for another harness or when no row matches both.
   */
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
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

interface SqliteDatabase {
  exec: (sql: string) => unknown;
  query: (sql: string) => SqliteStatement;
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
  guarantee_json: string | null;
  idempotency_key: string;
  launch_session_id: string | null;
  machine_id: string;
  native_session_id: string | null;
  native_turn_id: string | null;
  num_turns: number | null;
  pid: number | null;
  project_label: string | null;
  release_evidence: string | null;
  released_at: string | null;
  requested_at: string;
  result_excerpt: string | null;
  result_kind: string | null;
  scope_json: string | null;
  session_title: string | null;
  source_session_id: string;
  started_at: string | null;
  state: string;
  stop_confirmed_at: string | null;
  stop_requested_at: string | null;
  target_harness: string;
  updated_at: string;
  validations_json: string;
}

const SELECT_COLUMNS = `
  attempt_id, machine_id, idempotency_key, action, target_harness, source_session_id, desktop_session_id,
  checkout_path, checkout_origin, project_label, session_title, candidate_id, executor_harness, declaration_json,
  state, requested_at, started_at, ended_at, updated_at, native_session_id, pid, exit_code, result_kind,
  result_excerpt, num_turns, duration_ms, validations_json, acceptance, failure_reason, launch_session_id,
  released_at, release_evidence, scope_json, guarantee_json, native_turn_id, stop_requested_at, stop_confirmed_at
`;

const SELECTED_COLUMN_NAMES = SELECT_COLUMNS.split(',').map((name) => name.trim());

/**
 * The query-only readers cannot migrate: a table the engine has not upgraded since the reservation
 * columns (ADR 0055) is reported as typed `schema-too-old`, never as a raw storage failure.
 */
const missingReviewAttemptColumns = (db: { query: (sql: string) => { all: () => unknown[] } }): readonly string[] => {
  const present = new Set(
    (db.query('PRAGMA table_info(review_attempts)').all() as { name?: unknown }[]).map((column) => column.name),
  );
  return SELECTED_COLUMN_NAMES.filter((name) => !present.has(name));
};

const parseJsonOrNull = (text: string | null): unknown => {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
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
    guarantee: parseJsonOrNull(record.guarantee_json),
    idempotencyKey: record.idempotency_key,
    launchSessionId: record.launch_session_id,
    machineId: record.machine_id,
    nativeSessionId: record.native_session_id,
    nativeTurnId: record.native_turn_id,
    numTurns: record.num_turns,
    pid: record.pid,
    releaseEvidence: record.release_evidence,
    releasedAt: record.released_at,
    requestedAt: record.requested_at,
    resultExcerpt: record.result_excerpt,
    resultKind: record.result_kind,
    scope: parseJsonOrNull(record.scope_json),
    startedAt: record.started_at,
    stopRequestedAt: record.stop_requested_at,
    stopConfirmedAt: record.stop_confirmed_at,
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
  guarantee: 'guarantee_json',
  nativeSessionId: 'native_session_id',
  nativeTurnId: 'native_turn_id',
  numTurns: 'num_turns',
  pid: 'pid',
  resultExcerpt: 'result_excerpt',
  resultKind: 'result_kind',
  scope: 'scope_json',
  startedAt: 'started_at',
  stopRequestedAt: 'stop_requested_at',
  stopConfirmedAt: 'stop_confirmed_at',
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
  if (key === 'scope' || key === 'guarantee') {
    return value === null || value === undefined ? null : JSON.stringify(value);
  }
  return value ?? null;
};

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const isObjectId = (value: unknown): value is string => typeof value === 'string' && OBJECT_ID.test(value);

/**
 * Why a `requested` row cannot take the shared reservation check, read from the values as given
 * (the type is not trusted at this seam: a `requested` row must never enter without the check);
 * `null` when it can.
 */
const requestedRowRefusal = (attempt: Extract<NewReviewAttempt, { readonly state: 'requested' }>): string | null => {
  const reservation: unknown = attempt.reservation;
  if (typeof reservation !== 'object' || reservation === null) {
    return 'a requested review attempt must carry the reservation the shared target and pool check needs';
  }
  const { baseSha, headSha, maxConcurrent, poolId } = reservation as Record<string, unknown>;
  if (!(isObjectId(baseSha) && isObjectId(headSha))) {
    return 'reservation.baseSha and reservation.headSha must be git object ids (40 or 64 lowercase hex digits)';
  }
  if (!(Number.isSafeInteger(maxConcurrent) && typeof maxConcurrent === 'number' && maxConcurrent > 0)) {
    return 'reservation.maxConcurrent must be a positive integer';
  }
  if (typeof poolId !== 'string' || poolId.length === 0) {
    return 'reservation.poolId must name the quota pool the attempt occupies';
  }
  if (typeof attempt.target.checkoutPath !== 'string' || attempt.target.checkoutPath.length === 0) {
    return 'a requested review attempt must name the checkout whose revision its reservation holds';
  }
  return null;
};

export const createReviewAttemptStore = (dependencies: ReviewAttemptStoreDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader, withUsageStoreWriter } = dependencies;

  const requestReviewAttempt = (
    input: RequestReviewAttemptInput,
  ): Effect.Effect<RequestReviewAttemptResult, UsageStoreError> => {
    if (input.attempt.state === 'requested') {
      const refusal = requestedRowRefusal(input.attempt);
      if (refusal !== null) {
        return Effect.fail(usageStoreError('requestReviewAttempt', input.dbPath, refusal, 'invalid-input'));
      }
    }
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: (): RequestReviewAttemptResult => {
          const { attempt } = input;
          db.exec('BEGIN IMMEDIATE');
          try {
            if (attempt.state === 'requested') {
              const live = db
                .query(
                  `SELECT ${SELECT_COLUMNS} FROM review_attempts WHERE idempotency_key = ? AND ${RESERVING_SQL} LIMIT 1`,
                )
                .get(attempt.idempotencyKey) as ReviewAttemptRecord | null;
              if (live !== null) {
                const existing = attemptFromRecord(live);
                db.exec('COMMIT');
                if (existing === null) {
                  throw new Error(`Reserving review attempt ${live.attempt_id} does not satisfy its own contract`);
                }
                return { attempt: existing, kind: 'reused', reused: true };
              }
              // The shared rule, under this transaction: the frozen target must be free of both
              // families and the pool must have a slot, legacy attempts and delegation jobs counted
              // together. Every requested row takes it (validated above, before the writer opened).
              const { reservation } = attempt;
              const check: ReviewReservationCheck = checkReviewReservations({
                holders: readReviewReservationHolders(db, attempt.machineId),
                maxConcurrent: reservation.maxConcurrent,
                pool: { harness: attempt.executorHarness, poolId: reservation.poolId },
                target: {
                  action: REVIEW_ATTEMPT_ACTION,
                  baseSha: reservation.baseSha,
                  checkoutPath: attempt.target.checkoutPath ?? '',
                  headSha: reservation.headSha,
                },
              });
              if (check.kind !== 'free') {
                db.exec('COMMIT');
                return check;
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
                declaration_json, state, requested_at, updated_at, validations_json, acceptance, failure_reason,
                launch_session_id, base_sha, head_sha
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'pending', ?, ?, ?, ?)
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
              attempt.launchSessionId ?? null,
              attempt.state === 'requested' ? attempt.reservation.baseSha : null,
              attempt.state === 'requested' ? attempt.reservation.headSha : null,
            );
            const inserted = readAttempt(db, attemptId);
            db.exec('COMMIT');
            if (inserted === null) {
              throw new Error(`Review attempt ${attemptId} does not satisfy its own contract after insert`);
            }
            return { attempt: inserted, kind: 'inserted', reused: false };
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
        catch: (cause) => usageStoreError('requestReviewAttempt', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

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

  /**
   * Releases a lost attempt's reservation with the evidence that ended it, and records the outcome
   * the launching engine observed when one arrived late. Applies only to a `lost` row; the state
   * stays `lost` (contact was lost, that is history) and the first evidence recorded stands.
   */
  const releaseReviewAttemptReservation = (
    input: ReleaseReviewAttemptReservationInput,
  ): Effect.Effect<TransitionReviewAttemptResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const assignments = [
            'updated_at = ?',
            'released_at = COALESCE(released_at, ?)',
            'release_evidence = COALESCE(release_evidence, ?)',
          ];
          const values: unknown[] = [input.at, input.at, input.evidence];
          const outcome: ReviewAttemptPatch = input.outcome ?? {};
          for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof ReviewAttemptPatch, string][]) {
            if (!(key in outcome) || key === 'state' || key === 'scope' || key === 'guarantee' || key === 'startedAt') {
              continue;
            }
            assignments.push(`${column} = ?`);
            values.push(patchValue(key, outcome[key]));
          }
          db.query(`
            UPDATE review_attempts SET ${assignments.join(', ')} WHERE attempt_id = ? AND state = 'lost'
          `).run(...values, input.attemptId);
          const changed = (db.query('SELECT changes() AS changed').get() as { changed: number }).changed;
          return { applied: changed > 0 };
        },
        catch: (cause) => usageStoreError('releaseReviewAttemptReservation', input.dbPath, cause, 'storage-failure'),
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
          const missing = missingReviewAttemptColumns(db);
          if (missing.length > 0) {
            throw usageStoreError(
              'queryReviewAttempts',
              input.dbPath,
              `The usage store has not been upgraded for review attempts yet (missing ${missing.slice(0, 3).join(', ')}); it is upgraded at the next engine start`,
              'schema-too-old',
            );
          }
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
          if (input.reserving === true) {
            clauses.push(RESERVING_SQL);
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

  /**
   * The reservations both families hold on one machine, outside any transaction: what the
   * delegation qualification shows before a launch decides. The insert transactions re-read them.
   */
  const queryReviewReservations = (
    input: QueryReviewReservationsInput,
  ): Effect.Effect<QueryReviewReservationsResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => ({ holders: readReviewReservationHolders(db, input.machineId) }),
        catch: (cause) => usageStoreReadError('queryReviewReservations', input.dbPath, cause),
      }),
    );

  const queryReviewTargetResolution = (
    input: QueryReviewTargetResolutionInput,
  ): Effect.Effect<ReviewTargetResolutionFacts, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const desktopSessionId = input.desktopSessionId ?? null;
          // Only the Claude Desktop registry knows transcripts. The row must declare this very
          // transcript, and when the command names a Desktop session it must be that row: a
          // desktop id alone would let a command borrow another session's checkout.
          const desktopRecord =
            input.harness === 'claude'
              ? (db
                  .query(`
                    SELECT desktop_session_id, cwd, worktree_path, title
                    FROM claude_desktop_sessions
                    WHERE machine_id = ? AND cli_session_id = ? AND (? IS NULL OR desktop_session_id = ?)
                    ORDER BY last_activity_at DESC, id DESC
                    LIMIT 1
                  `)
                  .get(input.machineId, input.sourceSessionId, desktopSessionId, desktopSessionId) as {
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
    queryReviewReservations,
    queryReviewTargetResolution,
    releaseReviewAttemptReservation,
    requestReviewAttempt,
    transitionReviewAttempt,
  };
};
