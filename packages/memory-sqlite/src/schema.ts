import { replicationOutboxSchemaSql } from '@ai-usage/replication-outbox';

export const LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION = 5;

export const localMemoryReplicationPublicationSchema = `
  CREATE TABLE IF NOT EXISTS replication_publication_contexts (
    local_space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    local_project_key TEXT NOT NULL,
    local_project_id TEXT,
    shared_device_id TEXT NOT NULL CHECK (length(shared_device_id) = 36),
    shared_person_id TEXT NOT NULL CHECK (length(shared_person_id) = 36),
    shared_space_id TEXT NOT NULL CHECK (length(shared_space_id) = 36),
    shared_project_id TEXT CHECK (shared_project_id IS NULL OR length(shared_project_id) = 36),
    capture_context_id TEXT NOT NULL UNIQUE CHECK (length(capture_context_id) = 36),
    source TEXT NOT NULL CHECK (source IN ('explicit', 'personal-fallback', 'project-rule', 'unassigned')),
    configured_at TEXT NOT NULL,
    PRIMARY KEY (local_space_id, local_project_key),
    FOREIGN KEY (local_project_id, local_space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT,
    CHECK (local_project_key = IFNULL(local_project_id, '')),
    CHECK ((local_project_id IS NULL) = (shared_project_id IS NULL))
  ) STRICT;
`;

