import { randomUUID } from 'node:crypto';
import type {
  DelegationEvaluation,
  DelegationExecutedScope,
  DelegationHarnessGuarantee,
  DelegationJob,
  DelegationJobResult,
  DelegationQualification,
  DelegationRequest,
  DelegationSelection,
  DelegationUsage,
  FrozenDelegationScope,
} from '@ai-usage/report-core/delegation-contracts';
import {
  DELEGATION_JOB_BOUNDS,
  type DelegationEvaluationInput,
  parseDelegationEvaluation,
  parseDelegationJob,
} from '@ai-usage/report-core/delegation-job';
import { DELEGATION_RESULT_BOUNDS } from '@ai-usage/report-core/delegation-result';
import {
  DELEGATION_ACCEPTANCE_VERDICTS,
  DELEGATION_BOUNDS,
  DELEGATION_CONTEXTS,
  DELEGATION_EVALUATION_AUTHORS,
  DELEGATION_EVALUATION_KINDS,
  DELEGATION_EXECUTOR_HARNESSES,
  DELEGATION_JOB_STATES,
  DELEGATION_LIVE_STATES,
  DELEGATION_QUALIFICATION_PURPOSES,
  DELEGATION_REFUSAL_REASONS,
  DELEGATION_RELEASE_EVIDENCE,
  DELEGATION_RESULT_KINDS,
  DELEGATION_TRACE_VERSION,
  DELEGATION_VERIFICATION_VERDICTS,
  type DelegationContext,
  type DelegationExecutorHarness,
  type DelegationJobState,
  type DelegationQualificationPurpose,
  type DelegationRefusalReason,
  type DelegationReleaseEvidence,
} from '@ai-usage/report-core/delegation-vocabulary';
import { Effect } from 'effect';
import { UsageStoreError, type UsageStoreErrorReason } from './errors';
import {
  checkReviewReservations,
  type ReviewReservationHolder,
  readReviewReservationHolders,
} from './review-reservations';

/**
 * Durable storage for delegation (design 2026-10-25): the jobs a caller handed to AI Usage, the
 * qualifications they chose from and the evaluations recorded about their results. Written only by
 * the engine, re-validated on the way out with the shared parsers, so a row that no longer parses
 * is counted in `skipped`, never served and never silently dropped.
 *
 * Four properties are load-bearing, inherited from review attempts (ADR 0053, 0055):
 *
 * - **Decisions in one transaction.** `requestDelegationJob` checks the idempotency key, the target
 *   reservation, the pool concurrency and the retry chain, then inserts, all under one
 *   `BEGIN IMMEDIATE`, so two connections racing on the same target or pool never both win. A
 *   partial unique index on the reserving target backs the first rule below the code path.
 * - **Release needs evidence.** A lost job keeps its reservations until a write names its evidence;
 *   nothing releases a row by age.
 * - **Transitions are guarded.** A state write names the states it may leave from; a late heartbeat
 *   cannot resurrect a finished, cancelled or lost job.
 * - **Outside the served revision.** The three tables never advance the store generation, never
 *   enter a publication, a snapshot or an export. They describe this machine.
 */
export const DELEGATION_TABLES = ['delegation_jobs', 'delegation_evaluations', 'delegation_qualifications'] as const;

export const DELEGATION_STORE_BOUNDS = {
  /** Jobs one list read returns at most. */
  maxListLimit: 200,
  /** Job ids one evaluation read accepts. */
  maxEvaluationJobIds: 200,
  /**
   * Evaluations of one kind by one author (a caller's verifications, the operator's acceptances) kept
   * per job; the next one is refused `limit-reached`. The engine's own output check is not counted.
   */
  maxEvaluationsPerJobAuthor: 10,
  /** Qualifications kept per machine (newest first); older ones go unless a job cites them. */
  maxQualificationsPerMachine: 500,
  /** Qualifications older than this go unless a job cites them. */
  qualificationRetentionMs: 7 * 24 * 60 * 60 * 1000,
  /** `retry_of` links followed when a chain is counted; a longer chain is counted to this depth. */
  maxRetryChainDepth: 16,
} as const;

const sqlList = (values: readonly string[]): string => `(${values.map((value) => `'${value}'`).join(', ')})`;

/** The reserving predicate, shared by the unique index and every read that must agree with it. */
const RESERVING_SQL = `(state IN ${sqlList(DELEGATION_LIVE_STATES)} OR (state = 'lost' AND released_at IS NULL))`;
const LIVE_SQL = `state IN ${sqlList(DELEGATION_LIVE_STATES)}`;

const delegationSchemaSql = `
  CREATE TABLE IF NOT EXISTS delegation_qualifications (
    qualification_id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ${sqlList(DELEGATION_QUALIFICATION_PURPOSES)}),
    qualified_at TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    qualification_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delegation_qualifications_machine
    ON delegation_qualifications(machine_id, qualified_at DESC);

  CREATE TABLE IF NOT EXISTS delegation_jobs (
    job_id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    selection_digest TEXT,
    request_json TEXT NOT NULL,
    action TEXT NOT NULL,
    task_category TEXT NOT NULL,
    checkout_path TEXT,
    base_sha TEXT,
    head_sha TEXT,
    retry_of TEXT,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    qualification_id TEXT,
    qualification_json TEXT,
    selection_json TEXT,
    route_id TEXT,
    pool_id TEXT,
    executor_harness TEXT CHECK (executor_harness IS NULL OR executor_harness IN ${sqlList(DELEGATION_EXECUTOR_HARNESSES)}),
    account_scope TEXT,
    context TEXT CHECK (context IS NULL OR context IN ${sqlList(DELEGATION_CONTEXTS)}),
    model_requested TEXT,
    model_resolved TEXT,
    effort TEXT,
    harness_version TEXT,
    state TEXT NOT NULL CHECK (state IN ${sqlList(DELEGATION_JOB_STATES)}),
    refusal_reason TEXT CHECK (refusal_reason IS NULL OR refusal_reason IN ${sqlList(DELEGATION_REFUSAL_REASONS)}),
    failure_reason TEXT,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL,
    cancel_requested_at TEXT,
    launch_marker TEXT,
    pid INTEGER,
    native_session_id TEXT,
    exit_code INTEGER,
    result_kind TEXT CHECK (result_kind IS NULL OR result_kind IN ${sqlList(DELEGATION_RESULT_KINDS)}),
    result_json TEXT,
    usage_json TEXT,
    guarantee_json TEXT,
    scope_json TEXT,
    executed_scope_json TEXT,
    released_at TEXT,
    release_evidence TEXT CHECK (release_evidence IS NULL OR release_evidence IN ${sqlList(DELEGATION_RELEASE_EVIDENCE)}),
    trace_version INTEGER NOT NULL,
    UNIQUE (machine_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_delegation_jobs_machine_state
    ON delegation_jobs(machine_id, state, requested_at DESC);
  CREATE INDEX IF NOT EXISTS idx_delegation_jobs_target
    ON delegation_jobs(machine_id, checkout_path, base_sha, head_sha);
  CREATE INDEX IF NOT EXISTS idx_delegation_jobs_pool
    ON delegation_jobs(machine_id, pool_id);
  CREATE INDEX IF NOT EXISTS idx_delegation_jobs_retry_of
    ON delegation_jobs(retry_of);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_jobs_reserved_target
    ON delegation_jobs(machine_id, action, checkout_path, base_sha, head_sha)
    WHERE ${RESERVING_SQL};

  CREATE TABLE IF NOT EXISTS delegation_evaluations (
    evaluation_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ${sqlList(DELEGATION_EVALUATION_KINDS)}),
    verdict TEXT NOT NULL CHECK (verdict IN ${sqlList([...DELEGATION_VERIFICATION_VERDICTS, ...DELEGATION_ACCEPTANCE_VERDICTS])}),
    author TEXT NOT NULL CHECK (author IN ${sqlList(DELEGATION_EVALUATION_AUTHORS)}),
    author_label TEXT,
    note TEXT,
    checks_json TEXT NOT NULL DEFAULT '[]',
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delegation_evaluations_job
    ON delegation_evaluations(job_id, recorded_at DESC);
`;

