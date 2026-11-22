// Work fact tables and their additive migration. Imports no store module, so `migration.ts` can import it.

import type { SqliteDatabase } from './sqlite-database';

/** The outcome codes a run state row may carry; the column's CHECK and the rebuild's row filter. */
const OUTCOME_CODE_ACCEPTED_SQL = "outcome_code IS NULL OR outcome_code = 'unauthenticated'";
const OUTCOME_CODE_CHECK_SQL = `CHECK (${OUTCOME_CODE_ACCEPTED_SQL})`;

// The run state columns, shared by the fresh table and its rebuild. The text, newlines and indentation
// included, is what a fresh store's `sqlite_schema` holds; it must not change.
const workFactRunStateColumnsSql = `
    source_id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    ran_at TEXT NOT NULL,
    observed INTEGER NOT NULL CHECK (observed >= 0),
    failed INTEGER NOT NULL CHECK (failed >= 0),
    disabled INTEGER NOT NULL CHECK (disabled IN (0, 1)),
    message TEXT,
    outcome_code TEXT ${OUTCOME_CODE_CHECK_SQL}
  `;

export const workFactSchemaSql = `
  CREATE TABLE IF NOT EXISTS pull_request_observations (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    host TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0),
    observed_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    outcome_message TEXT,
    account_label TEXT,
    state TEXT,
    draft INTEGER CHECK (draft IN (0, 1)),
    review_decision TEXT,
    merged_at TEXT,
    updated_at TEXT,
    title TEXT,
    url TEXT,
    head_ref TEXT,
    base_ref TEXT,
    checks_rollup TEXT,
    discovery_role TEXT,
    mergeable TEXT,
    merge_state_status TEXT,
    created_at TEXT,
    closed_at TEXT,
    unresolved_review_threads INTEGER,
    cross_repository INTEGER,
    history TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pull_request_observations_identity
    ON pull_request_observations(machine_id, host, repository, number, observed_at DESC);

  CREATE TABLE IF NOT EXISTS checkout_status_observations (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    checkout_path TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    branch TEXT,
    head_sha TEXT,
    upstream TEXT,
    ahead INTEGER CHECK (ahead IS NULL OR ahead >= 0),
    behind INTEGER CHECK (behind IS NULL OR behind >= 0),
    staged_count INTEGER CHECK (staged_count IS NULL OR staged_count >= 0),
    modified_count INTEGER CHECK (modified_count IS NULL OR modified_count >= 0),
    untracked_count INTEGER CHECK (untracked_count IS NULL OR untracked_count >= 0),
    last_commit_at TEXT,
    counts_changed_at TEXT,
    dirty INTEGER CHECK (dirty IN (0, 1))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_status_observations_identity
    ON checkout_status_observations(machine_id, checkout_path, observed_at DESC);

  CREATE TABLE IF NOT EXISTS jira_issue_observations (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    issue_key TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    outcome_message TEXT,
    status TEXT,
    status_category TEXT,
    summary TEXT,
    updated_at TEXT,
    assignee_label TEXT,
    sprint TEXT,
    parent_key TEXT,
    comment_count INTEGER CHECK (comment_count IS NULL OR comment_count >= 0),
    comments_json TEXT NOT NULL,
    url TEXT,
    handed_off INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_issue_observations_identity
    ON jira_issue_observations(machine_id, issue_key, observed_at DESC);

  CREATE TABLE IF NOT EXISTS jira_sync_state (
    machine_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_fact_run_state (${workFactRunStateColumnsSql}) WITHOUT ROWID;
`;

export const WORK_FACT_TABLES = [
  'pull_request_observations',
  'checkout_status_observations',
  'jira_issue_observations',
  'work_fact_run_state',
  'jira_sync_state',
] as const;

/** Presence-based, additive migration; only called by the usage-store writer. */
export const migrateWorkFactSchema = (db: Pick<SqliteDatabase, 'exec' | 'query'>): boolean => {
  let changed = false;
  for (const [table, additions] of [
    [
      'pull_request_observations',
      [
        'discovery_role',
        'mergeable',
        'merge_state_status',
        'created_at',
        'closed_at',
        'unresolved_review_threads',
        'cross_repository',
        'history',
      ],
    ],
    ['checkout_status_observations', ['counts_changed_at']],
    ['jira_issue_observations', ['url', 'handed_off']],
    ['work_fact_run_state', ['outcome_code']],
  ] as const) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    for (const name of additions) {
      if (!columns.some((column) => column.name === name)) {
        const type = ['unresolved_review_threads', 'handed_off', 'cross_repository'].includes(name)
          ? 'INTEGER'
          : 'TEXT';
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        changed = true;
      }
    }
  }
  return changed;
};

/**
 * A column check cannot be altered in SQLite, and the additive `outcome_code` above carries none. A
 * `work_fact_run_state` whose stored definition lacks the outcome code CHECK is rebuilt under the same name
 * (still `WITHOUT ROWID`), inside the caller's migration transaction, after `migrateWorkFactSchema` added
 * the column. Every row the CHECK accepts is copied unchanged. A row whose code it refuses is not copied:
 * copying it with a null code would make an invalid row look valid, and failing the migration would make the
 * store unopenable over one row. Every writer in the repository's history checks the code first, so such a
 * row only comes from a hand edit. The drop is visible: before it, the reader skips and counts the row, and
 * `sourcesOf` in report-data shows a source with no valid run as `unavailable` ("Some source run records
 * could not be read."); after it, that source shows as `never-run`, with no message, until its next run
 * writes its one row (keyed by `source_id`) again. No index, trigger, view or foreign key refers to the table. `true` when a rebuild ran; a second
 * call finds the CHECK and changes nothing. Only `migrate()` calls it.
 */
export const rebuildWorkFactRunStateForOutcomeCode = (db: Pick<SqliteDatabase, 'exec' | 'query'>): boolean => {
  const stored = db
    .query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'work_fact_run_state'")
    .get() as { sql?: unknown } | null;
  if (typeof stored?.sql !== 'string' || stored.sql.includes(OUTCOME_CODE_CHECK_SQL)) {
    return false;
  }
  db.exec('DROP TABLE IF EXISTS work_fact_run_state_rebuilt');
  db.exec(`CREATE TABLE work_fact_run_state_rebuilt (${workFactRunStateColumnsSql}) WITHOUT ROWID`);
  const names = (db.query('PRAGMA table_info(work_fact_run_state_rebuilt)').all() as { name?: unknown }[])
    .map((column) => column.name)
    .filter((name): name is string => typeof name === 'string')
    .join(', ');
  db.exec(
    `INSERT INTO work_fact_run_state_rebuilt (${names}) SELECT ${names} FROM work_fact_run_state WHERE (${OUTCOME_CODE_ACCEPTED_SQL})`,
  );
  db.exec('DROP TABLE work_fact_run_state');
  db.exec('ALTER TABLE work_fact_run_state_rebuilt RENAME TO work_fact_run_state');
  return true;
};
