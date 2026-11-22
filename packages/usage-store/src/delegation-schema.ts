// Delegation tables and their migration. Imports no store module, so `migration.ts` can import it.

import {
  DELEGATION_ACCEPTANCE_VERDICTS,
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
  DELEGATION_VERIFICATION_VERDICTS,
} from '@ai-usage/report-core/delegation-vocabulary';

export const DELEGATION_TABLES = ['delegation_jobs', 'delegation_evaluations', 'delegation_qualifications'] as const;

const sqlList = (values: readonly string[]): string => `(${values.map((value) => `'${value}'`).join(', ')})`;

/** The reserving predicate, shared by the unique index and every read that must agree with it. */
export const RESERVING_SQL = `(state IN ${sqlList(DELEGATION_LIVE_STATES)} OR (state = 'lost' AND released_at IS NULL))`;
export const LIVE_SQL = `state IN ${sqlList(DELEGATION_LIVE_STATES)}`;

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

export const tableMissing = (db: MigrationDatabase, table: string): boolean =>
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