interface MigrationDatabase {
  exec: (sql: string) => unknown;
  query: (sql: string) => { all: (...params: unknown[]) => unknown[]; get: (...params: unknown[]) => unknown };
}

const tableMissing = (db: MigrationDatabase, table: string): boolean =>
  db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) === null;

/**
 * Creates the three tables and their indexes inside the caller's migration transaction when they
 * are absent (ADR 0075: additive tables under usage `user_version` 4, presence is the signal);
 * `true` when something was created. Idempotent: a second open finds them and changes nothing.
 */
export const migrateDelegationSchema = (db: MigrationDatabase): boolean => {
  const missing = DELEGATION_TABLES.some((table) => tableMissing(db, table));
  db.exec(delegationSchemaSql);
  return missing;
};

// ---------------------------------------------------------------------------------------------
// Inputs and results
// ---------------------------------------------------------------------------------------------

export interface NewDelegationJob {
  readonly accountScope: string | null;
  readonly action: string;
  /** The canonical checkout path the engine resolved; `null` for a refusal that never resolved one. */
  readonly checkoutPath: string | null;
  readonly context: DelegationContext | null;
  readonly effort: string | null;
  readonly executorHarness: DelegationExecutorHarness | null;
  /** For a refusal, its message; otherwise `null`. */
  readonly failureReason?: string | null;
  readonly idempotencyKey: string;
  /** Defaults to a fresh UUID; tests may pin it. */
  readonly jobId?: string;
  /** The marker the launch will carry, chosen before any spawn; `null` for a decision that launches nothing. */
  readonly launchMarker?: string | null;
  readonly machineId: string;
  readonly modelRequested: string | null;
  readonly poolId: string | null;
  /** The qualification snapshot at launch; bounded by `DELEGATION_BOUNDS.maxQualificationBytes`. */
  readonly qualification: DelegationQualification | null;
  readonly qualificationId: string | null;
  readonly refusalReason?: DelegationRefusalReason | null;
  readonly request: DelegationRequest;
  readonly requestDigest: string;
  readonly requestedAt: string;
  readonly retryOf: string | null;
  readonly routeId: string | null;
  /** The frozen scope; its SHAs become the reservation target. `null` when freezing failed. */
  readonly scope: FrozenDelegationScope | null;
  readonly selection: DelegationSelection | null;
  readonly selectionDigest: string | null;
  /** `requested` opens a live job; `refused` and `abstained` record decisions that launch nothing. */
  readonly state: 'abstained' | 'refused' | 'requested';
  readonly taskCategory: string;
}

export interface RequestDelegationJobInput {
  readonly dbPath: string;
  readonly job: NewDelegationJob;
  readonly limits: {
    /** Jobs in the retry chain (rows that reserved or ran) at most, the new one included. */
    readonly maxAttempts: number;
    /** Reserving jobs per (machine, pool) at most. */
    readonly maxConcurrent: number;
  };
}

export type RequestDelegationJobResult =
  | { readonly count: number; readonly kind: 'attempts-exhausted' }
  /** The pool has no slot left, delegation jobs and legacy review attempts counted together (`review-reservations.ts`). */
  | {
      readonly count: number;
      readonly holders: readonly ReviewReservationHolder[];
      readonly kind: 'pool-busy';
      readonly message: string;
    }
  | {
      readonly existing: { readonly jobId: string; readonly state: DelegationJobState };
      readonly kind: 'idempotency-conflict';
    }
  /** A row of either family reserves the target; `existing` names it for callers that follow a job id. */
  | {
      readonly existing: { readonly jobId: string; readonly state: string };
      readonly holder: ReviewReservationHolder;
      readonly kind: 'target-reserved';
      readonly message: string;
    }
  | { readonly job: DelegationJob; readonly kind: 'inserted' }
  | { readonly job: DelegationJob; readonly kind: 'reused' };

export interface DelegationJobPatch {
  readonly endedAt?: string | null;
  readonly executedScope?: DelegationExecutedScope | null;
  readonly exitCode?: number | null;
  readonly failureReason?: string | null;
  readonly guarantee?: DelegationHarnessGuarantee | null;
  readonly harnessVersion?: string | null;
  readonly modelResolved?: string | null;
  readonly nativeSessionId?: string | null;
  readonly pid?: number | null;
  readonly refusalReason?: DelegationRefusalReason | null;
  /** Sets `result_kind` and `result_json` together. */
  readonly result?: DelegationJobResult | null;
  readonly startedAt?: string | null;
  readonly state?: DelegationJobState;
  readonly usage?: DelegationUsage | null;
}

export interface TransitionDelegationJobInput {
  /** Becomes `updated_at`; a heartbeat is a transition with an empty patch. */
  readonly at: string;
  readonly dbPath: string;
  /** The transition applies only when the row is in one of these states; defaults to the live states. */
  readonly fromStates?: readonly DelegationJobState[];
  readonly jobId: string;
  readonly patch: DelegationJobPatch;
}

