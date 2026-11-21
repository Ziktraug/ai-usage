// Review attempt table and its migration. Imports no store module, so `migration.ts` can import it.

import { REVIEW_RESERVATION_RELEASE_EVIDENCE } from '@ai-usage/report-core/work-attempts';

export const REVIEW_ATTEMPT_TABLES = ['review_attempts'] as const;

/** The reserving predicate, shared by the unique index and the reads that must agree with it. */
export const RESERVING_SQL =
  "(state IN ('requested', 'starting', 'running') OR (state = 'lost' AND released_at IS NULL))";

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
