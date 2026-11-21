// Codex work evidence tables. Imports no store module, so `migration.ts` can import it.

export const CODEX_WORK_TABLES = ['codex_work_observations', 'codex_work_collection_coverage'] as const;

/** Auxiliary local evidence, excluded from report generations and snapshots. */
export const codexWorkSchemaSql = `
  CREATE TABLE IF NOT EXISTS codex_work_observations (
    machine_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    last_event_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    PRIMARY KEY (machine_id, source_session_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS codex_work_collection_coverage (
    machine_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    collection_id TEXT NOT NULL,
    complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
    PRIMARY KEY (machine_id, source_session_id)
  ) WITHOUT ROWID;
`;