export interface TransitionDelegationJobResult {
  readonly applied: boolean;
}

export interface RequestDelegationCancelInput {
  readonly at: string;
  readonly dbPath: string;
  readonly jobId: string;
}

export interface RequestDelegationCancelResult {
  readonly applied: boolean;
  /** The row's state at the time; `null` when no such job exists. */
  readonly state: DelegationJobState | null;
}

export interface MarkDelegationJobsLostInput {
  readonly at: string;
  readonly dbPath: string;
  readonly machineId: string;
  /** Bounded, per job; names why contact was lost (engine restart, shutdown). */
  readonly reason:
    | string
    | ((job: { readonly jobId: string; readonly pid: number | null; readonly state: DelegationJobState }) => string);
}

export interface MarkDelegationJobsLostResult {
  readonly lost: readonly string[];
}

export interface ReleaseDelegationJobReservationInput {
  /** Becomes `updated_at`, and `released_at` unless the row was already released. */
  readonly at: string;
  readonly dbPath: string;
  /** The first evidence recorded stands; a later release only adds outcome fields. */
  readonly evidence: DelegationReleaseEvidence;
  readonly jobId: string;
  /** What the launching engine observed at the process's end, recorded on the lost row; never a state. */
  readonly outcome?: Omit<DelegationJobPatch, 'executedScope' | 'guarantee' | 'refusalReason' | 'startedAt' | 'state'>;
}

export interface NewDelegationEvaluation extends DelegationEvaluationInput {
  /** Defaults to a fresh UUID; tests may pin it. */
  readonly evaluationId?: string;
  readonly jobId: string;
  readonly recordedAt: string;
}

export interface RecordDelegationEvaluationInput {
  readonly dbPath: string;
  readonly evaluation: NewDelegationEvaluation;
}

export type RecordDelegationEvaluationResult =
  | { readonly evaluationId: string; readonly kind: 'recorded' }
  | { readonly kind: 'job-not-found' }
  /** An acceptance needs a job that ended (`finished`, `failed` or `cancelled`). */
  | { readonly kind: 'job-not-ended'; readonly state: DelegationJobState }
  /** A verification needs a job that finished. */
  | { readonly kind: 'job-not-finished'; readonly state: DelegationJobState }
  /** The job already holds `limit` evaluations of this kind by this author (`DELEGATION_STORE_BOUNDS.maxEvaluationsPerJobAuthor`). */
  | {
      readonly author: DelegationEvaluation['author'];
      readonly evaluationKind: DelegationEvaluation['kind'];
      readonly kind: 'limit-reached';
      readonly limit: number;
    };

export interface QueryDelegationJobsInput {
  readonly checkoutPath?: string;
  readonly dbPath: string;
  /** Exact match on the caller's key; with `machineId` it reads through the unique (machine, key) index. */
  readonly idempotencyKey?: string;
  readonly jobId?: string;
  /** Rows returned at most; defaults to 50 and may not exceed `DELEGATION_STORE_BOUNDS.maxListLimit`. */
  readonly limit?: number;
  readonly machineId?: string;
  /** Only rows holding a reservation, with the unique index's own predicate. */
  readonly reserving?: boolean;
  readonly states?: readonly DelegationJobState[];
}

export interface QueryDelegationJobsResult {
  /** Newest request first. */
  readonly jobs: readonly DelegationJob[];
  /** Persisted rows that no longer pass validation. Never silently omitted. */
  readonly skipped: number;
  readonly truncated: boolean;
}

export interface QueryDelegationEvaluationsInput {
  readonly dbPath: string;
  readonly jobIds: readonly string[];
}

export interface CountDelegationRetryChainInput {
  readonly dbPath: string;
  /** The job a new request would retry; its chain is counted from the oldest ancestor. */
  readonly retryOf: string;
}

/** The retry chain as the transaction counts it, read without one; `parentKnown` is `false` when `retryOf` names no row. */
export interface DelegationRetryChainCount {
  /** Jobs reached by following `retry_of` from the parent (bounded depth). */
  readonly ancestors: number;
  /** Rows in the whole chain rooted at the oldest ancestor that reserved or ran (refusals and abstentions excluded). */
  readonly attempts: number;
  readonly parentKnown: boolean;
}

export interface QueryDelegationEvaluationsResult {
  /** Newest first. */
  readonly evaluations: readonly DelegationEvaluation[];
  readonly skipped: number;
}

export interface RecordDelegationQualificationInput {
  readonly dbPath: string;
  readonly machineId: string;
  readonly purpose: DelegationQualificationPurpose;
  readonly qualification: DelegationQualification;
  readonly requestDigest: string;
}

export interface RecordDelegationQualificationResult {
  /** `false` when a qualification with this id was already stored (the first one stands). */
  readonly inserted: boolean;
  /** Rows the retention rule removed on this insert. */
  readonly pruned: number;
}

export interface ReadDelegationQualificationInput {
  readonly dbPath: string;
  readonly machineId: string;
  readonly qualificationId: string;
}

export interface StoredDelegationQualification {
  readonly policyRevision: string;
  readonly purpose: DelegationQualificationPurpose;
  readonly qualification: DelegationQualification;
  readonly qualifiedAt: string;
  readonly requestDigest: string;
  readonly validUntil: string;
}

export interface ReadDelegationQualificationResult {
  readonly record: StoredDelegationQualification | null;
  /** 1 when a row exists but no longer passes validation. */
  readonly skipped: number;
}

/** A read-only answer for MCP, CLI and Web: typed, never a thrown storage failure. */
export type DelegationStoreReadFailure =
  | { readonly kind: 'incompatible-store'; readonly message: string; readonly reason: 'corrupt' | 'schema-too-new' }
  | { readonly kind: 'store-missing' }
  | { readonly kind: 'store-not-upgraded'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string; readonly reason: UsageStoreErrorReason };

export type DelegationJobsRead =
  | DelegationStoreReadFailure
  | {
      readonly evaluations: readonly DelegationEvaluation[];
      readonly jobs: readonly DelegationJob[];
      readonly kind: 'ok';
      readonly skipped: number;
      readonly truncated: boolean;
    };

export type DelegationJobRead =
  | DelegationStoreReadFailure
  | {
      readonly evaluations: readonly DelegationEvaluation[];
      readonly job: DelegationJob;
      readonly kind: 'ok';
      readonly skipped: number;
    }
  | { readonly kind: 'not-found'; readonly skipped: number };

