// Claude Desktop session tables. Imports no store module, so `migration.ts` can import it.

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
