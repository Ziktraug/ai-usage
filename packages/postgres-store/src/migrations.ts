import { PlatformStoreError } from './errors';
import { PLATFORM_SCHEMA_METADATA_KEY, PLATFORM_SCHEMA_VERSION } from './schema';

export interface PlatformMigration {
  readonly id: string;
  readonly ordinal: number;
  readonly up: string;
}

export type PlatformMigrationMode = 'apply' | 'verify';

export type PlatformMigrationTrace =
  | { readonly type: 'lock-acquired' }
  | { readonly id: string; readonly ordinal: number; readonly type: 'migration-applied' }
  | { readonly type: 'lock-released' };

export interface PlatformMigrationRunOptions {
  readonly migrations?: readonly PlatformMigration[];
  readonly mode: PlatformMigrationMode;
  readonly onTrace?: (event: PlatformMigrationTrace) => void;
}

export interface PlatformMigrationRunResult {
  readonly appliedIds: readonly string[];
  readonly currentOrdinal: number;
}

export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] = Object.freeze([
  Object.freeze({
    id: '0001_platform_schema_metadata',
    ordinal: 1,
    up: `
      CREATE TABLE platform_schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      INSERT INTO platform_schema_metadata (key, value)
      VALUES ('${PLATFORM_SCHEMA_METADATA_KEY}', '${PLATFORM_SCHEMA_VERSION}');
    `,
  }),
  Object.freeze({
    id: '0002_identity_kernel',
    ordinal: 2,
    up: `
      CREATE TABLE spaces (
        id UUID PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('personal', 'organization')),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (id, kind)
      );

      CREATE TABLE people (
        id UUID PRIMARY KEY,
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
        personal_space_id UUID NOT NULL UNIQUE,
        personal_space_kind TEXT NOT NULL DEFAULT 'personal' CHECK (personal_space_kind = 'personal'),
        status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
        FOREIGN KEY (personal_space_id, personal_space_kind)
          REFERENCES spaces (id, kind) ON DELETE RESTRICT
      );

      CREATE TABLE devices (
        id UUID PRIMARY KEY,
        owner_person_id UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 256),
        status TEXT NOT NULL CHECK (status IN ('local', 'pending', 'active', 'revoked')),
        last_seen_at TIMESTAMPTZ,
        UNIQUE (id, space_id)
      );

      CREATE TABLE scm_accounts (
        id UUID PRIMARY KEY,
        person_id UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'generic')),
        provider_account_id TEXT NOT NULL CHECK (length(provider_account_id) BETWEEN 1 AND 256),
        handle TEXT CHECK (handle IS NULL OR length(handle) BETWEEN 1 AND 256),
        UNIQUE (provider, provider_account_id)
      );

      CREATE TABLE scm_installations (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'generic')),
        provider_installation_id TEXT NOT NULL CHECK (length(provider_installation_id) BETWEEN 1 AND 256),
        selected_repository_ids TEXT[] NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
        UNIQUE (id, space_id),
        UNIQUE (provider, provider_installation_id, space_id)
      );

      CREATE TABLE scm_credentials (
        id UUID PRIMARY KEY,
        account_id UUID REFERENCES scm_accounts (id) ON DELETE RESTRICT,
        installation_id UUID REFERENCES scm_installations (id) ON DELETE RESTRICT,
        encrypted_secret_reference TEXT NOT NULL CHECK (length(encrypted_secret_reference) BETWEEN 1 AND 1024),
        created_at TIMESTAMPTZ NOT NULL,
        rotated_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        CHECK ((account_id IS NOT NULL)::INTEGER + (installation_id IS NOT NULL)::INTEGER = 1)
      );

      CREATE TABLE repositories (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'generic')),
        provider_repository_id TEXT,
        canonical_host TEXT NOT NULL CHECK (length(canonical_host) BETWEEN 1 AND 256),
        canonical_owner TEXT CHECK (canonical_owner IS NULL OR length(canonical_owner) BETWEEN 1 AND 1024),
        canonical_name TEXT NOT NULL CHECK (length(canonical_name) BETWEEN 1 AND 256),
        status TEXT NOT NULL CHECK (status IN ('active', 'renamed', 'archived', 'unknown')),
        UNIQUE (id, space_id)
      );

      CREATE UNIQUE INDEX repositories_provider_identity_unique
        ON repositories (space_id, provider, provider_repository_id)
        WHERE provider_repository_id IS NOT NULL;

      CREATE TABLE repository_aliases (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL,
        repository_id UUID NOT NULL,
        normalized_remote TEXT NOT NULL CHECK (length(normalized_remote) BETWEEN 1 AND 2048),
        source TEXT NOT NULL CHECK (source IN ('local-git', 'provider-api', 'manual')),
        first_observed_at TIMESTAMPTZ NOT NULL,
        last_observed_at TIMESTAMPTZ,
        UNIQUE (id, space_id),
        UNIQUE (space_id, normalized_remote),
        FOREIGN KEY (repository_id, space_id)
          REFERENCES repositories (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE projects (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('repository', 'local')),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
        repository_id UUID,
        repository_subpath TEXT CHECK (repository_subpath IS NULL OR length(repository_subpath) BETWEEN 1 AND 1024),
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        UNIQUE (id, space_id),
        FOREIGN KEY (repository_id, space_id)
          REFERENCES repositories (id, space_id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX projects_repository_subpath_unique
        ON projects (space_id, repository_id, COALESCE(repository_subpath, ''))
        WHERE repository_id IS NOT NULL;

      CREATE TABLE checkouts (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        project_id UUID,
        device_id UUID NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
        local_path TEXT NOT NULL CHECK (length(local_path) BETWEEN 1 AND 4096),
        repository_id UUID,
        observed_remote TEXT CHECK (observed_remote IS NULL OR length(observed_remote) BETWEEN 1 AND 2048),
        status TEXT NOT NULL CHECK (status IN ('available', 'missing', 'unknown')),
        resolution_status TEXT NOT NULL DEFAULT 'unassigned'
          CHECK (resolution_status IN ('resolved', 'ambiguous', 'candidate', 'unassigned')),
        resolution_reviewed_at TIMESTAMPTZ,
        last_observed_at TIMESTAMPTZ NOT NULL,
        UNIQUE (id, space_id),
        UNIQUE (device_id, local_path),
        FOREIGN KEY (project_id, space_id)
          REFERENCES projects (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (repository_id, space_id)
          REFERENCES repositories (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE checkout_resolution_candidates (
        checkout_id UUID NOT NULL,
        space_id UUID NOT NULL,
        repository_id UUID NOT NULL,
        PRIMARY KEY (checkout_id, repository_id),
        FOREIGN KEY (checkout_id, space_id)
          REFERENCES checkouts (id, space_id) ON DELETE CASCADE,
        FOREIGN KEY (repository_id, space_id)
          REFERENCES repositories (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE capture_contexts (
        id UUID PRIMARY KEY,
        device_id UUID NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
        person_id UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        project_id UUID,
        scm_account_id UUID REFERENCES scm_accounts (id) ON DELETE RESTRICT,
        scm_installation_id UUID,
        source TEXT NOT NULL CHECK (source IN ('explicit', 'project-rule', 'personal-fallback', 'unassigned')),
        UNIQUE (id, space_id),
        FOREIGN KEY (project_id, space_id)
          REFERENCES projects (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (scm_installation_id, space_id)
          REFERENCES scm_installations (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE identity_events (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
        subject_type TEXT NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 128),
        subject_id UUID NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE project_source_mappings (
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        project_source_id TEXT NOT NULL CHECK (length(project_source_id) BETWEEN 1 AND 4096),
        project_id UUID NOT NULL,
        checkout_id UUID NOT NULL,
        acknowledged_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (space_id, project_source_id),
        FOREIGN KEY (project_id, space_id)
          REFERENCES projects (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (checkout_id, space_id)
          REFERENCES checkouts (id, space_id) ON DELETE RESTRICT
      );

      CREATE INDEX repository_aliases_repository_idx ON repository_aliases (space_id, repository_id);
      CREATE INDEX projects_repository_idx ON projects (space_id, repository_id);
      CREATE INDEX checkouts_project_idx ON checkouts (space_id, project_id);
      CREATE INDEX capture_contexts_project_idx ON capture_contexts (space_id, project_id);
      CREATE INDEX identity_events_subject_idx ON identity_events (space_id, subject_type, subject_id, recorded_at);

      UPDATE platform_schema_metadata
      SET value = '${PLATFORM_SCHEMA_VERSION}', updated_at = now()
      WHERE key = '${PLATFORM_SCHEMA_METADATA_KEY}';
    `,
  }),
  Object.freeze({
    id: '0003_domain_authorization',
    ordinal: 3,
    up: `
      CREATE TABLE organizations (
        space_id UUID PRIMARY KEY,
        space_kind TEXT NOT NULL DEFAULT 'organization' CHECK (space_kind = 'organization'),
        status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
        created_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (space_id, space_kind)
          REFERENCES spaces (id, kind) ON DELETE RESTRICT
      );

      CREATE TABLE space_memberships (
        space_id UUID NOT NULL REFERENCES organizations (space_id) ON DELETE RESTRICT,
        person_id UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK (role IN ('member', 'admin', 'usage-auditor', 'security-auditor')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (space_id, person_id, role)
      );

      CREATE TABLE teams (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES organizations (space_id) ON DELETE RESTRICT,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (id, space_id)
      );

      CREATE TABLE team_memberships (
        space_id UUID NOT NULL,
        team_id UUID NOT NULL,
        person_id UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (space_id, team_id, person_id),
        FOREIGN KEY (team_id, space_id)
          REFERENCES teams (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE team_nestings (
        space_id UUID NOT NULL,
        parent_team_id UUID NOT NULL,
        child_team_id UUID NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (space_id, parent_team_id, child_team_id),
        CHECK (parent_team_id <> child_team_id),
        FOREIGN KEY (parent_team_id, space_id)
          REFERENCES teams (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (child_team_id, space_id)
          REFERENCES teams (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE project_grants (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL,
        project_id UUID NOT NULL,
        person_id UUID REFERENCES people (id) ON DELETE RESTRICT,
        team_id UUID,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'collaborator', 'maintainer')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        CHECK ((person_id IS NOT NULL)::INTEGER + (team_id IS NOT NULL)::INTEGER = 1),
        FOREIGN KEY (project_id, space_id)
          REFERENCES projects (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (team_id, space_id)
          REFERENCES teams (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE repository_grants (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL,
        repository_id UUID NOT NULL,
        person_id UUID REFERENCES people (id) ON DELETE RESTRICT,
        team_id UUID,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'maintainer')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        CHECK ((person_id IS NOT NULL)::INTEGER + (team_id IS NOT NULL)::INTEGER = 1),
        FOREIGN KEY (repository_id, space_id)
          REFERENCES repositories (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (team_id, space_id)
          REFERENCES teams (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE scm_installation_repository_grants (
        space_id UUID NOT NULL,
        installation_id UUID NOT NULL,
        repository_id UUID NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (space_id, installation_id, repository_id),
        FOREIGN KEY (installation_id, space_id)
          REFERENCES scm_installations (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (repository_id, space_id)
          REFERENCES repositories (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE device_managers (
        space_id UUID NOT NULL,
        device_id UUID NOT NULL,
        person_id UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (space_id, device_id, person_id),
        FOREIGN KEY (device_id, space_id)
          REFERENCES devices (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE session_authorization_scopes (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        project_id UUID,
        owner_person_id UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'purged')),
        UNIQUE (id, space_id),
        FOREIGN KEY (project_id, space_id)
          REFERENCES projects (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE session_metadata_grants (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL,
        session_id UUID NOT NULL,
        person_id UUID REFERENCES people (id) ON DELETE RESTRICT,
        team_id UUID,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'manager')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        CHECK ((person_id IS NOT NULL)::INTEGER + (team_id IS NOT NULL)::INTEGER = 1),
        FOREIGN KEY (session_id, space_id)
          REFERENCES session_authorization_scopes (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (team_id, space_id)
          REFERENCES teams (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE session_content_grants (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL,
        session_id UUID NOT NULL,
        person_id UUID REFERENCES people (id) ON DELETE RESTRICT,
        team_id UUID,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'manager')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        CHECK ((person_id IS NOT NULL)::INTEGER + (team_id IS NOT NULL)::INTEGER = 1),
        FOREIGN KEY (session_id, space_id)
          REFERENCES session_authorization_scopes (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (team_id, space_id)
          REFERENCES teams (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE memory_authorization_scopes (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        project_id UUID,
        owner_person_id UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
        requires_trusted_device BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (id, space_id),
        FOREIGN KEY (project_id, space_id)
          REFERENCES projects (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE memory_content_grants (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL,
        memory_id UUID NOT NULL,
        person_id UUID REFERENCES people (id) ON DELETE RESTRICT,
        team_id UUID,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'proposer', 'manager')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        CHECK ((person_id IS NOT NULL)::INTEGER + (team_id IS NOT NULL)::INTEGER = 1),
        FOREIGN KEY (memory_id, space_id)
          REFERENCES memory_authorization_scopes (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (team_id, space_id)
          REFERENCES teams (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE work_thread_authorization_scopes (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        project_id UUID,
        status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
        UNIQUE (id, space_id),
        FOREIGN KEY (project_id, space_id)
          REFERENCES projects (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE work_thread_grants (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL,
        work_thread_id UUID NOT NULL,
        person_id UUID REFERENCES people (id) ON DELETE RESTRICT,
        team_id UUID,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'contributor', 'manager')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        CHECK ((person_id IS NOT NULL)::INTEGER + (team_id IS NOT NULL)::INTEGER = 1),
        FOREIGN KEY (work_thread_id, space_id)
          REFERENCES work_thread_authorization_scopes (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (team_id, space_id)
          REFERENCES teams (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE work_handoff_authorization_scopes (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        work_thread_id UUID NOT NULL,
        project_id UUID,
        status TEXT NOT NULL CHECK (status IN ('draft', 'accepted', 'expired')),
        UNIQUE (id, space_id),
        FOREIGN KEY (work_thread_id, space_id)
          REFERENCES work_thread_authorization_scopes (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (project_id, space_id)
          REFERENCES projects (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE work_handoff_grants (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL,
        work_handoff_id UUID NOT NULL,
        person_id UUID REFERENCES people (id) ON DELETE RESTRICT,
        team_id UUID,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'contributor', 'manager')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        CHECK ((person_id IS NOT NULL)::INTEGER + (team_id IS NOT NULL)::INTEGER = 1),
        FOREIGN KEY (work_handoff_id, space_id)
          REFERENCES work_handoff_authorization_scopes (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (team_id, space_id)
          REFERENCES teams (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE authorization_audit_events (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        actor_person_id UUID REFERENCES people (id) ON DELETE RESTRICT,
        actor_service_id TEXT,
        action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
        subject_type TEXT NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 64),
        subject_id UUID NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('allowed', 'denied', 'applied', 'rejected')),
        recorded_at TIMESTAMPTZ NOT NULL,
        details JSONB NOT NULL DEFAULT '{}',
        CHECK ((actor_person_id IS NOT NULL)::INTEGER + (actor_service_id IS NOT NULL)::INTEGER = 1)
      );

      CREATE UNIQUE INDEX project_grants_person_unique
        ON project_grants (space_id, project_id, person_id)
        WHERE person_id IS NOT NULL;
      CREATE UNIQUE INDEX project_grants_team_unique
        ON project_grants (space_id, project_id, team_id)
        WHERE team_id IS NOT NULL;
      CREATE UNIQUE INDEX repository_grants_person_unique
        ON repository_grants (space_id, repository_id, person_id)
        WHERE person_id IS NOT NULL;
      CREATE UNIQUE INDEX repository_grants_team_unique
        ON repository_grants (space_id, repository_id, team_id)
        WHERE team_id IS NOT NULL;
      CREATE INDEX space_memberships_person_idx ON space_memberships (person_id, space_id, status, role);
      CREATE INDEX team_memberships_person_idx ON team_memberships (person_id, space_id, status, team_id);
      CREATE INDEX team_nestings_child_idx ON team_nestings (space_id, child_team_id, status, parent_team_id);
      CREATE INDEX project_grants_person_idx ON project_grants (person_id, space_id, status, project_id);
      CREATE INDEX project_grants_team_idx ON project_grants (team_id, space_id, status, project_id);
      CREATE INDEX repository_grants_person_idx ON repository_grants (person_id, space_id, status, repository_id);
      CREATE INDEX repository_grants_team_idx ON repository_grants (team_id, space_id, status, repository_id);
      CREATE INDEX repositories_authorization_space_idx ON repositories (space_id, status, id);
      CREATE INDEX devices_authorization_space_idx ON devices (space_id, status, id);
      CREATE INDEX device_managers_person_idx ON device_managers (person_id, space_id, status, device_id);
      CREATE INDEX session_authorization_scopes_space_idx
        ON session_authorization_scopes (space_id, status, id);
      CREATE INDEX session_metadata_grants_person_idx ON session_metadata_grants (person_id, space_id, status, session_id);
      CREATE INDEX session_metadata_grants_team_idx ON session_metadata_grants (team_id, space_id, status, session_id);
      CREATE INDEX session_content_grants_person_idx ON session_content_grants (person_id, space_id, status, session_id);
      CREATE INDEX session_content_grants_team_idx ON session_content_grants (team_id, space_id, status, session_id);
      CREATE INDEX memory_authorization_scopes_space_idx
        ON memory_authorization_scopes (space_id, status, id);
      CREATE INDEX memory_content_grants_person_idx ON memory_content_grants (person_id, space_id, status, memory_id);
      CREATE INDEX memory_content_grants_team_idx ON memory_content_grants (team_id, space_id, status, memory_id);
      CREATE INDEX work_thread_authorization_scopes_space_idx
        ON work_thread_authorization_scopes (space_id, status, id);
      CREATE INDEX work_thread_grants_person_idx ON work_thread_grants (person_id, space_id, status, work_thread_id);
      CREATE INDEX work_thread_grants_team_idx ON work_thread_grants (team_id, space_id, status, work_thread_id);
      CREATE INDEX work_handoff_authorization_scopes_space_idx
        ON work_handoff_authorization_scopes (space_id, status, id);
      CREATE INDEX work_handoff_grants_person_idx ON work_handoff_grants (person_id, space_id, status, work_handoff_id);
      CREATE INDEX work_handoff_grants_team_idx ON work_handoff_grants (team_id, space_id, status, work_handoff_id);
      CREATE INDEX authorization_audit_subject_idx
        ON authorization_audit_events (space_id, subject_type, subject_id, recorded_at);

      ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
      CREATE POLICY organizations_space_fence ON organizations
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE space_memberships ENABLE ROW LEVEL SECURITY;
      ALTER TABLE space_memberships FORCE ROW LEVEL SECURITY;
      CREATE POLICY space_memberships_space_fence ON space_memberships
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
      ALTER TABLE teams FORCE ROW LEVEL SECURITY;
      CREATE POLICY teams_space_fence ON teams
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE team_memberships ENABLE ROW LEVEL SECURITY;
      ALTER TABLE team_memberships FORCE ROW LEVEL SECURITY;
      CREATE POLICY team_memberships_space_fence ON team_memberships
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE team_nestings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE team_nestings FORCE ROW LEVEL SECURITY;
      CREATE POLICY team_nestings_space_fence ON team_nestings
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE project_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE project_grants FORCE ROW LEVEL SECURITY;
      CREATE POLICY project_grants_space_fence ON project_grants
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE repository_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE repository_grants FORCE ROW LEVEL SECURITY;
      CREATE POLICY repository_grants_space_fence ON repository_grants
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE scm_installation_repository_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE scm_installation_repository_grants FORCE ROW LEVEL SECURITY;
      CREATE POLICY scm_installation_repository_grants_space_fence ON scm_installation_repository_grants
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE device_managers ENABLE ROW LEVEL SECURITY;
      ALTER TABLE device_managers FORCE ROW LEVEL SECURITY;
      CREATE POLICY device_managers_space_fence ON device_managers
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE session_authorization_scopes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE session_authorization_scopes FORCE ROW LEVEL SECURITY;
      CREATE POLICY session_authorization_scopes_space_fence ON session_authorization_scopes
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE session_metadata_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE session_metadata_grants FORCE ROW LEVEL SECURITY;
      CREATE POLICY session_metadata_grants_space_fence ON session_metadata_grants
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE session_content_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE session_content_grants FORCE ROW LEVEL SECURITY;
      CREATE POLICY session_content_grants_space_fence ON session_content_grants
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE memory_authorization_scopes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_authorization_scopes FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_authorization_scopes_space_fence ON memory_authorization_scopes
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE memory_content_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_content_grants FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_content_grants_space_fence ON memory_content_grants
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE work_thread_authorization_scopes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE work_thread_authorization_scopes FORCE ROW LEVEL SECURITY;
      CREATE POLICY work_thread_authorization_scopes_space_fence ON work_thread_authorization_scopes
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE work_thread_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE work_thread_grants FORCE ROW LEVEL SECURITY;
      CREATE POLICY work_thread_grants_space_fence ON work_thread_grants
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE work_handoff_authorization_scopes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE work_handoff_authorization_scopes FORCE ROW LEVEL SECURITY;
      CREATE POLICY work_handoff_authorization_scopes_space_fence ON work_handoff_authorization_scopes
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE work_handoff_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE work_handoff_grants FORCE ROW LEVEL SECURITY;
      CREATE POLICY work_handoff_grants_space_fence ON work_handoff_grants
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE authorization_audit_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE authorization_audit_events FORCE ROW LEVEL SECURITY;
      CREATE POLICY authorization_audit_events_space_fence ON authorization_audit_events
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      UPDATE platform_schema_metadata
      SET value = '${PLATFORM_SCHEMA_VERSION}', updated_at = now()
      WHERE key = '${PLATFORM_SCHEMA_METADATA_KEY}';
    `,
  }),
  Object.freeze({
    id: '0004_shared_authentication_and_device_enrollment',
    ordinal: 4,
    up: `
      CREATE TABLE authentication_principals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
        email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 320),
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        image TEXT CHECK (image IS NULL OR length(image) BETWEEN 1 AND 2048),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE authentication_provider_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        issuer TEXT NOT NULL CHECK (issuer = 'local:oauth:github'),
        account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 256),
        provider_id TEXT NOT NULL CHECK (provider_id = 'github'),
        user_id UUID NOT NULL REFERENCES authentication_principals (id) ON DELETE CASCADE,
        access_token TEXT,
        refresh_token TEXT,
        id_token TEXT,
        access_token_expires_at TIMESTAMPTZ,
        refresh_token_expires_at TIMESTAMPTZ,
        scope TEXT CHECK (scope IS NULL OR length(scope) <= 2048),
        password TEXT CHECK (password IS NULL),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (issuer, account_id)
      );

      CREATE TABLE authentication_verifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        identifier TEXT NOT NULL CHECK (length(identifier) BETWEEN 1 AND 1024),
        value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 8192),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE authentication_identities (
        id UUID PRIMARY KEY,
        person_id UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
        authentication_principal_id UUID NOT NULL
          REFERENCES authentication_principals (id) ON DELETE CASCADE,
        authentication_provider_account_id UUID UNIQUE
          REFERENCES authentication_provider_accounts (id) ON DELETE SET NULL,
        provider TEXT NOT NULL CHECK (provider = 'github'),
        provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 256),
        linked_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        UNIQUE (provider, provider_subject)
      );

      CREATE TABLE web_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        expires_at TIMESTAMPTZ NOT NULL,
        token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 43),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        user_id UUID NOT NULL REFERENCES authentication_principals (id) ON DELETE CASCADE,
        authentication_identity_id UUID NOT NULL
          REFERENCES authentication_identities (id) ON DELETE CASCADE,
        absolute_expires_at TIMESTAMPTZ NOT NULL,
        fresh_until TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        CHECK (ip_address IS NULL OR ip_address = ''),
        CHECK (user_agent IS NULL OR user_agent = ''),
        CHECK (fresh_until <= absolute_expires_at),
        CHECK (expires_at <= absolute_expires_at)
      );

      CREATE TABLE platform_bootstrap_state (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        authentication_identity_id UUID NOT NULL UNIQUE
          REFERENCES authentication_identities (id) ON DELETE RESTRICT,
        completed_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE device_enrollment_grants (
        id UUID PRIMARY KEY,
        person_id UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 256),
        public_token_id TEXT NOT NULL UNIQUE CHECK (length(public_token_id) = 22),
        keyed_digest TEXT NOT NULL CHECK (length(keyed_digest) = 43),
        key_version INTEGER NOT NULL CHECK (key_version > 0),
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        consumed_device_id UUID,
        UNIQUE (id, space_id),
        CHECK (expires_at > created_at),
        CHECK ((consumed_at IS NULL) = (consumed_device_id IS NULL)),
        FOREIGN KEY (consumed_device_id, space_id)
          REFERENCES devices (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE device_credentials (
        id UUID PRIMARY KEY,
        device_id UUID NOT NULL,
        space_id UUID NOT NULL,
        public_token_id TEXT NOT NULL UNIQUE CHECK (length(public_token_id) = 22),
        keyed_digest TEXT NOT NULL CHECK (length(keyed_digest) = 43),
        key_version INTEGER NOT NULL CHECK (key_version > 0),
        created_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ,
        rotated_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        UNIQUE (id, space_id),
        CHECK (rotated_at IS NULL OR revoked_at IS NOT NULL),
        FOREIGN KEY (device_id, space_id)
          REFERENCES devices (id, space_id) ON DELETE RESTRICT
      );

      CREATE INDEX authentication_provider_accounts_user_idx
        ON authentication_provider_accounts (user_id, provider_id);
      CREATE INDEX authentication_verifications_identifier_idx
        ON authentication_verifications (identifier, expires_at);
      CREATE INDEX authentication_identities_person_idx
        ON authentication_identities (person_id, revoked_at, provider);
      CREATE INDEX authentication_identities_principal_idx
        ON authentication_identities (authentication_principal_id, revoked_at);
      CREATE INDEX web_sessions_user_idx ON web_sessions (user_id, expires_at);
      CREATE INDEX web_sessions_identity_idx
        ON web_sessions (authentication_identity_id, expires_at, revoked_at);
      CREATE INDEX device_enrollment_grants_scope_idx
        ON device_enrollment_grants (space_id, person_id, expires_at, consumed_at);
      CREATE INDEX device_credentials_device_idx
        ON device_credentials (space_id, device_id, revoked_at, created_at);
      CREATE UNIQUE INDEX device_credentials_one_active_per_device
        ON device_credentials (space_id, device_id)
        WHERE revoked_at IS NULL;

      UPDATE platform_schema_metadata
      SET value = '${PLATFORM_SCHEMA_VERSION}', updated_at = now()
      WHERE key = '${PLATFORM_SCHEMA_METADATA_KEY}';
    `,
  }),
  Object.freeze({
    id: '0005_db_native_agent_memory',
    ordinal: 5,
    up: `
      CREATE TABLE memory_observations (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        project_id UUID,
        capture_context_id UUID,
        source_kind TEXT NOT NULL
          CHECK (source_kind IN ('user', 'agent', 'session', 'file', 'commit', 'pull-request', 'import')),
        source_locator TEXT CHECK (source_locator IS NULL OR length(source_locator) BETWEEN 1 AND 4096),
        fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        observed_at TIMESTAMPTZ NOT NULL,
        content JSONB NOT NULL,
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
        redaction_rule_set_version TEXT NOT NULL CHECK (redaction_rule_set_version = 'memory-redaction-v1'),
        created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('person', 'service')),
        created_by_id TEXT NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 256),
        UNIQUE (id, space_id),
        UNIQUE (space_id, fingerprint),
        FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (capture_context_id, space_id) REFERENCES capture_contexts (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE memory_proposals (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        project_id UUID,
        proposed_kind TEXT NOT NULL
          CHECK (proposed_kind IN ('decision', 'pattern', 'pitfall', 'command', 'constraint', 'handoff', 'lesson', 'preference')),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
        summary TEXT NOT NULL CHECK (length(summary) <= 16384),
        guidance JSONB NOT NULL CHECK (jsonb_typeof(guidance) = 'array'),
        structured_content JSONB NOT NULL,
        trust_candidate TEXT NOT NULL CHECK (trust_candidate IN ('explicit', 'harvest-accepted')),
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
        proposed_by_kind TEXT NOT NULL CHECK (proposed_by_kind IN ('person', 'service')),
        proposed_by_id TEXT NOT NULL CHECK (length(proposed_by_id) BETWEEN 1 AND 256),
        reviewed_by_person_id UUID REFERENCES people (id) ON DELETE RESTRICT,
        reviewed_at TIMESTAMPTZ,
        review_reason TEXT CHECK (review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 4096),
        accepted_memory_item_id UUID,
        UNIQUE (id, space_id),
        FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT,
        CONSTRAINT memory_proposals_review_state_check CHECK (
          (status = 'pending' AND reviewed_by_person_id IS NULL AND reviewed_at IS NULL
            AND review_reason IS NULL AND accepted_memory_item_id IS NULL)
          OR (status = 'accepted' AND reviewed_by_person_id IS NOT NULL AND reviewed_at IS NOT NULL
            AND accepted_memory_item_id IS NOT NULL)
          OR (status IN ('rejected', 'superseded') AND reviewed_by_person_id IS NOT NULL
            AND reviewed_at IS NOT NULL AND accepted_memory_item_id IS NULL)
        )
      );

      CREATE TABLE memory_proposal_observations (
        space_id UUID NOT NULL,
        proposal_id UUID NOT NULL,
        observation_id UUID NOT NULL,
        PRIMARY KEY (proposal_id, observation_id),
        FOREIGN KEY (proposal_id, space_id) REFERENCES memory_proposals (id, space_id) ON DELETE CASCADE,
        FOREIGN KEY (observation_id, space_id) REFERENCES memory_observations (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE memory_items (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        project_id UUID,
        scope TEXT NOT NULL CHECK (scope IN ('project', 'space', 'person')),
        kind TEXT NOT NULL
          CHECK (kind IN ('decision', 'pattern', 'pitfall', 'command', 'constraint', 'handoff', 'lesson', 'preference')),
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rejected', 'archived')),
        trust TEXT NOT NULL CHECK (trust IN ('explicit', 'harvest-accepted')),
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
        current_revision_id UUID NOT NULL,
        UNIQUE (id, space_id),
        FOREIGN KEY (id, space_id) REFERENCES memory_authorization_scopes (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT,
        CHECK (scope <> 'project' OR project_id IS NOT NULL)
      );

      CREATE TABLE memory_revisions (
        id UUID PRIMARY KEY,
        memory_item_id UUID NOT NULL,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
        summary TEXT NOT NULL CHECK (length(summary) <= 16384),
        guidance JSONB NOT NULL CHECK (jsonb_typeof(guidance) = 'array'),
        structured_content JSONB NOT NULL,
        created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('person', 'service')),
        created_by_id TEXT NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 256),
        created_at TIMESTAMPTZ NOT NULL,
        reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 4096),
        UNIQUE (id, memory_item_id, space_id),
        UNIQUE (memory_item_id, revision_number),
        CONSTRAINT memory_revisions_item_fk FOREIGN KEY (memory_item_id, space_id)
          REFERENCES memory_items (id, space_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
      );

      ALTER TABLE memory_items
        ADD CONSTRAINT memory_items_current_revision_fk
        FOREIGN KEY (current_revision_id, id, space_id)
        REFERENCES memory_revisions (id, memory_item_id, space_id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

      ALTER TABLE memory_proposals
        ADD CONSTRAINT memory_proposals_accepted_item_fk
        FOREIGN KEY (accepted_memory_item_id, space_id)
        REFERENCES memory_items (id, space_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

      CREATE TABLE memory_relations (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        from_memory_item_id UUID NOT NULL,
        to_memory_item_id UUID NOT NULL,
        relation_kind TEXT NOT NULL
          CHECK (relation_kind IN ('supports', 'supersedes', 'contradicts', 'derived-from', 'related-to', 'applies-to')),
        created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('person', 'service')),
        created_by_id TEXT NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 256),
        created_at TIMESTAMPTZ NOT NULL,
        reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 4096),
        UNIQUE (space_id, from_memory_item_id, to_memory_item_id, relation_kind),
        CHECK (from_memory_item_id <> to_memory_item_id),
        FOREIGN KEY (from_memory_item_id, space_id) REFERENCES memory_items (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (to_memory_item_id, space_id) REFERENCES memory_items (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE memory_imports (
        id UUID PRIMARY KEY,
        space_id UUID NOT NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        project_id UUID,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('legacy-markdown', 'legacy-jsonl')),
        source_locator TEXT NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 4096),
        fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        preview_proof TEXT NOT NULL CHECK (preview_proof ~ '^[0-9a-f]{64}$'),
        status TEXT NOT NULL CHECK (status IN ('previewed', 'confirmed', 'quarantined', 'stale')),
        created_at TIMESTAMPTZ NOT NULL,
        confirmed_by_person_id UUID REFERENCES people (id) ON DELETE RESTRICT,
        confirmed_at TIMESTAMPTZ,
        UNIQUE (space_id, fingerprint),
        FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT
      );

      CREATE FUNCTION reject_memory_immutable_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('ai_usage.allow_memory_privacy_purge', TRUE) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'immutable Memory evidence cannot be changed';
      END;
      $$;
      CREATE TRIGGER memory_observations_immutable
        BEFORE UPDATE OR DELETE ON memory_observations
        FOR EACH ROW EXECUTE FUNCTION reject_memory_immutable_mutation();
      CREATE TRIGGER memory_revisions_immutable
        BEFORE UPDATE OR DELETE ON memory_revisions
        FOR EACH ROW EXECUTE FUNCTION reject_memory_immutable_mutation();

      CREATE INDEX memory_observations_space_project_idx
        ON memory_observations (space_id, project_id, observed_at);
      CREATE INDEX memory_proposals_space_status_idx ON memory_proposals (space_id, status, id);
      CREATE INDEX memory_items_space_status_idx ON memory_items (space_id, status, id);
      CREATE INDEX memory_revisions_item_idx ON memory_revisions (space_id, memory_item_id, revision_number);
      CREATE INDEX memory_relations_from_idx ON memory_relations (space_id, from_memory_item_id, relation_kind);
      CREATE INDEX memory_imports_space_status_idx ON memory_imports (space_id, status, id);

      ALTER TABLE memory_observations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_observations FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_observations_space_fence ON memory_observations
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);
      ALTER TABLE memory_proposals ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_proposals FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_proposals_space_fence ON memory_proposals
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);
      ALTER TABLE memory_proposal_observations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_proposal_observations FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_proposal_observations_space_fence ON memory_proposal_observations
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);
      ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_items FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_items_space_fence ON memory_items
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);
      ALTER TABLE memory_revisions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_revisions FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_revisions_space_fence ON memory_revisions
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);
      ALTER TABLE memory_relations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_relations FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_relations_space_fence ON memory_relations
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);
      ALTER TABLE memory_imports ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_imports FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_imports_space_fence ON memory_imports
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      UPDATE platform_schema_metadata
      SET value = '${PLATFORM_SCHEMA_VERSION}', updated_at = now()
      WHERE key = '${PLATFORM_SCHEMA_METADATA_KEY}';
    `,
  }),
  Object.freeze({
    id: '0006_memory_import_state_binding',
    ordinal: 6,
    up: `
      CREATE OR REPLACE FUNCTION reject_memory_immutable_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('ai_usage.allow_memory_privacy_purge', TRUE) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'immutable Memory evidence cannot be changed';
      END;
      $$;

      ALTER TABLE memory_revisions
        DROP CONSTRAINT IF EXISTS memory_revisions_memory_item_id_space_id_fkey;
      ALTER TABLE memory_revisions
        DROP CONSTRAINT IF EXISTS memory_revisions_item_fk;
      ALTER TABLE memory_revisions
        ADD CONSTRAINT memory_revisions_item_fk
        FOREIGN KEY (memory_item_id, space_id)
        REFERENCES memory_items (id, space_id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

      ALTER TABLE memory_items
        DROP CONSTRAINT IF EXISTS memory_items_current_revision_fk;
      ALTER TABLE memory_items
        ADD CONSTRAINT memory_items_current_revision_fk
        FOREIGN KEY (current_revision_id, id, space_id)
        REFERENCES memory_revisions (id, memory_item_id, space_id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

      ALTER TABLE memory_proposals
        ADD COLUMN IF NOT EXISTS accepted_memory_item_id UUID;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'memory_proposals'::regclass
            AND conname = 'memory_proposals_accepted_item_fk'
        ) THEN
          ALTER TABLE memory_proposals
            ADD CONSTRAINT memory_proposals_accepted_item_fk
            FOREIGN KEY (accepted_memory_item_id, space_id)
            REFERENCES memory_items (id, space_id)
            ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
        END IF;
      END
      $$;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'memory_proposals'::regclass
            AND conname = 'memory_proposals_review_state_check'
        ) THEN
          ALTER TABLE memory_proposals
            ADD CONSTRAINT memory_proposals_review_state_check CHECK (
              (status = 'pending' AND reviewed_by_person_id IS NULL AND reviewed_at IS NULL
                AND review_reason IS NULL AND accepted_memory_item_id IS NULL)
              OR (status = 'accepted' AND reviewed_by_person_id IS NOT NULL AND reviewed_at IS NOT NULL
                AND accepted_memory_item_id IS NOT NULL)
              OR (status IN ('rejected', 'superseded') AND reviewed_by_person_id IS NOT NULL
                AND reviewed_at IS NOT NULL AND accepted_memory_item_id IS NULL)
            ) NOT VALID;
        END IF;
      END
      $$;

      CREATE TABLE memory_space_state (
        space_id UUID PRIMARY KEY REFERENCES spaces (id) ON DELETE RESTRICT,
        version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0)
      );

      INSERT INTO memory_space_state (space_id, version)
      SELECT id, 0 FROM spaces;

      ALTER TABLE memory_space_state ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_space_state FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_space_state_space_fence ON memory_space_state
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      UPDATE platform_schema_metadata
      SET value = '${PLATFORM_SCHEMA_VERSION}', updated_at = now()
      WHERE key = '${PLATFORM_SCHEMA_METADATA_KEY}';
    `,
  }),
  Object.freeze({
    id: '0007_authorized_memory_search',
    ordinal: 7,
    up: `
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      CREATE TABLE memory_search_chunks (
        chunk_id TEXT PRIMARY KEY CHECK (chunk_id ~ '^[0-9a-f]{64}$'),
        chunk_ordinal INTEGER NOT NULL CHECK (chunk_ordinal >= 0),
        chunker_version TEXT NOT NULL CHECK (chunker_version = 'memory-search-chunker-v1'),
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        space_id UUID NOT NULL,
        project_id UUID,
        memory_item_id UUID NOT NULL,
        revision_id UUID NOT NULL,
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
        search_vector TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', title), 'A') ||
          CASE WHEN kind = 'command' THEN
            setweight(to_tsvector('simple', guidance || ' ' || structured_terms), 'A')
          ELSE
            setweight(to_tsvector('simple', summary), 'B') ||
            setweight(to_tsvector('simple', guidance || ' ' || structured_terms), 'C')
          END ||
          setweight(to_tsvector('simple', supporting_text), 'D')
        ) STORED,
        normalized_document TEXT GENERATED ALWAYS AS (
          lower(title || ' ' || summary || ' ' || guidance || ' ' || structured_terms || ' ' || supporting_text)
        ) STORED,
        UNIQUE (memory_item_id, revision_id, chunk_ordinal),
        FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (memory_item_id, space_id) REFERENCES memory_items (id, space_id) ON DELETE CASCADE,
        FOREIGN KEY (revision_id, memory_item_id, space_id)
          REFERENCES memory_revisions (id, memory_item_id, space_id) ON DELETE CASCADE
      );

      CREATE INDEX memory_search_chunks_scope_idx
        ON memory_search_chunks (space_id, project_id, status, trust, kind, memory_item_id);
      CREATE INDEX memory_search_chunks_fts_idx ON memory_search_chunks USING GIN (search_vector);
      CREATE INDEX memory_search_chunks_trigram_idx
        ON memory_search_chunks USING GIN (normalized_document gin_trgm_ops);
      CREATE INDEX memory_search_chunks_title_trigram_idx
        ON memory_search_chunks USING GIN (lower(title) gin_trgm_ops);
      CREATE INDEX memory_search_chunks_summary_trigram_idx
        ON memory_search_chunks USING GIN (lower(summary) gin_trgm_ops);
      CREATE INDEX memory_search_chunks_guidance_trigram_idx
        ON memory_search_chunks USING GIN (lower(guidance) gin_trgm_ops);
      CREATE INDEX memory_search_chunks_structured_trigram_idx
        ON memory_search_chunks USING GIN (lower(structured_terms) gin_trgm_ops);

      CREATE TABLE memory_search_projection_state (
        space_id UUID PRIMARY KEY REFERENCES spaces (id) ON DELETE CASCADE,
        source_state_version BIGINT NOT NULL DEFAULT -1 CHECK (source_state_version >= -1),
        chunker_version TEXT NOT NULL CHECK (chunker_version = 'memory-search-chunker-v1')
      );

      INSERT INTO memory_search_projection_state (space_id, source_state_version, chunker_version)
      SELECT id, -1, 'memory-search-chunker-v1' FROM spaces;

      ALTER TABLE memory_search_chunks ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_search_chunks FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_search_chunks_space_fence ON memory_search_chunks
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE memory_search_projection_state ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_search_projection_state FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_search_projection_state_space_fence ON memory_search_projection_state
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      UPDATE platform_schema_metadata
      SET value = '${PLATFORM_SCHEMA_VERSION}', updated_at = now()
      WHERE key = '${PLATFORM_SCHEMA_METADATA_KEY}';
    `,
  }),
  Object.freeze({
    id: '0008_device_outbox_replication',
    ordinal: 8,
    up: `
      CREATE TABLE replication_stream_states (
        device_id UUID NOT NULL,
        space_id UUID NOT NULL,
        stream_id TEXT NOT NULL CHECK (stream_id IN ('usage-v1', 'memory-v1')),
        accepted_through_generation BIGINT NOT NULL DEFAULT 0 CHECK (accepted_through_generation >= 0),
        last_ack_proof TEXT CHECK (last_ack_proof IS NULL OR last_ack_proof ~ '^[0-9a-f]{64}$'),
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (device_id, stream_id),
        FOREIGN KEY (device_id, space_id) REFERENCES devices (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE replication_event_identities (
        device_id UUID NOT NULL,
        space_id UUID NOT NULL,
        stream_id TEXT NOT NULL CHECK (stream_id IN ('usage-v1', 'memory-v1')),
        event_id UUID NOT NULL,
        event_hash TEXT NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
        PRIMARY KEY (device_id, stream_id, event_id),
        FOREIGN KEY (device_id, space_id) REFERENCES devices (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE replication_event_receipts (
        device_id UUID NOT NULL,
        space_id UUID NOT NULL,
        stream_id TEXT NOT NULL CHECK (stream_id IN ('usage-v1', 'memory-v1')),
        event_id UUID NOT NULL,
        generation BIGINT NOT NULL CHECK (generation > 0),
        fact_key TEXT NOT NULL CHECK (length(fact_key) BETWEEN 1 AND 512),
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        change_kind TEXT NOT NULL CHECK (change_kind IN (
          'usage-session-upsert',
          'usage-session-tombstone',
          'device-fact-upsert',
          'checkout-fact-upsert',
          'checkout-fact-tombstone',
          'memory-observation-upsert',
          'memory-proposal-upsert',
          'memory-item-revision-upsert',
          'memory-relation-upsert',
          'memory-fact-tombstone'
        )),
        capture_context_id UUID NOT NULL,
        project_id UUID,
        payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        received_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (device_id, stream_id, event_id),
        UNIQUE (device_id, stream_id, generation),
        FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE RESTRICT,
        FOREIGN KEY (device_id, stream_id, event_id)
          REFERENCES replication_event_identities (device_id, stream_id, event_id) ON DELETE RESTRICT,
        FOREIGN KEY (capture_context_id, space_id)
          REFERENCES capture_contexts (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE replication_batch_receipts (
        device_id UUID NOT NULL,
        space_id UUID NOT NULL,
        stream_id TEXT NOT NULL CHECK (stream_id IN ('usage-v1', 'memory-v1')),
        batch_id UUID NOT NULL,
        idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
        request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
        from_generation_exclusive BIGINT NOT NULL CHECK (from_generation_exclusive >= 0),
        to_generation_inclusive BIGINT NOT NULL CHECK (to_generation_inclusive > from_generation_exclusive),
        stored_ack JSONB NOT NULL CHECK (jsonb_typeof(stored_ack) = 'object'),
        applied_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (device_id, stream_id, batch_id),
        FOREIGN KEY (device_id, space_id) REFERENCES devices (id, space_id) ON DELETE RESTRICT
      );

      CREATE TABLE replicated_fact_projections (
        space_id UUID NOT NULL,
        fact_key TEXT NOT NULL CHECK (length(fact_key) BETWEEN 1 AND 512),
        device_id UUID NOT NULL,
        stream_id TEXT NOT NULL CHECK (stream_id IN ('usage-v1', 'memory-v1')),
        current_event_id UUID NOT NULL,
        current_generation BIGINT NOT NULL CHECK (current_generation > 0),
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        change_kind TEXT NOT NULL,
        capture_context_id UUID NOT NULL,
        project_id UUID,
        status TEXT NOT NULL CHECK (status IN ('active', 'tombstone')),
        payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (space_id, fact_key),
        FOREIGN KEY (device_id, stream_id, current_event_id)
          REFERENCES replication_event_receipts (device_id, stream_id, event_id) ON DELETE RESTRICT,
        FOREIGN KEY (capture_context_id, space_id)
          REFERENCES capture_contexts (id, space_id) ON DELETE RESTRICT,
        FOREIGN KEY (project_id, space_id) REFERENCES projects (id, space_id) ON DELETE RESTRICT
      );

      CREATE INDEX replication_event_receipts_fact_history_idx
        ON replication_event_receipts (space_id, fact_key, generation);
      CREATE INDEX replication_event_receipts_project_idx
        ON replication_event_receipts (space_id, project_id, received_at);
      CREATE INDEX replication_batch_receipts_generation_idx
        ON replication_batch_receipts (device_id, stream_id, to_generation_inclusive);
      CREATE INDEX replicated_fact_projections_device_idx
        ON replicated_fact_projections (space_id, device_id, stream_id, updated_at);
      CREATE INDEX replicated_fact_projections_project_idx
        ON replicated_fact_projections (space_id, project_id, updated_at);

      CREATE FUNCTION reject_replication_receipt_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'immutable replication receipt cannot be changed';
      END;
      $$;
      CREATE TRIGGER replication_event_receipts_immutable
        BEFORE UPDATE OR DELETE ON replication_event_receipts
        FOR EACH ROW EXECUTE FUNCTION reject_replication_receipt_mutation();
      CREATE TRIGGER replication_batch_receipts_immutable
        BEFORE UPDATE OR DELETE ON replication_batch_receipts
        FOR EACH ROW EXECUTE FUNCTION reject_replication_receipt_mutation();

      ALTER TABLE replication_stream_states ENABLE ROW LEVEL SECURITY;
      ALTER TABLE replication_stream_states FORCE ROW LEVEL SECURITY;
      CREATE POLICY replication_stream_states_space_fence ON replication_stream_states
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE replication_event_receipts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE replication_event_receipts FORCE ROW LEVEL SECURITY;
      CREATE POLICY replication_event_receipts_space_fence ON replication_event_receipts
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE replication_event_identities ENABLE ROW LEVEL SECURITY;
      ALTER TABLE replication_event_identities FORCE ROW LEVEL SECURITY;
      CREATE POLICY replication_event_identities_space_fence ON replication_event_identities
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE replication_batch_receipts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE replication_batch_receipts FORCE ROW LEVEL SECURITY;
      CREATE POLICY replication_batch_receipts_space_fence ON replication_batch_receipts
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      ALTER TABLE replicated_fact_projections ENABLE ROW LEVEL SECURITY;
      ALTER TABLE replicated_fact_projections FORCE ROW LEVEL SECURITY;
      CREATE POLICY replicated_fact_projections_space_fence ON replicated_fact_projections
        USING (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID)
        WITH CHECK (space_id = NULLIF(current_setting('ai_usage.active_space_id', TRUE), '')::UUID);

      UPDATE platform_schema_metadata
      SET value = '${PLATFORM_SCHEMA_VERSION}', updated_at = now()
      WHERE key = '${PLATFORM_SCHEMA_METADATA_KEY}';
    `,
  }),
]);

const migrationIdPattern = /^[a-z0-9][a-z0-9_]{2,127}$/u;

export const validatePlatformMigrations = (migrations: readonly PlatformMigration[]): readonly PlatformMigration[] => {
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  let previousOrdinal = 0;

  for (const migration of migrations) {
    if (!migrationIdPattern.test(migration.id) || migration.up.trim().length === 0) {
      throw new PlatformStoreError('migration-registry-invalid', 'validate-migration-registry');
    }
    if (
      !Number.isSafeInteger(migration.ordinal) ||
      migration.ordinal <= previousOrdinal ||
      ids.has(migration.id) ||
      ordinals.has(migration.ordinal)
    ) {
      throw new PlatformStoreError('migration-registry-invalid', 'validate-migration-registry');
    }
    ids.add(migration.id);
    ordinals.add(migration.ordinal);
    previousOrdinal = migration.ordinal;
  }

  return migrations;
};

validatePlatformMigrations(PLATFORM_MIGRATIONS);