export interface ReadDelegationJobInput {
  readonly dbPath: string;
  readonly jobId: string;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

interface SqliteDatabase {
  exec: (sql: string) => unknown;
  query: (sql: string) => SqliteStatement;
}

interface DelegationStoreDependencies {
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

interface DelegationJobRecord {
  account_scope: string | null;
  action: string;
  attempt_number: number;
  base_sha: string | null;
  cancel_requested_at: string | null;
  checkout_path: string | null;
  context: string | null;
  effort: string | null;
  ended_at: string | null;
  executed_scope_json: string | null;
  executor_harness: string | null;
  exit_code: number | null;
  failure_reason: string | null;
  guarantee_json: string | null;
  harness_version: string | null;
  head_sha: string | null;
  idempotency_key: string;
  job_id: string;
  launch_marker: string | null;
  machine_id: string;
  model_requested: string | null;
  model_resolved: string | null;
  native_session_id: string | null;
  pid: number | null;
  pool_id: string | null;
  qualification_id: string | null;
  qualification_json: string | null;
  refusal_reason: string | null;
  release_evidence: string | null;
  released_at: string | null;
  request_digest: string;
  request_json: string;
  requested_at: string;
  result_json: string | null;
  result_kind: string | null;
  retry_of: string | null;
  route_id: string | null;
  scope_json: string | null;
  selection_digest: string | null;
  selection_json: string | null;
  started_at: string | null;
  state: string;
  task_category: string;
  trace_version: number;
  updated_at: string;
  usage_json: string | null;
}

interface DelegationEvaluationRecord {
  author: string;
  author_label: string | null;
  checks_json: string;
  evaluation_id: string;
  job_id: string;
  kind: string;
  note: string | null;
  recorded_at: string;
  verdict: string;
}

const JOB_COLUMNS = `
  job_id, machine_id, idempotency_key, request_digest, selection_digest, request_json, action, task_category,
  checkout_path, base_sha, head_sha, retry_of, attempt_number, qualification_id, qualification_json, selection_json,
  route_id, pool_id, executor_harness, account_scope, context, model_requested, model_resolved, effort, harness_version,
  state, refusal_reason, failure_reason, requested_at, started_at, ended_at, updated_at, cancel_requested_at,
  launch_marker, pid, native_session_id, exit_code, result_kind, result_json, usage_json, guarantee_json, scope_json,
  executed_scope_json, released_at, release_evidence, trace_version
`;

const EVALUATION_COLUMNS = 'evaluation_id, job_id, kind, verdict, author, author_label, note, checks_json, recorded_at';

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

const jobFromRecord = (record: DelegationJobRecord): DelegationJob | null => {
  const result = parseJsonOrNull(record.result_json);
  return parseDelegationJob({
    accountScope: record.account_scope,
    action: record.action,
    attemptNumber: record.attempt_number,
    cancelRequestedAt: record.cancel_requested_at,
    checkoutPath: record.checkout_path,
    context: record.context,
    effort: record.effort,
    endedAt: record.ended_at,
    executedScope: parseJsonOrNull(record.executed_scope_json),
    executorHarness: record.executor_harness,
    exitCode: record.exit_code,
    failureReason: record.failure_reason,
    guarantee: parseJsonOrNull(record.guarantee_json),
    harnessVersion: record.harness_version,
    idempotencyKey: record.idempotency_key,
    jobId: record.job_id,
    launchMarker: record.launch_marker,
    machineId: record.machine_id,
    modelRequested: record.model_requested,
    modelResolved: record.model_resolved,
    nativeSessionId: record.native_session_id,
    pid: record.pid,
    poolId: record.pool_id,
    qualification: parseJsonOrNull(record.qualification_json),
    qualificationId: record.qualification_id,
    refusalReason: record.refusal_reason,
    releasedAt: record.released_at,
    releaseEvidence: record.release_evidence,
    request: parseJsonOrNull(record.request_json),
    requestDigest: record.request_digest,
    requestedAt: record.requested_at,
    // The kind column is the one indexed; the JSON must agree with it or the row is refused.
    result: result === null || record.result_kind === null ? null : { ...(result as object), kind: record.result_kind },
    retryOf: record.retry_of,
    routeId: record.route_id,
    scope: parseJsonOrNull(record.scope_json),
    selection: parseJsonOrNull(record.selection_json),
    startedAt: record.started_at,
    state: record.state,
    taskCategory: record.task_category,
    traceVersion: record.trace_version,
    updatedAt: record.updated_at,
    usage: parseJsonOrNull(record.usage_json),
  });
};

const evaluationFromRecord = (record: DelegationEvaluationRecord): DelegationEvaluation | null =>
  parseDelegationEvaluation({
    author: record.author,
    authorLabel: record.author_label,
    checks: parseJsonOrNull(record.checks_json),
    evaluationId: record.evaluation_id,
    jobId: record.job_id,
    kind: record.kind,
    note: record.note,
    recordedAt: record.recorded_at,
    verdict: record.verdict,
  });

const boundedOrNull = (value: string | null | undefined, maximum: number): string | null =>
  value === null || value === undefined ? null : value.slice(0, maximum);

const jsonOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

const readJob = (db: SqliteDatabase, jobId: string): DelegationJob | null => {
  const record = db
    .query(`SELECT ${JOB_COLUMNS} FROM delegation_jobs WHERE job_id = ?`)
    .get(jobId) as DelegationJobRecord | null;
  return record === null ? null : jobFromRecord(record);
};

const changes = (db: SqliteDatabase): number =>
  (db.query('SELECT changes() AS changed').get() as { changed: number }).changed;

/** The query-only readers cannot migrate: an absent table is a typed `schema-too-old`, never a raw failure. */
const assertDelegationTables = (db: SqliteDatabase, fail: (message: string) => UsageStoreError): void => {
  const missing = DELEGATION_TABLES.filter((table) => tableMissing(db, table));
  if (missing.length > 0) {
    throw fail(
      `The usage store has not been upgraded for delegation yet (missing ${missing.join(', ')}); it is upgraded at the next engine start`,
    );
  }
};

const PATCH_COLUMNS: Readonly<Record<Exclude<keyof DelegationJobPatch, 'result'>, string>> = {
  endedAt: 'ended_at',
  executedScope: 'executed_scope_json',
  exitCode: 'exit_code',
  failureReason: 'failure_reason',
  guarantee: 'guarantee_json',
  harnessVersion: 'harness_version',
  modelResolved: 'model_resolved',
  nativeSessionId: 'native_session_id',
  pid: 'pid',
  refusalReason: 'refusal_reason',
  startedAt: 'started_at',
  state: 'state',
  usage: 'usage_json',
};

const patchValue = (key: Exclude<keyof DelegationJobPatch, 'result'>, value: unknown): unknown => {
  switch (key) {
    case 'failureReason':
      return boundedOrNull(value as string | null, DELEGATION_JOB_BOUNDS.maxFailureReasonCharacters);
    case 'executedScope':
    case 'guarantee':
    case 'usage':
      return jsonOrNull(value);
    default:
      return value ?? null;
  }
};

/** Appends the patch's assignments; `result` writes its kind column and its JSON (excerpt bounded) together. */
const appendPatch = (
  patch: DelegationJobPatch,
  skip: ReadonlySet<keyof DelegationJobPatch>,
  assignments: string[],
  values: unknown[],
): void => {
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [
    Exclude<keyof DelegationJobPatch, 'result'>,
    string,
  ][]) {
    if (!(key in patch) || skip.has(key)) {
      continue;
    }
    assignments.push(`${column} = ?`);
    values.push(patchValue(key, patch[key]));
  }
  if ('result' in patch && !skip.has('result')) {
    const result = patch.result ?? null;
    assignments.push('result_kind = ?', 'result_json = ?');
    values.push(
      result === null ? null : result.kind,
      result === null
        ? null
        : JSON.stringify({
            excerpt: boundedOrNull(result.excerpt, DELEGATION_RESULT_BOUNDS.maxExcerptCharacters),
            kind: result.kind,
            review: result.review,
          }),
    );
  }
};

const inTransaction = <Value>(db: SqliteDatabase, work: () => Value): Value => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

const EMPTY_CHAIN: DelegationRetryChainCount = { ancestors: 0, attempts: 0, parentKnown: true };

const countRetryChain = (db: SqliteDatabase, retryOf: string | null): DelegationRetryChainCount => {
  if (retryOf === null) {
    return EMPTY_CHAIN;
  }
  const parent = db.query('SELECT retry_of FROM delegation_jobs WHERE job_id = ?');
  let current: string | null = retryOf;
  let root = retryOf;
  let ancestors = 0;
  while (current !== null && ancestors < DELEGATION_STORE_BOUNDS.maxRetryChainDepth) {
    const row = parent.get(current) as { retry_of: string | null } | null;
    if (row === null) {
      if (ancestors === 0) {
        return { ancestors: 0, attempts: 0, parentKnown: false };
      }
      break;
    }
    ancestors++;
    root = current;
    current = row.retry_of;
  }
  const counted = db
    .query(`
      WITH RECURSIVE chain(job_id, depth) AS (
        SELECT job_id, 0 FROM delegation_jobs WHERE job_id = ?
        UNION
        SELECT jobs.job_id, chain.depth + 1
        FROM delegation_jobs AS jobs
        INNER JOIN chain ON jobs.retry_of = chain.job_id
        WHERE chain.depth < ?
      )
      SELECT COUNT(*) AS count
      FROM chain
      INNER JOIN delegation_jobs USING (job_id)
      WHERE state NOT IN ('refused', 'abstained')
    `)
    .get(root, DELEGATION_STORE_BOUNDS.maxRetryChainDepth) as { count: number };
  return { ancestors, attempts: counted.count, parentKnown: true };
};

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

export const createDelegationStore = (dependencies: DelegationStoreDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader, withUsageStoreWriter } = dependencies;