export const localMemoryIdentitySchema = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind = 'personal'),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE people (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
    personal_space_id TEXT NOT NULL UNIQUE REFERENCES spaces (id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended'))
  ) STRICT;

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    owner_person_id TEXT NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 256),
    status TEXT NOT NULL CHECK (status IN ('local', 'pending', 'active', 'revoked')),
    last_seen_at TEXT,
    UNIQUE (id, space_id)
  ) STRICT;

  CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'generic')),
    provider_repository_id TEXT,
    canonical_host TEXT NOT NULL CHECK (length(canonical_host) BETWEEN 1 AND 256),
    canonical_owner TEXT,
    canonical_name TEXT NOT NULL CHECK (length(canonical_name) BETWEEN 1 AND 256),
    status TEXT NOT NULL CHECK (status IN ('active', 'renamed', 'archived', 'unknown')),
    UNIQUE (id, space_id)
  ) STRICT;

  CREATE UNIQUE INDEX repositories_provider_identity_unique
    ON repositories (space_id, provider, provider_repository_id)
    WHERE provider_repository_id IS NOT NULL;

  CREATE TABLE repository_aliases (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    normalized_remote TEXT NOT NULL CHECK (length(normalized_remote) BETWEEN 1 AND 2048),
    source TEXT NOT NULL CHECK (source IN ('local-git', 'provider-api', 'manual')),
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT,
    UNIQUE (id, space_id),
    UNIQUE (space_id, normalized_remote),
    FOREIGN KEY (repository_id, space_id)
      REFERENCES repositories (id, space_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('repository', 'local')),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
    repository_id TEXT,
    repository_subpath TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    UNIQUE (id, space_id),
    FOREIGN KEY (repository_id, space_id)
      REFERENCES repositories (id, space_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE UNIQUE INDEX projects_repository_subpath_unique
    ON projects (space_id, repository_id, IFNULL(repository_subpath, ''))
    WHERE repository_id IS NOT NULL;

  CREATE TABLE checkouts (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    project_id TEXT,
    device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
    local_path TEXT NOT NULL CHECK (length(local_path) BETWEEN 1 AND 4096),
    repository_id TEXT,
    observed_remote TEXT,
    status TEXT NOT NULL CHECK (status IN ('available', 'missing', 'unknown')),
    resolution_status TEXT NOT NULL DEFAULT 'unassigned'
      CHECK (resolution_status IN ('resolved', 'ambiguous', 'candidate', 'unassigned')),
    resolution_reviewed_at TEXT,
    last_observed_at TEXT NOT NULL,
    UNIQUE (id, space_id),
    UNIQUE (device_id, local_path),
    FOREIGN KEY (project_id, space_id)
      REFERENCES projects (id, space_id) ON DELETE RESTRICT,
    FOREIGN KEY (repository_id, space_id)
      REFERENCES repositories (id, space_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE checkout_resolution_candidates (
    checkout_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    PRIMARY KEY (checkout_id, repository_id),
    FOREIGN KEY (checkout_id, space_id)
      REFERENCES checkouts (id, space_id) ON DELETE CASCADE,
    FOREIGN KEY (repository_id, space_id)
      REFERENCES repositories (id, space_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE capture_contexts (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
    person_id TEXT NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    project_id TEXT,
    source TEXT NOT NULL CHECK (source IN ('explicit', 'project-rule', 'personal-fallback', 'unassigned')),
    UNIQUE (id, space_id),
    FOREIGN KEY (project_id, space_id)
      REFERENCES projects (id, space_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE identity_events (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
    subject_type TEXT NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 128),
    subject_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}'
  ) STRICT;

  CREATE TABLE project_source_mappings (
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    project_source_id TEXT NOT NULL CHECK (length(project_source_id) BETWEEN 1 AND 4096),
    project_id TEXT NOT NULL,
    checkout_id TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL,
    PRIMARY KEY (space_id, project_source_id),
    FOREIGN KEY (project_id, space_id)
      REFERENCES projects (id, space_id) ON DELETE RESTRICT,
    FOREIGN KEY (checkout_id, space_id)
      REFERENCES checkouts (id, space_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE local_identity_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    person_id TEXT NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
    personal_space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE RESTRICT
  ) STRICT;
`;

export const localMemoryDomainSchema = `
  CREATE TABLE memory_observations (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    project_id TEXT,
    capture_context_id TEXT,
    source_kind TEXT NOT NULL
      CHECK (source_kind IN ('user', 'agent', 'session', 'file', 'commit', 'pull-request', 'import')),
    source_locator TEXT CHECK (source_locator IS NULL OR length(source_locator) BETWEEN 1 AND 4096),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    observed_at TEXT NOT NULL,
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
    redaction_rule_set_version TEXT NOT NULL CHECK (redaction_rule_set_version = 'memory-redaction-v1'),
    created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('person', 'service')),
    created_by_id TEXT NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 256),
    UNIQUE (id, space_id),
    UNIQUE (space_id, fingerprint),
    FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT,
    FOREIGN KEY (capture_context_id, space_id) REFERENCES capture_contexts (id, space_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE memory_proposals (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    project_id TEXT,
    proposed_kind TEXT NOT NULL
      CHECK (proposed_kind IN ('decision', 'pattern', 'pitfall', 'command', 'constraint', 'handoff', 'lesson', 'preference')),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    summary TEXT NOT NULL CHECK (length(summary) <= 16384),
    guidance_json TEXT NOT NULL CHECK (json_valid(guidance_json)),
    structured_content_json TEXT NOT NULL CHECK (json_valid(structured_content_json)),
    trust_candidate TEXT NOT NULL CHECK (trust_candidate IN ('explicit', 'harvest-accepted')),
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
    proposed_by_kind TEXT NOT NULL CHECK (proposed_by_kind IN ('person', 'service')),
    proposed_by_id TEXT NOT NULL CHECK (length(proposed_by_id) BETWEEN 1 AND 256),
    reviewed_by_person_id TEXT REFERENCES people (id) ON DELETE RESTRICT,
    reviewed_at TEXT,
    review_reason TEXT CHECK (review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 4096),
    accepted_memory_item_id TEXT,
    UNIQUE (id, space_id),
    FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT,
    FOREIGN KEY (accepted_memory_item_id, space_id)
      REFERENCES memory_items (id, space_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (status = 'pending' AND reviewed_by_person_id IS NULL AND reviewed_at IS NULL
        AND review_reason IS NULL AND accepted_memory_item_id IS NULL)
      OR (status = 'accepted' AND reviewed_by_person_id IS NOT NULL AND reviewed_at IS NOT NULL
        AND accepted_memory_item_id IS NOT NULL)
      OR (status IN ('rejected', 'superseded') AND reviewed_by_person_id IS NOT NULL
        AND reviewed_at IS NOT NULL AND accepted_memory_item_id IS NULL)
    )
  ) STRICT;

  CREATE TABLE memory_proposal_observations (
    space_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    PRIMARY KEY (proposal_id, observation_id),
    FOREIGN KEY (proposal_id, space_id) REFERENCES memory_proposals (id, space_id) ON DELETE CASCADE,
    FOREIGN KEY (observation_id, space_id) REFERENCES memory_observations (id, space_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE memory_items (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    project_id TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('project', 'space', 'person')),
    kind TEXT NOT NULL
      CHECK (kind IN ('decision', 'pattern', 'pitfall', 'command', 'constraint', 'handoff', 'lesson', 'preference')),
    status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rejected', 'archived')),
    trust TEXT NOT NULL CHECK (trust IN ('explicit', 'harvest-accepted')),
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
    current_revision_id TEXT NOT NULL,
    UNIQUE (id, space_id),
    FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT,
    FOREIGN KEY (current_revision_id, id, space_id)
      REFERENCES memory_revisions (id, memory_item_id, space_id) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE TABLE memory_revisions (
    id TEXT PRIMARY KEY,
    memory_item_id TEXT NOT NULL,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    summary TEXT NOT NULL CHECK (length(summary) <= 16384),
    guidance_json TEXT NOT NULL CHECK (json_valid(guidance_json)),
    structured_content_json TEXT NOT NULL CHECK (json_valid(structured_content_json)),
    created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('person', 'service')),
    created_by_id TEXT NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 256),
    created_at TEXT NOT NULL,
    reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 4096),
    UNIQUE (id, memory_item_id, space_id),
    UNIQUE (memory_item_id, revision_number),
    FOREIGN KEY (memory_item_id, space_id)
      REFERENCES memory_items (id, space_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE TABLE memory_privacy_purge_context (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
  ) STRICT;

  CREATE TRIGGER memory_revisions_immutable_update
  BEFORE UPDATE ON memory_revisions BEGIN SELECT RAISE(ABORT, 'memory revisions are immutable'); END;
  CREATE TRIGGER memory_revisions_immutable_delete
  BEFORE DELETE ON memory_revisions
  WHEN NOT EXISTS (SELECT 1 FROM memory_privacy_purge_context WHERE singleton = 1)
  BEGIN SELECT RAISE(ABORT, 'memory revisions are immutable'); END;
  CREATE TRIGGER memory_observations_immutable_update
  BEFORE UPDATE ON memory_observations BEGIN SELECT RAISE(ABORT, 'memory observations are immutable'); END;
  CREATE TRIGGER memory_observations_immutable_delete
  BEFORE DELETE ON memory_observations
  WHEN NOT EXISTS (SELECT 1 FROM memory_privacy_purge_context WHERE singleton = 1)
  BEGIN SELECT RAISE(ABORT, 'memory observations are immutable'); END;

  CREATE TABLE memory_relations (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    from_memory_item_id TEXT NOT NULL,
    to_memory_item_id TEXT NOT NULL,
    relation_kind TEXT NOT NULL
      CHECK (relation_kind IN ('supports', 'supersedes', 'contradicts', 'derived-from', 'related-to', 'applies-to')),
    created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('person', 'service')),
    created_by_id TEXT NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 256),
    created_at TEXT NOT NULL,
    reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 4096),
    UNIQUE (space_id, from_memory_item_id, to_memory_item_id, relation_kind),
    CHECK (from_memory_item_id <> to_memory_item_id),
    FOREIGN KEY (from_memory_item_id, space_id) REFERENCES memory_items (id, space_id) ON DELETE RESTRICT,
    FOREIGN KEY (to_memory_item_id, space_id) REFERENCES memory_items (id, space_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE memory_imports (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    project_id TEXT,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('legacy-markdown', 'legacy-jsonl')),
    source_locator TEXT NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 4096),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    preview_proof TEXT NOT NULL CHECK (length(preview_proof) = 64),
    status TEXT NOT NULL CHECK (status IN ('previewed', 'confirmed', 'quarantined', 'stale')),
    created_at TEXT NOT NULL,
    confirmed_by_person_id TEXT REFERENCES people (id) ON DELETE RESTRICT,
    confirmed_at TEXT,
    UNIQUE (space_id, fingerprint),
    FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT
  ) STRICT;

  ${replicationOutboxSchemaSql}

  CREATE TABLE memory_audit_events (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('person', 'service')),
    actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
    action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
    subject_type TEXT NOT NULL
      CHECK (subject_type IN ('memory-observation', 'memory-proposal', 'memory-item', 'memory-relation', 'memory-import')),
    subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
    result TEXT NOT NULL CHECK (result IN ('allowed', 'denied', 'applied', 'rejected')),
    recorded_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX memory_observations_space_project_idx ON memory_observations (space_id, project_id, observed_at);
  CREATE INDEX memory_proposals_space_status_idx ON memory_proposals (space_id, status, id);
  CREATE INDEX memory_items_space_status_idx ON memory_items (space_id, status, id);
  CREATE INDEX memory_revisions_item_idx ON memory_revisions (memory_item_id, revision_number);
  CREATE INDEX memory_relations_from_idx ON memory_relations (space_id, from_memory_item_id, relation_kind);
  CREATE INDEX memory_audit_subject_idx ON memory_audit_events (space_id, subject_type, subject_id, recorded_at);
`;

export const localMemoryImportStateSchema = `
  CREATE TABLE IF NOT EXISTS memory_privacy_purge_context (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
  ) STRICT;

  DROP TRIGGER IF EXISTS memory_revisions_immutable_delete;
  CREATE TRIGGER memory_revisions_immutable_delete
  BEFORE DELETE ON memory_revisions
  WHEN NOT EXISTS (SELECT 1 FROM memory_privacy_purge_context WHERE singleton = 1)
  BEGIN SELECT RAISE(ABORT, 'memory revisions are immutable'); END;

  DROP TRIGGER IF EXISTS memory_observations_immutable_delete;
  CREATE TRIGGER memory_observations_immutable_delete
  BEFORE DELETE ON memory_observations
  WHEN NOT EXISTS (SELECT 1 FROM memory_privacy_purge_context WHERE singleton = 1)
  BEGIN SELECT RAISE(ABORT, 'memory observations are immutable'); END;

  CREATE TABLE memory_space_state (
    space_id TEXT PRIMARY KEY REFERENCES spaces (id) ON DELETE RESTRICT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
  ) STRICT;

  INSERT INTO memory_space_state (space_id, version)
  SELECT id, 0 FROM spaces;
`;

export const localMemoryProposalAcceptanceLinkUpgrade = `
  ALTER TABLE memory_proposals
    ADD COLUMN accepted_memory_item_id TEXT
    REFERENCES memory_items (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
`;

export const localMemorySearchSchema = `
  CREATE TABLE memory_search_chunks (
    rowid INTEGER PRIMARY KEY,
    chunk_id TEXT NOT NULL UNIQUE CHECK (length(chunk_id) = 64),
    chunk_ordinal INTEGER NOT NULL CHECK (chunk_ordinal >= 0),
    chunker_version TEXT NOT NULL CHECK (chunker_version = 'memory-search-chunker-v1'),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    space_id TEXT NOT NULL,
    project_id TEXT,
    memory_item_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    scope TEXT NOT NULL CHECK (scope IN ('project', 'space', 'person')),
    kind TEXT NOT NULL
      CHECK (kind IN ('decision', 'pattern', 'pitfall', 'command', 'constraint', 'handoff', 'lesson', 'preference')),
    status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rejected', 'archived')),
    trust TEXT NOT NULL CHECK (trust IN ('explicit', 'harvest-accepted')),
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    summary TEXT NOT NULL CHECK (length(summary) <= 2048),
    guidance TEXT NOT NULL CHECK (length(guidance) <= 2048),
    structured_terms TEXT NOT NULL CHECK (length(structured_terms) <= 2048),
    supporting_text TEXT NOT NULL CHECK (length(supporting_text) <= 2048),
    normalized_title TEXT NOT NULL CHECK (length(normalized_title) BETWEEN 1 AND 512),
    normalized_summary TEXT NOT NULL CHECK (length(normalized_summary) <= 2048),
    normalized_guidance TEXT NOT NULL CHECK (length(normalized_guidance) <= 2048),
    normalized_structured_terms TEXT NOT NULL CHECK (length(normalized_structured_terms) <= 2048),
    normalized_supporting_text TEXT NOT NULL CHECK (length(normalized_supporting_text) <= 2048),
    UNIQUE (memory_item_id, revision_id, chunk_ordinal),
    FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT,
    FOREIGN KEY (memory_item_id, space_id) REFERENCES memory_items (id, space_id) ON DELETE CASCADE,
    FOREIGN KEY (revision_id, memory_item_id, space_id)
      REFERENCES memory_revisions (id, memory_item_id, space_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX memory_search_chunks_scope_idx
    ON memory_search_chunks (space_id, project_id, status, trust, kind, memory_item_id);

  CREATE VIRTUAL TABLE memory_search_fts USING fts5(
    title,
    summary,
    guidance,
    structured_terms,
    supporting_text,
    content = 'memory_search_chunks',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3 4'
  );

  CREATE VIRTUAL TABLE memory_search_trigram_fts USING fts5(
    title,
    summary,
    guidance,
    structured_terms,
    supporting_text,
    content = 'memory_search_chunks',
    content_rowid = 'rowid',
    tokenize = 'trigram'
  );

  CREATE TRIGGER memory_search_chunks_insert
  AFTER INSERT ON memory_search_chunks BEGIN
    INSERT INTO memory_search_fts
      (rowid, title, summary, guidance, structured_terms, supporting_text)
    VALUES
      (new.rowid, new.title, new.summary, new.guidance, new.structured_terms, new.supporting_text);
    INSERT INTO memory_search_trigram_fts
      (rowid, title, summary, guidance, structured_terms, supporting_text)
    VALUES
      (new.rowid, new.title, new.summary, new.guidance, new.structured_terms, new.supporting_text);
  END;

  CREATE TRIGGER memory_search_chunks_delete
  AFTER DELETE ON memory_search_chunks BEGIN
    INSERT INTO memory_search_fts
      (memory_search_fts, rowid, title, summary, guidance, structured_terms, supporting_text)
    VALUES
      ('delete', old.rowid, old.title, old.summary, old.guidance, old.structured_terms, old.supporting_text);
    INSERT INTO memory_search_trigram_fts
      (memory_search_trigram_fts, rowid, title, summary, guidance, structured_terms, supporting_text)
    VALUES
      ('delete', old.rowid, old.title, old.summary, old.guidance, old.structured_terms, old.supporting_text);
  END;

  CREATE TRIGGER memory_search_chunks_update
  AFTER UPDATE ON memory_search_chunks BEGIN
    INSERT INTO memory_search_fts
      (memory_search_fts, rowid, title, summary, guidance, structured_terms, supporting_text)
    VALUES
      ('delete', old.rowid, old.title, old.summary, old.guidance, old.structured_terms, old.supporting_text);
    INSERT INTO memory_search_fts
      (rowid, title, summary, guidance, structured_terms, supporting_text)
    VALUES
      (new.rowid, new.title, new.summary, new.guidance, new.structured_terms, new.supporting_text);
    INSERT INTO memory_search_trigram_fts
      (memory_search_trigram_fts, rowid, title, summary, guidance, structured_terms, supporting_text)
    VALUES
      ('delete', old.rowid, old.title, old.summary, old.guidance, old.structured_terms, old.supporting_text);
    INSERT INTO memory_search_trigram_fts
      (rowid, title, summary, guidance, structured_terms, supporting_text)
    VALUES
      (new.rowid, new.title, new.summary, new.guidance, new.structured_terms, new.supporting_text);
  END;

  CREATE TABLE memory_search_projection_state (
    space_id TEXT PRIMARY KEY REFERENCES spaces (id) ON DELETE CASCADE,
    source_state_version INTEGER NOT NULL DEFAULT -1 CHECK (source_state_version >= -1),
    chunker_version TEXT NOT NULL CHECK (chunker_version = 'memory-search-chunker-v1')
  ) STRICT;

  INSERT INTO memory_search_projection_state (space_id, source_state_version, chunker_version)
  SELECT id, -1, 'memory-search-chunker-v1' FROM spaces;
`;
