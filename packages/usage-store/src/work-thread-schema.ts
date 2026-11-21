/** Operator-owned state, outside served revisions and collection generations. */
export const WORK_THREAD_TABLES = [
  'work_threads',
  'work_thread_links',
  'work_thread_events',
  'work_thread_commands',
  'work_jira_intake',
  'work_thread_combinations',
  'work_session_branches',
  'work_session_branch_builds',
  'work_branch_reconciliation',
] as const;

export const workThreadSchemaSql = `
  CREATE TABLE IF NOT EXISTS work_threads (
    thread_id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    title TEXT NOT NULL,
    objective TEXT,
    project_label TEXT,
    intent TEXT CHECK (intent IS NULL OR intent IN ('analysis', 'change', 'review')),
    origin TEXT NOT NULL CHECK (origin IN ('user', 'pull-request', 'jira-issue', 'session')),
    origin_key TEXT UNIQUE,
    follow_state TEXT NOT NULL CHECK (follow_state IN ('following', 'waiting', 'done')),
    follow_revision INTEGER NOT NULL CHECK (follow_revision >= 1),
    waiting_for TEXT,
    waiting_on_json TEXT,
    done_at TEXT,
    done_reason TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    CHECK ((origin = 'user') = (origin_key IS NULL)),
    CHECK ((follow_state = 'done') = (done_at IS NOT NULL)),
    CHECK (follow_state = 'done' OR done_reason IS NULL),
    CHECK (follow_state = 'waiting' OR (waiting_for IS NULL AND waiting_on_json IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_work_threads_activity ON work_threads(last_activity_at DESC, thread_id);
  CREATE INDEX IF NOT EXISTS idx_work_threads_scope
    ON work_threads(follow_state, project_label, last_activity_at DESC, thread_id);
  CREATE TABLE IF NOT EXISTS work_thread_links (
    link_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES work_threads(thread_id),
    kind TEXT NOT NULL CHECK (kind IN ('pull-request', 'jira-issue', 'session', 'branch')),
    link_key TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance IN ('user', 'origin', 'declared', 'launched')),
    created_at TEXT NOT NULL,
    detached_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_thread_active_link
    ON work_thread_links(thread_id, kind, link_key) WHERE detached_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_work_thread_link_history ON work_thread_links(thread_id, detached_at DESC);
  CREATE TABLE IF NOT EXISTS work_thread_events (
    event_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES work_threads(thread_id),
    at TEXT NOT NULL,
    event_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_work_thread_events ON work_thread_events(thread_id, at DESC);
  CREATE TABLE IF NOT EXISTS work_thread_commands (
    command_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_thread_combinations (
    combination_id INTEGER PRIMARY KEY,
    member_thread_id TEXT NOT NULL REFERENCES work_threads(thread_id),
    kept_thread_id TEXT NOT NULL REFERENCES work_threads(thread_id),
    ticket_key TEXT NOT NULL,
    combined_at TEXT NOT NULL,
    combine_command_id TEXT NOT NULL,
    separated_at TEXT,
    separate_command_id TEXT,
    CHECK (member_thread_id != kept_thread_id),
    CHECK ((separated_at IS NULL) = (separate_command_id IS NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_thread_combinations_active
    ON work_thread_combinations(member_thread_id) WHERE separated_at IS NULL;
  CREATE TABLE IF NOT EXISTS work_jira_intake (
    machine_id TEXT NOT NULL,
    link_key TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    assigned INTEGER NOT NULL CHECK (assigned IN (0, 1)),
    assigned_at TEXT NOT NULL,
    dismissed_at TEXT,
    PRIMARY KEY (machine_id, link_key)
  );
  -- Branch evidence (ADR 0081): which sessions recorded which repository branch, rebuilt by the
  -- engine from the served revision. Derived and disposable; tasks hold the branch links.
  CREATE TABLE IF NOT EXISTS work_session_branches (
    revision TEXT NOT NULL,
    link_key TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('interactive', 'exec', 'delegated', 'review', 'unknown')),
    repository_label TEXT NOT NULL,
    started_at TEXT,
    title TEXT,
    source_path TEXT,
    PRIMARY KEY (revision, link_key, machine_id, harness, session_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_work_session_branches_key
    ON work_session_branches(link_key, machine_id, role, started_at);
  CREATE TABLE IF NOT EXISTS work_session_branch_builds (
    revision TEXT PRIMARY KEY,
    built_at TEXT NOT NULL,
    aliases_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_branch_reconciliation (
    machine_id TEXT PRIMARY KEY,
    creation_cutoff_at TEXT NOT NULL
  );
`;