  const requestDelegationJob = (
    input: RequestDelegationJobInput,
  ): Effect.Effect<RequestDelegationJobResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const { job, limits } = input;
          const invalid = (message: string): UsageStoreError =>
            usageStoreError('requestDelegationJob', input.dbPath, message, 'invalid-input');
          if (!(Number.isSafeInteger(limits.maxConcurrent) && limits.maxConcurrent >= 1)) {
            throw invalid('maxConcurrent must be a positive integer');
          }
          if (!(Number.isSafeInteger(limits.maxAttempts) && limits.maxAttempts >= 1)) {
            throw invalid('maxAttempts must be a positive integer');
          }
          const qualificationJson = jsonOrNull(job.qualification);
          if (
            qualificationJson !== null &&
            Buffer.byteLength(qualificationJson) > DELEGATION_BOUNDS.maxQualificationBytes
          ) {
            throw invalid('qualification snapshot exceeds its byte bound');
          }
          const baseSha = job.scope?.baseSha ?? null;
          const headSha = job.scope?.headSha ?? null;
          return inTransaction(db, (): RequestDelegationJobResult => {
            const existing = db
              .query(`SELECT ${JOB_COLUMNS} FROM delegation_jobs WHERE machine_id = ? AND idempotency_key = ?`)
              .get(job.machineId, job.idempotencyKey) as DelegationJobRecord | null;
            if (existing !== null) {
              const sameRequest =
                existing.request_digest === job.requestDigest && existing.selection_digest === job.selectionDigest;
              if (!sameRequest) {
                return {
                  existing: { jobId: existing.job_id, state: existing.state as DelegationJobState },
                  kind: 'idempotency-conflict',
                };
              }
              const parsed = jobFromRecord(existing);
              if (parsed === null) {
                throw new Error(`Delegation job ${existing.job_id} does not satisfy its own contract`);
              }
              return { job: parsed, kind: 'reused' };
            }
            const chain = countRetryChain(db, job.retryOf);
            if (job.state === 'requested') {
              if (job.checkoutPath === null || baseSha === null || headSha === null) {
                throw invalid('a requested job needs a checkout path and a frozen scope');
              }
              if (job.poolId === null || job.routeId === null) {
                throw invalid('a requested job needs a route and a pool');
              }
              if (!chain.parentKnown) {
                throw invalid('retryOf names a job this store does not hold');
              }
              // The shared rule, under this transaction: the target must be free of both review
              // families and the pool must have a slot, delegation jobs and legacy attempts counted
              // together. The partial unique index still backs the delegation side below the code path.
              const check = checkReviewReservations({
                holders: readReviewReservationHolders(db, job.machineId),
                maxConcurrent: limits.maxConcurrent,
                pool: { harness: job.executorHarness ?? '', poolId: job.poolId },
                target: { action: job.action, baseSha, checkoutPath: job.checkoutPath, headSha },
              });
              if (check.kind === 'target-reserved') {
                return {
                  existing: { jobId: check.holder.id, state: check.holder.state },
                  holder: check.holder,
                  kind: 'target-reserved',
                  message: check.message,
                };
              }
              if (check.kind === 'pool-busy') {
                return { count: check.count, holders: check.holders, kind: 'pool-busy', message: check.message };
              }
              if (job.retryOf !== null && chain.attempts >= limits.maxAttempts) {
                return { count: chain.attempts, kind: 'attempts-exhausted' };
              }
            }
            const jobId = job.jobId ?? randomUUID();
            db.query(`
              INSERT INTO delegation_jobs (
                job_id, machine_id, idempotency_key, request_digest, selection_digest, request_json, action, task_category,
                checkout_path, base_sha, head_sha, retry_of, attempt_number, qualification_id, qualification_json,
                selection_json, route_id, pool_id, executor_harness, account_scope, context, model_requested, effort,
                state, refusal_reason, failure_reason, requested_at, updated_at, launch_marker, scope_json, trace_version
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              jobId,
              job.machineId,
              job.idempotencyKey,
              job.requestDigest,
              job.selectionDigest,
              JSON.stringify(job.request),
              job.action,
              job.taskCategory,
              job.checkoutPath,
              baseSha,
              headSha,
              job.retryOf,
              chain.ancestors + 1,
              job.qualificationId,
              qualificationJson,
              jsonOrNull(job.selection),
              job.routeId,
              job.poolId,
              job.executorHarness,
              job.accountScope,
              job.context,
              job.modelRequested,
              job.effort,
              job.state,
              job.refusalReason ?? null,
              boundedOrNull(job.failureReason, DELEGATION_JOB_BOUNDS.maxFailureReasonCharacters),
              job.requestedAt,
              job.requestedAt,
              job.launchMarker ?? null,
              jsonOrNull(job.scope),
              DELEGATION_TRACE_VERSION,
            );
            const inserted = readJob(db, jobId);
            if (inserted === null) {
              throw new Error(`Delegation job ${jobId} does not satisfy its own contract after insert`);
            }
            return { job: inserted, kind: 'inserted' };
          });
        },
        catch: (cause) =>
          cause instanceof UsageStoreError
            ? cause
            : usageStoreError('requestDelegationJob', input.dbPath, cause, 'storage-failure'),
      }),
    );

  const transitionDelegationJob = (
    input: TransitionDelegationJobInput,
  ): Effect.Effect<TransitionDelegationJobResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const fromStates = input.fromStates ?? DELEGATION_LIVE_STATES;
          if (fromStates.length === 0) {
            return { applied: false };
          }
          const assignments: string[] = ['updated_at = ?'];
          const values: unknown[] = [input.at];
          appendPatch(input.patch, new Set(), assignments, values);
          db.query(`
            UPDATE delegation_jobs
            SET ${assignments.join(', ')}
            WHERE job_id = ? AND state IN (${fromStates.map(() => '?').join(', ')})
          `).run(...values, input.jobId, ...fromStates);
          return { applied: changes(db) > 0 };
        },
        catch: (cause) => usageStoreError('transitionDelegationJob', input.dbPath, cause, 'storage-failure'),
      }),
    );

  const requestDelegationCancel = (
    input: RequestDelegationCancelInput,
  ): Effect.Effect<RequestDelegationCancelResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () =>
          inTransaction(db, (): RequestDelegationCancelResult => {
            const row = db.query('SELECT state FROM delegation_jobs WHERE job_id = ?').get(input.jobId) as {
              state: DelegationJobState;
            } | null;
            if (row === null) {
              return { applied: false, state: null };
            }
            db.query(`
              UPDATE delegation_jobs
              SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
              WHERE job_id = ? AND ${LIVE_SQL}
            `).run(input.at, input.at, input.jobId);
            return { applied: changes(db) > 0, state: row.state };
          }),
        catch: (cause) => usageStoreError('requestDelegationCancel', input.dbPath, cause, 'storage-failure'),
      }),
    );

  const markDelegationJobsLost = (
    input: MarkDelegationJobsLostInput,
  ): Effect.Effect<MarkDelegationJobsLostResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () =>
          inTransaction(db, (): MarkDelegationJobsLostResult => {
            const live = db
              .query(
                `SELECT job_id, pid, state FROM delegation_jobs WHERE machine_id = ? AND ${LIVE_SQL} ORDER BY requested_at, job_id`,
              )
              .all(input.machineId) as { job_id: string; pid: number | null; state: DelegationJobState }[];
            const update = db.query(`
              UPDATE delegation_jobs
              SET state = 'lost', ended_at = COALESCE(ended_at, ?), updated_at = ?, failure_reason = ?
              WHERE job_id = ? AND ${LIVE_SQL}
            `);
            const lost: string[] = [];
            for (const row of live) {
              const reason =
                typeof input.reason === 'string'
                  ? input.reason
                  : input.reason({ jobId: row.job_id, pid: row.pid, state: row.state });
              update.run(
                input.at,
                input.at,
                reason.slice(0, DELEGATION_JOB_BOUNDS.maxFailureReasonCharacters),
                row.job_id,
              );
              lost.push(row.job_id);
            }
            return { lost };
          }),
        catch: (cause) => usageStoreError('markDelegationJobsLost', input.dbPath, cause, 'storage-failure'),
      }),
    );

  /**
   * Releases a lost job's reservation with the evidence that ended it, and records the outcome the
   * launching engine observed when one arrived late. Applies only to a `lost` row; the state stays
   * `lost` (contact was lost, that is history) and the first evidence recorded stands.
   */
  const releaseDelegationJobReservation = (
    input: ReleaseDelegationJobReservationInput,
  ): Effect.Effect<TransitionDelegationJobResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const assignments = [
            'updated_at = ?',
            'released_at = COALESCE(released_at, ?)',
            'release_evidence = COALESCE(release_evidence, ?)',
          ];
          const values: unknown[] = [input.at, input.at, input.evidence];
          appendPatch(
            input.outcome ?? {},
            new Set<keyof DelegationJobPatch>(['executedScope', 'guarantee', 'refusalReason', 'startedAt', 'state']),
            assignments,
            values,
          );
          db.query(`UPDATE delegation_jobs SET ${assignments.join(', ')} WHERE job_id = ? AND state = 'lost'`).run(
            ...values,
            input.jobId,
          );
          return { applied: changes(db) > 0 };
        },
        catch: (cause) => usageStoreError('releaseDelegationJobReservation', input.dbPath, cause, 'storage-failure'),
      }),
    );

  const recordDelegationEvaluation = (
    input: RecordDelegationEvaluationInput,
  ): Effect.Effect<RecordDelegationEvaluationResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () =>
          inTransaction(db, (): RecordDelegationEvaluationResult => {
            const { evaluation } = input;
            const row = db.query('SELECT state FROM delegation_jobs WHERE job_id = ?').get(evaluation.jobId) as {
              state: DelegationJobState;
            } | null;
            if (row === null) {
              return { kind: 'job-not-found' };
            }
            const ended = (['cancelled', 'failed', 'finished'] as readonly DelegationJobState[]).includes(row.state);
            if (evaluation.kind === 'acceptance' && !ended) {
              return { kind: 'job-not-ended', state: row.state };
            }
            // The engine's own output check describes any ended run (inconclusive when nothing
            // finished); a model's verification judges a result, so it needs a finished job.
            if (evaluation.kind === 'verification') {
              const allowed = evaluation.author === 'automated-check' ? ended : row.state === 'finished';
              if (!allowed) {
                return { kind: 'job-not-finished', state: row.state };
              }
            }
            // A caller or the operator may say so only so many times per job; the count is read in
            // the same transaction as the insert, so two edges cannot both take the last slot.
            if (evaluation.author !== 'automated-check') {
              const { count } = db
                .query(
                  'SELECT COUNT(*) AS count FROM delegation_evaluations WHERE job_id = ? AND kind = ? AND author = ?',
                )
                .get(evaluation.jobId, evaluation.kind, evaluation.author) as { count: number };
              if (count >= DELEGATION_STORE_BOUNDS.maxEvaluationsPerJobAuthor) {
                return {
                  author: evaluation.author,
                  evaluationKind: evaluation.kind,
                  kind: 'limit-reached',
                  limit: DELEGATION_STORE_BOUNDS.maxEvaluationsPerJobAuthor,
                };
              }
            }
            const evaluationId = evaluation.evaluationId ?? randomUUID();
            db.query(`
              INSERT INTO delegation_evaluations (${EVALUATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              evaluationId,
              evaluation.jobId,
              evaluation.kind,
              evaluation.verdict,
              evaluation.author,
              boundedOrNull(evaluation.authorLabel, DELEGATION_JOB_BOUNDS.maxTextCharacters),
              boundedOrNull(evaluation.note, DELEGATION_BOUNDS.maxEvaluationNoteCharacters),
              JSON.stringify(
                evaluation.checks
                  .slice(0, DELEGATION_BOUNDS.maxEvaluationChecks)
                  .map((check) => check.slice(0, DELEGATION_BOUNDS.maxEvaluationCheckCharacters)),
              ),
              evaluation.recordedAt,
            );
            return { evaluationId, kind: 'recorded' };
          }),
        catch: (cause) => usageStoreError('recordDelegationEvaluation', input.dbPath, cause, 'storage-failure'),
      }),
    );

  const recordDelegationQualification = (
    input: RecordDelegationQualificationInput,
  ): Effect.Effect<RecordDelegationQualificationResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const json = JSON.stringify(input.qualification);
          if (Buffer.byteLength(json) > DELEGATION_BOUNDS.maxQualificationBytes) {
            throw usageStoreError(
              'recordDelegationQualification',
              input.dbPath,
              'qualification exceeds its byte bound',
              'invalid-input',
            );
          }
          const qualifiedAt = Date.parse(input.qualification.qualifiedAt);
          if (!Number.isFinite(qualifiedAt)) {
            throw usageStoreError(
              'recordDelegationQualification',
              input.dbPath,
              'qualification.qualifiedAt is not an instant',
              'invalid-input',
            );
          }
          return inTransaction(db, (): RecordDelegationQualificationResult => {
            db.query(`
              INSERT OR IGNORE INTO delegation_qualifications (
                qualification_id, machine_id, request_digest, policy_revision, purpose, qualified_at, valid_until, qualification_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              input.qualification.qualificationId,
              input.machineId,
              input.requestDigest,
              input.qualification.versions.policyRevision,
              input.purpose,
              input.qualification.qualifiedAt,
              input.qualification.validUntil,
              json,
            );
            const inserted = changes(db) > 0;
            const cutoff = new Date(qualifiedAt - DELEGATION_STORE_BOUNDS.qualificationRetentionMs).toISOString();
            // Prune what no job cites: beyond the newest N per machine, or older than the retention.
            db.query(`
              DELETE FROM delegation_qualifications
              WHERE machine_id = ?
                AND qualification_id NOT IN (SELECT qualification_id FROM delegation_jobs WHERE qualification_id IS NOT NULL)
                AND (
                  qualified_at < ?
                  OR qualification_id IN (
                    SELECT qualification_id FROM delegation_qualifications
                    WHERE machine_id = ?
                    ORDER BY qualified_at DESC, qualification_id DESC
                    LIMIT -1 OFFSET ?
                  )
                )
            `).run(input.machineId, cutoff, input.machineId, DELEGATION_STORE_BOUNDS.maxQualificationsPerMachine);
            return { inserted, pruned: changes(db) };
          });
        },
        catch: (cause) =>
          cause instanceof UsageStoreError
            ? cause
            : usageStoreError('recordDelegationQualification', input.dbPath, cause, 'storage-failure'),
      }),
    );

  const readDelegationQualification = (
    input: ReadDelegationQualificationInput,
  ): Effect.Effect<ReadDelegationQualificationResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          assertDelegationTables(db, (message) =>
            usageStoreError('readDelegationQualification', input.dbPath, message, 'schema-too-old'),
          );
          const row = db
            .query(`
              SELECT request_digest, policy_revision, purpose, qualified_at, valid_until, qualification_json
              FROM delegation_qualifications WHERE machine_id = ? AND qualification_id = ?
            `)
            .get(input.machineId, input.qualificationId) as {
            policy_revision: string;
            purpose: string;
            qualification_json: string;
            qualified_at: string;
            request_digest: string;
            valid_until: string;
          } | null;
          if (row === null) {
            return { record: null, skipped: 0 };
          }
          const value = parseJsonOrNull(row.qualification_json);
          const valid =
            typeof value === 'object' &&
            value !== null &&
            (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
            (value as { qualificationId?: unknown }).qualificationId === input.qualificationId &&
            (DELEGATION_QUALIFICATION_PURPOSES as readonly string[]).includes(row.purpose);
          if (!valid) {
            return { record: null, skipped: 1 };
          }
          return {
            record: {
              policyRevision: row.policy_revision,
              purpose: row.purpose as DelegationQualificationPurpose,
              qualification: value as DelegationQualification,
              qualifiedAt: row.qualified_at,
              requestDigest: row.request_digest,
              validUntil: row.valid_until,
            },
            skipped: 0,
          };
        },
        catch: (cause) => usageStoreReadError('readDelegationQualification', input.dbPath, cause),
      }),
    );

  const queryDelegationJobs = (
    input: QueryDelegationJobsInput,
  ): Effect.Effect<QueryDelegationJobsResult, UsageStoreError> => {
    const limit = input.limit ?? 50;
    if (!(Number.isSafeInteger(limit) && limit > 0 && limit <= DELEGATION_STORE_BOUNDS.maxListLimit)) {
      return Effect.fail(
        usageStoreError(
          'queryDelegationJobs',
          input.dbPath,
          `Delegation job limit must be between 1 and ${DELEGATION_STORE_BOUNDS.maxListLimit}`,
          'invalid-input',
        ),
      );
    }
    const states = input.states ?? [];
    return withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          assertDelegationTables(db, (message) =>
            usageStoreError('queryDelegationJobs', input.dbPath, message, 'schema-too-old'),
          );
          const clauses: string[] = [];
          const params: unknown[] = [];
          if (input.machineId !== undefined) {
            clauses.push('machine_id = ?');
            params.push(input.machineId);
          }
          if (input.jobId !== undefined) {
            clauses.push('job_id = ?');
            params.push(input.jobId);
          }
          if (input.idempotencyKey !== undefined) {
            clauses.push('idempotency_key = ?');
            params.push(input.idempotencyKey);
          }
          if (input.checkoutPath !== undefined) {
            clauses.push('checkout_path = ?');
            params.push(input.checkoutPath);
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
              SELECT ${JOB_COLUMNS} FROM delegation_jobs
              ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
              ORDER BY requested_at DESC, job_id DESC
              LIMIT ?
            `)
            .all(...params, limit + 1) as DelegationJobRecord[];
          const jobs: DelegationJob[] = [];
          let skipped = 0;
          for (const row of rows.slice(0, limit)) {
            const job = jobFromRecord(row);
            if (job) {
              jobs.push(job);
            } else {
              skipped++;
            }
          }
          return { jobs, skipped, truncated: rows.length > limit };
        },
        catch: (cause) => usageStoreReadError('queryDelegationJobs', input.dbPath, cause),
      }),
    );
  };

  const queryDelegationEvaluations = (
    input: QueryDelegationEvaluationsInput,
  ): Effect.Effect<QueryDelegationEvaluationsResult, UsageStoreError> => {
    if (input.jobIds.length > DELEGATION_STORE_BOUNDS.maxEvaluationJobIds) {
      return Effect.fail(
        usageStoreError(
          'queryDelegationEvaluations',
          input.dbPath,
          `At most ${DELEGATION_STORE_BOUNDS.maxEvaluationJobIds} job ids per read`,
          'invalid-input',
        ),
      );
    }
    if (input.jobIds.length === 0) {
      return Effect.succeed({ evaluations: [], skipped: 0 });
    }
    return withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          assertDelegationTables(db, (message) =>
            usageStoreError('queryDelegationEvaluations', input.dbPath, message, 'schema-too-old'),
          );
          const rows = db
            .query(`
              SELECT ${EVALUATION_COLUMNS} FROM delegation_evaluations
              WHERE job_id IN (${input.jobIds.map(() => '?').join(', ')})
              ORDER BY recorded_at DESC, evaluation_id DESC
            `)
            .all(...input.jobIds) as DelegationEvaluationRecord[];
          const evaluations: DelegationEvaluation[] = [];
          let skipped = 0;
          for (const row of rows) {
            const evaluation = evaluationFromRecord(row);
            if (evaluation) {
              evaluations.push(evaluation);
            } else {
              skipped++;
            }
          }
          return { evaluations, skipped };
        },
        catch: (cause) => usageStoreReadError('queryDelegationEvaluations', input.dbPath, cause),
      }),
    );
  };

  /**
   * The retry chain a request would join, counted with the rule of `requestDelegationJob` but
   * outside its transaction: what a qualification shows before a launch decides. The transaction
   * remains the authority at the insert.
   */
  const countDelegationRetryChain = (
    input: CountDelegationRetryChainInput,
  ): Effect.Effect<DelegationRetryChainCount, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          assertDelegationTables(db, (message) =>
            usageStoreError('countDelegationRetryChain', input.dbPath, message, 'schema-too-old'),
          );
          return countRetryChain(db, input.retryOf);
        },
        catch: (cause) => usageStoreReadError('countDelegationRetryChain', input.dbPath, cause),
      }),
    );

  const readFailure = (error: UsageStoreError): DelegationStoreReadFailure => {
    switch (error.reason) {
      case 'store-missing':
        return { kind: 'store-missing' };
      case 'schema-too-old':
        return { kind: 'store-not-upgraded', message: error.message };
      case 'corrupt':
      case 'schema-too-new':
        return { kind: 'incompatible-store', message: error.message, reason: error.reason };
      default:
        return { kind: 'unavailable', message: error.message, reason: error.reason };
    }
  };

  /**
   * The read an edge (MCP, CLI, Web) performs: jobs with their evaluations through the query-only
   * reader, never creating the store, with the storage failure classified instead of thrown.
   */
  const readDelegationJobs = (input: QueryDelegationJobsInput): Effect.Effect<DelegationJobsRead> =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          const jobs = yield* queryDelegationJobs(input);
          const evaluations = yield* queryDelegationEvaluations({
            dbPath: input.dbPath,
            jobIds: jobs.jobs.map((job) => job.jobId),
          });
          return {
            evaluations: evaluations.evaluations,
            jobs: jobs.jobs,
            kind: 'ok' as const,
            skipped: jobs.skipped + evaluations.skipped,
            truncated: jobs.truncated,
          };
        }),
      );
      return outcome._tag === 'Success' ? outcome.success : readFailure(outcome.failure);
    });

  const readDelegationJob = (input: ReadDelegationJobInput): Effect.Effect<DelegationJobRead> =>
    Effect.map(readDelegationJobs({ dbPath: input.dbPath, jobId: input.jobId, limit: 1 }), (read) => {
      if (read.kind !== 'ok') {
        return read;
      }
      const job = read.jobs[0];
      return job === undefined
        ? { kind: 'not-found', skipped: read.skipped }
        : { evaluations: read.evaluations, job, kind: 'ok', skipped: read.skipped };
    });

  return {
    countDelegationRetryChain,
    markDelegationJobsLost,
    queryDelegationEvaluations,
    queryDelegationJobs,
    readDelegationJob,
    readDelegationJobs,
    readDelegationQualification,
    recordDelegationEvaluation,
    recordDelegationQualification,
    releaseDelegationJobReservation,
    requestDelegationCancel,
    requestDelegationJob,
    transitionDelegationJob,
  };
};
