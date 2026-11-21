import { isSerializedMergeRow, migrateLegacySerializedMergeRow } from '@ai-usage/report-core/merge-bundle';
import { CLAUDE_DESKTOP_SESSION_TABLES, claudeDesktopSessionSchemaSql } from './claude-desktop-session-schema';
import { CODEX_WORK_TABLES, codexWorkSchemaSql } from './codex-work-schema';
import { DELEGATION_TABLES, migrateDelegationSchema } from './delegation-schema';
import { migrateExecutorAccountChangeSchema } from './executor-observation-schema';
import {
  fleetMetadataForStoredRow,
  rebuildUsageMachineFleetOrder,
  type StoredMachineFleetRow,
} from './machine-fleet-order';
import { MAX_PROVIDER_QUOTA_STREAMS } from './provider-quota-schema';
import { migrateReviewAttemptSchema, REVIEW_ATTEMPT_TABLES } from './review-attempt-schema';
import {
  enrichmentContentHash,
  RTK_SAVINGS_SCHEMA_VERSION,
  RTK_SAVINGS_SOURCE_ID,
  rtkSavingsFromRow,
} from './rtk-savings';
import { servedReportSchemaSql } from './served-revision';
import type { SqliteDatabase } from './sqlite-database';
import type { StoredUsageRowStatus } from './stored-usage-row';
import { migrateWorkFactSchema, WORK_FACT_TABLES, workFactSchemaSql } from './work-fact-schema';
import { WORK_THREAD_TABLES, workThreadSchemaSql } from './work-thread-schema';

export const USAGE_STORE_SCHEMA_VERSION = 5;

/**
 * Raised by `migrate()` when the store was written by a newer schema. The writer open maps it to the
 * `schema-too-new` reason; every other failure raised inside `migrate()` is a `migration-failure`.
 */
export class UsageStoreSchemaTooNewError extends Error {
  override readonly name = 'UsageStoreSchemaTooNewError';
}

export interface UsageStoreGenerationRecord {
  value: number;
}

const usageLocalMachineSchemaSql = `
  CREATE TABLE usage_local_machine (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    machine_id TEXT NOT NULL CHECK (length(machine_id) > 0),
    machine_label TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const normalizedSchemaSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();

export const hasExactUsageLocalMachineSchema = (db: SqliteDatabase): boolean => {
  const record = db
    .query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'usage_local_machine'")
    .get() as { sql: string | null } | null;
  return (
    typeof record?.sql === 'string' &&
    normalizedSchemaSql(record.sql) === normalizedSchemaSql(usageLocalMachineSchemaSql)
  );
};

// ---------------------------------------------------------------------------------------------------------
// Probe: what the store lacks, read before the migration transaction opens.

interface MigrationProbe {
  readonly quotaReadProjectionMissing: boolean;
  readonly schemaChanged: boolean;
  readonly skillObservationCollectionStateMissing: boolean;
  readonly userVersion: number;
}

const readSchemaVersion = (db: SqliteDatabase): number => {
  const schemaVersion = db.query('PRAGMA user_version').get() as { user_version: number };
  if (schemaVersion.user_version > USAGE_STORE_SCHEMA_VERSION) {
    throw new UsageStoreSchemaTooNewError(
      `Usage store schema ${schemaVersion.user_version} is newer than supported schema ${USAGE_STORE_SCHEMA_VERSION}`,
    );
  }
  return schemaVersion.user_version;
};

const familyTablesMissing = (db: SqliteDatabase, tables: readonly string[]): boolean =>
  tables.some((table) => db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) === null);

// Every additive family is probed, in this order, each stopping at its first missing table; the result is
// whether any family lacks a table.
const additiveFamiliesMissing = (db: SqliteDatabase): boolean =>
  [
    // The external and local fact family (ADR 0051) is additive under the same user_version; the
    // tables' absence is again the only signal.
    WORK_FACT_TABLES,
    // Same precedent for the Claude Desktop session family (ADR 0050): additive tables under the
    // current user_version, so presence is the only signal.
    CLAUDE_DESKTOP_SESSION_TABLES,
    CODEX_WORK_TABLES,
    // Review attempts (ADR 0053) follow the same additive rule: presence of the table is the signal.
    REVIEW_ATTEMPT_TABLES,
    // Delegation jobs, evaluations and qualifications (design 2026-10-25) follow the same additive
    // rule under user_version 4: presence of the three tables is the signal.
    DELEGATION_TABLES,
    WORK_THREAD_TABLES,
  ]
    .map((tables) => familyTablesMissing(db, tables))
    .includes(true);

const probeStore = (db: SqliteDatabase): MigrationProbe => {
  const userVersion = readSchemaVersion(db);
  const versionOrMetadataChanged =
    userVersion < USAGE_STORE_SCHEMA_VERSION ||
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'usage_store_metadata'").get() === null;
  const quotaReadProjectionMissing =
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'provider_quota_streams'").get() === null ||
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'provider_quota_latest_heads'").get() ===
      null;
  // A store written before the skill-observation family existed carries the
  // current user_version, so absence of the table is the only signal that this
  // migration has work to do.
  const skillObservationsMissing =
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'skill_observations'").get() === null;
  const skillObservationCollectionStateMissing =
    db
      .query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'skill_observation_collection_state'")
      .get() === null;
  // Executor observations (review routing) are additive under the same user_version; presence is
  // again the only signal.
  const executorObservationsMissing =
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'executor_observations'").get() === null;
  const additiveFamilyMissing = additiveFamiliesMissing(db);
  return {
    quotaReadProjectionMissing,
    schemaChanged:
      versionOrMetadataChanged ||
      quotaReadProjectionMissing ||
      skillObservationsMissing ||
      skillObservationCollectionStateMissing ||
      executorObservationsMissing ||
      additiveFamilyMissing,
    skillObservationCollectionStateMissing,
    userVersion,
  };
};

// ---------------------------------------------------------------------------------------------------------
// Steps: one per table family, run in order inside the migration transaction. Each reports whether it
// changed the schema or data beyond what the probe already detected. The SQL templates keep the text, and
// so the indentation, they had in the single `migrate()` body: a migration's statements must not change.

type MigrationStep = (db: SqliteDatabase, probe: MigrationProbe) => boolean;

// Core rows and metadata, machine fleet order, local machine projection, row enrichments, retired dataset
// items, provider quota, skill observations and executor observations: one schema statement.
const createBaseSchema: MigrationStep = (db) => {
  // Skill tier and observable-producer literals in this schema-v3 migration are historical
  // snapshots. Changing them requires a new schema migration; do not derive them from runtime
  // capability constants.
  db.exec(`
      CREATE TABLE IF NOT EXISTS usage_rows (
      origin_machine_id TEXT NOT NULL,
      harness_key TEXT NOT NULL,
      source_session_id TEXT,
      source_fingerprint TEXT NOT NULL,
      source_authority TEXT NOT NULL DEFAULT 'portable-opaque' CHECK (source_authority IN ('local-observed', 'portable-opaque')),
      row_key TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      row_json TEXT NOT NULL,
      machine_label TEXT NOT NULL DEFAULT '',
      fleet_metadata_valid INTEGER NOT NULL DEFAULT 0 CHECK (fleet_metadata_valid IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted')),
      active_date TEXT,
      project TEXT NOT NULL,
      model TEXT NOT NULL,
      token_total INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- Reserved for future explicit supersession tracking; supersession is currently
      -- carried by the status column (active | superseded | deleted).
      superseded_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_usage_rows_origin_status ON usage_rows(origin_machine_id, status);
    CREATE INDEX IF NOT EXISTS idx_usage_rows_active_date ON usage_rows(active_date);
    CREATE INDEX IF NOT EXISTS idx_usage_rows_project ON usage_rows(project);
    CREATE INDEX IF NOT EXISTS idx_usage_rows_model ON usage_rows(model);

    CREATE TABLE IF NOT EXISTS usage_store_metadata (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL CHECK (value >= 0)
    );

    CREATE TABLE IF NOT EXISTS usage_machine_fleet_order (
      origin_machine_id TEXT PRIMARY KEY,
      machine_label TEXT NOT NULL,
      sort_rank INTEGER NOT NULL UNIQUE CHECK (sort_rank >= 0)
    );

    CREATE TABLE IF NOT EXISTS usage_local_machine (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      machine_id TEXT NOT NULL CHECK (length(machine_id) > 0),
      machine_label TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('generation', 0);
    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('machine_fleet_generation', 0);
    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('migration.machine-fleet-metadata-v1', 0);
    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('migration.machine-fleet-order-v1', 0);
    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('migration.rtk-contributions-v1', 0);
    INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('migration.merge-row-v3-vcs', 0);

    CREATE TABLE IF NOT EXISTS usage_row_enrichments (
      row_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (row_key, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_usage_row_enrichments_source
      ON usage_row_enrichments(source_id, row_key);

    -- Retired dataset storage is retained unchanged for compatibility; no current reader uses it.
    CREATE TABLE IF NOT EXISTS collected_dataset_items (
      source_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      dataset_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      item_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_id, machine_id, dataset_key, schema_version, item_key)
    );

    CREATE INDEX IF NOT EXISTS idx_collected_dataset_items_query
      ON collected_dataset_items(dataset_key, machine_id, source_id, item_key);

    CREATE TABLE IF NOT EXISTS provider_quota_observations (
      id INTEGER PRIMARY KEY,
      provider_key TEXT NOT NULL,
      provider_label TEXT NOT NULL,
      account_scope TEXT,
      machine_id TEXT NOT NULL,
      machine_label TEXT,
      source_key TEXT NOT NULL,
      source_mode TEXT NOT NULL CHECK (source_mode IN ('poll', 'push', 'backfill')),
      source_confidence TEXT NOT NULL CHECK (source_confidence IN ('authoritative', 'historical', 'derived')),
      source_event_key TEXT,
      state TEXT NOT NULL,
      plan TEXT,
      provider_generated_at TEXT,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_quota_windows (
      observation_id INTEGER NOT NULL REFERENCES provider_quota_observations(id) ON DELETE CASCADE,
      provider_window_id TEXT NOT NULL,
      label TEXT NOT NULL,
      semantic_group TEXT,
      scope TEXT NOT NULL,
      limit_seconds INTEGER,
      used_percent REAL,
      remaining_percent REAL,
      reset_at TEXT,
      blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
      PRIMARY KEY (observation_id, provider_window_id)
    );

    CREATE TABLE IF NOT EXISTS provider_quota_source_state (
      provider_key TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      cursor_key TEXT NOT NULL,
      cursor_json TEXT,
      last_attempt_at TEXT,
      last_success_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_key, machine_id, source_key, cursor_key)
    );

    CREATE TABLE IF NOT EXISTS provider_quota_source_events (
      provider_key TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_event_key TEXT NOT NULL,
      observation_id INTEGER NOT NULL REFERENCES provider_quota_observations(id) ON DELETE CASCADE,
      PRIMARY KEY (provider_key, machine_id, source_key, source_event_key)
    );

    CREATE TABLE IF NOT EXISTS provider_quota_streams (
      provider_key TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      account_scope_key TEXT NOT NULL,
      account_scope TEXT,
      source_key TEXT NOT NULL,
      CHECK (account_scope_key = CASE WHEN account_scope IS NULL THEN 'n:' ELSE 's:' || account_scope END),
      PRIMARY KEY (provider_key, machine_id, account_scope_key, source_key)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS provider_quota_latest_heads (
      provider_key TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      account_scope_key TEXT NOT NULL,
      observation_id INTEGER NOT NULL REFERENCES provider_quota_observations(id) ON DELETE CASCADE,
      confidence_rank INTEGER NOT NULL CHECK (confidence_rank BETWEEN 0 AND 2),
      first_observed_at TEXT NOT NULL,
      PRIMARY KEY (provider_key, machine_id, account_scope_key)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_provider_quota_observed_range
      ON provider_quota_observations(provider_key, machine_id, first_observed_at);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_latest
      ON provider_quota_observations(provider_key, machine_id, account_scope, source_key, first_observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_anchor_normalized
      ON provider_quota_observations(
        provider_key, machine_id, COALESCE(account_scope, ''), source_key, first_observed_at DESC, id DESC
      );
    CREATE INDEX IF NOT EXISTS idx_provider_quota_anchor_exact
      ON provider_quota_observations(
        provider_key, machine_id, account_scope, source_key, first_observed_at DESC, id DESC
      );
    CREATE INDEX IF NOT EXISTS idx_provider_quota_range_all
      ON provider_quota_observations(first_observed_at, id);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_range_provider
      ON provider_quota_observations(provider_key, first_observed_at, id);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_range_machine
      ON provider_quota_observations(machine_id, first_observed_at, id);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_range_account
      ON provider_quota_observations(account_scope, first_observed_at, id);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_range_provider_machine
      ON provider_quota_observations(provider_key, machine_id, first_observed_at, id);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_range_provider_account
      ON provider_quota_observations(provider_key, account_scope, first_observed_at, id);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_range_machine_account
      ON provider_quota_observations(machine_id, account_scope, first_observed_at, id);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_range_provider_machine_account
      ON provider_quota_observations(provider_key, machine_id, account_scope, first_observed_at, id);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_heads_order
      ON provider_quota_latest_heads(confidence_rank, first_observed_at DESC, observation_id DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_heads_provider
      ON provider_quota_latest_heads(
        provider_key, confidence_rank, first_observed_at DESC, observation_id DESC
      );
    CREATE INDEX IF NOT EXISTS idx_provider_quota_heads_machine
      ON provider_quota_latest_heads(
        machine_id, confidence_rank, first_observed_at DESC, observation_id DESC
      );
    CREATE INDEX IF NOT EXISTS idx_provider_quota_heads_provider_machine
      ON provider_quota_latest_heads(
        provider_key, machine_id, confidence_rank, first_observed_at DESC, observation_id DESC
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_quota_source_event
        ON provider_quota_observations(provider_key, machine_id, source_key, source_event_key)
        WHERE source_event_key IS NOT NULL;
      -- Quota retention deletes observations in bulk; without this index every cascaded
      -- provider_quota_source_events delete would scan that table per observation.
      CREATE INDEX IF NOT EXISTS idx_provider_quota_source_events_observation
        ON provider_quota_source_events(observation_id);

    -- Skill observations (ADR 0022). An auxiliary fact family with its own
    -- table and its own read path, deliberately NOT a widening of usage_rows:
    -- a session produces many observations.
    --
    -- The column vocabulary is open on purpose. harness_key and skill_name
    -- carry no CHECK constraint, and resolved_path and success are nullable,
    -- because this store re-validates persisted rows on read: a narrower schema
    -- added later would retroactively invalidate history already on disk.
    -- Narrow at the presentation edge instead. tier is the single exception -
    -- it is a closed three-value domain that the whole feature is built on, so
    -- a row outside it is corruption, not data.
    --
    -- There is no arguments column, and there must never be one. Skill
    -- arguments are user prose; only their presence is recorded.
    CREATE TABLE IF NOT EXISTS skill_observation_collection_state (
      machine_id TEXT NOT NULL,
      harness_key TEXT NOT NULL,
      invocation_truncated INTEGER NOT NULL CHECK (invocation_truncated IN (0, 1)),
      invocation_rejected INTEGER NOT NULL CHECK (invocation_rejected >= 0),
      exposure_truncated INTEGER NOT NULL CHECK (exposure_truncated IN (0, 1)),
      exposure_rejected INTEGER NOT NULL CHECK (exposure_rejected >= 0),
      collected_at TEXT NOT NULL,
      PRIMARY KEY (machine_id, harness_key)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS skill_observations (
      id INTEGER PRIMARY KEY,
      harness_key TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('declared', 'inferred', 'exposed')),
      machine_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      observation_key TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      project_path TEXT,
      resolved_path TEXT,
      args_present INTEGER CHECK (args_present IN (0, 1)),
      success INTEGER CHECK (success IN (0, 1)),
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL
    );

    -- Re-importing an unchanged transcript must not multiply the counts, so the
    -- harness's own call identity is the natural key.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_observations_identity
      ON skill_observations(machine_id, harness_key, session_id, tier, observation_key);
    CREATE INDEX IF NOT EXISTS idx_skill_observations_skill
      ON skill_observations(skill_name, harness_key, tier, observed_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_observations_range
      ON skill_observations(observed_at, id);
    -- The read budgets the tier groups separately, because exposure is written
    -- per catalogue entry per session and would otherwise crowd out every real
    -- invocation. That makes "most recent rows of these tiers" the hot query,
    -- and this is the covering order for it.
    CREATE INDEX IF NOT EXISTS idx_skill_observations_tier
      ON skill_observations(tier, observed_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_observations_machine
      ON skill_observations(machine_id, observed_at, id);

    -- Executor observations: which harness CLIs a machine can run and whether they are signed
    -- in, observed by the executors.capabilities source. Retention is 10 rows per machine and
    -- harness, enforced on import. auth_evidence is a bounded, credential-free classification.
    CREATE TABLE IF NOT EXISTS executor_observations (
      id INTEGER PRIMARY KEY,
      machine_id TEXT NOT NULL,
      harness TEXT NOT NULL CHECK (harness IN ('claude-code', 'codex')),
      observed_at TEXT NOT NULL,
      binary_path TEXT,
      version TEXT,
      auth_state TEXT NOT NULL CHECK (auth_state IN ('logged-in', 'logged-out', 'unknown')),
      auth_evidence TEXT NOT NULL,
      auth_method TEXT,
      account_fingerprint TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('observed', 'unavailable', 'timeout', 'invalid'))
    );
    CREATE INDEX IF NOT EXISTS idx_executor_observations_latest
      ON executor_observations(machine_id, harness, observed_at DESC, id DESC);
    `);
  return false;
};

const migrateWorkFactFamily: MigrationStep = (db) => {
  db.exec(workFactSchemaSql);
  return migrateWorkFactSchema(db);
};

const createWorkThreadTables: MigrationStep = (db) => {
  db.exec(workThreadSchemaSql);
  return false;
};

const migrateExecutorObservations: MigrationStep = (db) => {
  let changed = false;
  // Additive under the same user_version: a store that created executor_observations before the
  // sign-in method was recorded gains the nullable column; older rows read as "no method".
  const executorColumns = db.query('PRAGMA table_info(executor_observations)').all() as Array<{ name?: unknown }>;
  if (!executorColumns.some((column) => column.name === 'auth_method')) {
    changed = true;
    db.exec('ALTER TABLE executor_observations ADD COLUMN auth_method TEXT');
  }
  // Same rule for the account fingerprint (ADR 0057): older rows read as "no identity reported".
  if (!executorColumns.some((column) => column.name === 'account_fingerprint')) {
    changed = true;
    db.exec('ALTER TABLE executor_observations ADD COLUMN account_fingerprint TEXT');
  }
  // The account-change barrier table is created when absent, under the same user_version, and
  // backfilled from the retained history; it needs the fingerprint column above.
  if (migrateExecutorAccountChangeSchema(db)) {
    changed = true;
  }
  return changed;
};

// Review attempts gain the reservation, scope and guarantee columns and the reserving unique
// index additively (ADR 0055); the helper reports whether it changed anything.
const migrateReviewAttempts: MigrationStep = (db) => migrateReviewAttemptSchema(db);

// The delegation tables are created when absent, under the same user_version (ADR 0075).
const migrateDelegation: MigrationStep = (db) => migrateDelegationSchema(db);

const backfillSkillObservationCollectionState: MigrationStep = (db, probe) => {
  if (probe.skillObservationCollectionStateMissing) {
    // Stores written by the first implementation have observation/session
    // rows but no durable producer bound. The lost answer cannot be
    // reconstructed, so migrate those observable machine/harness pairs as
    // incomplete until their next successful sweep replaces the sentinel.
    db.query(`
        INSERT INTO skill_observation_collection_state (
          machine_id, harness_key,
          invocation_truncated, invocation_rejected,
          exposure_truncated, exposure_rejected,
          collected_at
        )
        SELECT machine_id, harness_key, 1, 0, 0, 0, ?
        FROM (
          SELECT origin_machine_id AS machine_id, harness_key
          FROM usage_rows
          WHERE source_authority = 'local-observed'
            AND harness_key IN ('claude', 'codex', 'opencode')
          GROUP BY origin_machine_id, harness_key
          UNION
          SELECT machine_id, harness_key
          FROM skill_observations
          WHERE harness_key IN ('claude', 'codex', 'opencode')
          GROUP BY machine_id, harness_key
        )
      `).run(new Date().toISOString());
    const { changed } = db.query('SELECT changes() AS changed').get() as { changed: number };
    if (changed > 0) {
      db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
    }
  }
  return false;
};

const createClaudeDesktopSessionTables: MigrationStep = (db) => {
  db.exec(claudeDesktopSessionSchemaSql);
  return false;
};

const createCodexWorkTables: MigrationStep = (db) => {
  db.exec(codexWorkSchemaSql);
  return false;
};

// Additive under the same user_version (ADR 0056): a claude_desktop_sessions table created before
// the harness's message time was recorded gains the nullable column; older rows read as "none".
const addClaudeDesktopMessageTime: MigrationStep = (db) => {
  const desktopColumns = db.query('PRAGMA table_info(claude_desktop_sessions)').all() as Array<{ name?: unknown }>;
  if (!desktopColumns.some((column) => column.name === 'latest_user_frame_at')) {
    db.exec('ALTER TABLE claude_desktop_sessions ADD COLUMN latest_user_frame_at TEXT');
    return true;
  }
  return false;
};

// Schema 5 drops the replication outbox that schema 4 added: the store is local-only and nothing
// reads or writes those objects any more. Schema-3 and fresh stores never had them, hence IF EXISTS.
const dropReplicationOutbox: MigrationStep = (db, probe) => {
  if (probe.userVersion < 5) {
    db.exec(`
        DROP INDEX IF EXISTS idx_replication_outbox_ready;
        DROP INDEX IF EXISTS idx_replication_outbox_fact_history;
        DROP TABLE IF EXISTS replication_outbox_events;
        DROP TABLE IF EXISTS replication_outbox_state;
      `);
  }
  return false;
};

const createServedReportTables: MigrationStep = (db) => {
  db.exec(servedReportSchemaSql);
  return false;
};

const assertLocalMachineProjection: MigrationStep = (db) => {
  if (!hasExactUsageLocalMachineSchema(db)) {
    throw new Error('The local machine projection schema is incompatible.');
  }
  return false;
};

const backfillProviderQuotaReadProjections: MigrationStep = (db, probe) => {
  if (probe.quotaReadProjectionMissing) {
    db.exec(`
        INSERT OR IGNORE INTO provider_quota_streams (
          provider_key, machine_id, account_scope_key, account_scope, source_key
        )
        SELECT
          provider_key,
          machine_id,
          CASE WHEN account_scope IS NULL THEN 'n:' ELSE 's:' || account_scope END,
          account_scope,
          source_key
        FROM provider_quota_observations
        GROUP BY provider_key, machine_id, account_scope, source_key;

        WITH ranked AS (
          SELECT
            provider_key,
            machine_id,
            COALESCE(account_scope, '') AS account_scope_key,
            id AS observation_id,
            CASE source_confidence WHEN 'authoritative' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END AS confidence_rank,
            first_observed_at,
            ROW_NUMBER() OVER (
              PARTITION BY provider_key, machine_id, COALESCE(account_scope, '')
              ORDER BY
                CASE source_confidence WHEN 'authoritative' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END,
                first_observed_at DESC,
                id DESC
            ) AS latest_rank
          FROM provider_quota_observations
        )
        INSERT OR REPLACE INTO provider_quota_latest_heads (
          provider_key, machine_id, account_scope_key, observation_id, confidence_rank, first_observed_at
        )
        SELECT
          provider_key, machine_id, account_scope_key, observation_id, confidence_rank, first_observed_at
        FROM ranked
        WHERE latest_rank = 1;
      `);
    const streamBudgetRows = db
      .query('SELECT 1 FROM provider_quota_streams LIMIT ?')
      .all(MAX_PROVIDER_QUOTA_STREAMS + 1);
    if (streamBudgetRows.length > MAX_PROVIDER_QUOTA_STREAMS) {
      throw new Error(`Provider quota history exceeds its ${MAX_PROVIDER_QUOTA_STREAMS}-stream read budget`);
    }
  }
  return false;
};

const addUsageRowColumns: MigrationStep = (db) => {
  let changed = false;
  const columns = db.query('PRAGMA table_info(usage_rows)').all() as Array<{ name?: unknown }>;
  if (!columns.some((column) => column.name === 'source_authority')) {
    changed = true;
    db.exec(
      "ALTER TABLE usage_rows ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'portable-opaque' CHECK (source_authority IN ('local-observed', 'portable-opaque'))",
    );
  }
  if (!columns.some((column) => column.name === 'machine_label')) {
    changed = true;
    db.exec("ALTER TABLE usage_rows ADD COLUMN machine_label TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((column) => column.name === 'fleet_metadata_valid')) {
    changed = true;
    db.exec(
      'ALTER TABLE usage_rows ADD COLUMN fleet_metadata_valid INTEGER NOT NULL DEFAULT 0 CHECK (fleet_metadata_valid IN (0, 1))',
    );
  }
  return changed;
};

const createMachineFleetInvalidation: MigrationStep = (db) => {
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_rows_fleet
        ON usage_rows(fleet_metadata_valid, origin_machine_id, last_seen_at DESC, row_key ASC);

      CREATE TRIGGER IF NOT EXISTS usage_rows_invalidate_fleet_metadata_after_insert
      AFTER INSERT ON usage_rows
      BEGIN
        UPDATE usage_rows
        SET machine_label = '', fleet_metadata_valid = 0
        WHERE row_key = NEW.row_key;
      END;

      CREATE TRIGGER IF NOT EXISTS usage_rows_invalidate_fleet_metadata_after_update
      AFTER UPDATE OF origin_machine_id, row_json, status, active_date, last_seen_at, source_authority ON usage_rows
      BEGIN
        UPDATE usage_rows
        SET machine_label = '', fleet_metadata_valid = 0
        WHERE row_key = NEW.row_key;
      END;
    `);
  return false;
};

// ---------------------------------------------------------------------------------------------------------
// Legacy row migrations, each guarded by its `migration.*` marker in usage_store_metadata.

const migrateMergeRowsToVcs: MigrationStep = (db) => {
  const mergeRowMigration = db
    .query("SELECT value FROM usage_store_metadata WHERE key = 'migration.merge-row-v3-vcs'")
    .get() as UsageStoreGenerationRecord | null;
  if (mergeRowMigration?.value !== 0) {
    return false;
  }
  const migratedAt = new Date().toISOString();
  const legacyRows = db
    .query('SELECT row_key, source_fingerprint, content_hash, row_json, status FROM usage_rows')
    .all() as Array<{
    content_hash: string;
    row_json: string;
    row_key: string;
    source_fingerprint: string;
    status: StoredUsageRowStatus;
  }>;
  const updateLegacyRow = db.query(`
        UPDATE usage_rows
        SET source_fingerprint = ?, content_hash = ?, row_json = ?, updated_at = ?
        WHERE row_key = ?
      `);
  let activeProjectionChanged = false;
  for (const legacy of legacyRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(legacy.row_json) as unknown;
    } catch {
      continue;
    }
    const migrationResult = migrateLegacySerializedMergeRow(parsed);
    if (
      !migrationResult ||
      migrationResult.legacy.rowKey !== legacy.row_key ||
      migrationResult.legacy.sourceFingerprint !== legacy.source_fingerprint ||
      migrationResult.legacy.contentHash !== legacy.content_hash ||
      migrationResult.legacy.status !== legacy.status
    ) {
      continue;
    }
    const migrated = migrationResult.row;
    updateLegacyRow.run(
      migrated.sourceFingerprint,
      migrated.contentHash,
      JSON.stringify(migrated),
      migratedAt,
      migrated.rowKey,
    );
    activeProjectionChanged ||= migrated.status === 'active';
  }
  if (activeProjectionChanged) {
    db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
  }
  db.query("UPDATE usage_store_metadata SET value = 1 WHERE key = 'migration.merge-row-v3-vcs'").run();
  return true;
};

const migrateRtkContributions: MigrationStep = (db) => {
  const migration = db
    .query("SELECT value FROM usage_store_metadata WHERE key = 'migration.rtk-contributions-v1'")
    .get() as UsageStoreGenerationRecord | null;
  if (migration?.value !== 0) {
    return false;
  }
  const migratedAt = new Date().toISOString();
  const legacyRows = db.query('SELECT row_key, row_json FROM usage_rows').all() as Array<{
    row_json: string;
    row_key: string;
  }>;
  const insert = db.query(`
        INSERT OR IGNORE INTO usage_row_enrichments (
          row_key, source_id, schema_version, content_hash, payload_json,
          first_seen_at, last_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
  for (const legacy of legacyRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(legacy.row_json) as unknown;
    } catch {
      continue;
    }
    if (!isSerializedMergeRow(parsed)) {
      continue;
    }
    const contribution = rtkSavingsFromRow(parsed);
    if (!contribution) {
      continue;
    }
    insert.run(
      legacy.row_key,
      RTK_SAVINGS_SOURCE_ID,
      RTK_SAVINGS_SCHEMA_VERSION,
      enrichmentContentHash(contribution),
      JSON.stringify(contribution),
      migratedAt,
      migratedAt,
      migratedAt,
    );
  }
  db.query("UPDATE usage_store_metadata SET value = 1 WHERE key = 'migration.rtk-contributions-v1'").run();
  return true;
};

const migrateMachineFleetMetadata: MigrationStep = (db) => {
  const fleetMetadataMigration = db
    .query("SELECT value FROM usage_store_metadata WHERE key = 'migration.machine-fleet-metadata-v1'")
    .get() as UsageStoreGenerationRecord | null;
  if (fleetMetadataMigration?.value !== 0) {
    return false;
  }
  const legacyRows = db
    .query(`
          SELECT active_date, last_seen_at, origin_machine_id, row_json, row_key, source_authority, status
          FROM usage_rows
          ORDER BY origin_machine_id, row_key
        `)
    .iterate() as IterableIterator<StoredMachineFleetRow>;
  const updateFleetMetadata = db.query(`
        UPDATE usage_rows
        SET machine_label = ?, fleet_metadata_valid = ?
        WHERE row_key = ?
      `);
  for (const row of legacyRows) {
    const metadata = fleetMetadataForStoredRow(row);
    updateFleetMetadata.run(metadata?.machineLabel ?? '', metadata ? 1 : 0, row.row_key);
  }
  db.query("UPDATE usage_store_metadata SET value = 1 WHERE key = 'migration.machine-fleet-metadata-v1'").run();
  return true;
};

const migrateMachineFleetOrder: MigrationStep = (db) => {
  const fleetOrderMigration = db
    .query("SELECT value FROM usage_store_metadata WHERE key = 'migration.machine-fleet-order-v1'")
    .get() as UsageStoreGenerationRecord | null;
  if (fleetOrderMigration?.value !== 0) {
    return false;
  }
  rebuildUsageMachineFleetOrder(db);
  db.query("UPDATE usage_store_metadata SET value = 1 WHERE key = 'migration.machine-fleet-order-v1'").run();
  return true;
};

// The order is the migration's order; every step runs on every open.
const MIGRATION_STEPS: readonly MigrationStep[] = [
  createBaseSchema,
  migrateWorkFactFamily,
  createWorkThreadTables,
  migrateExecutorObservations,
  migrateReviewAttempts,
  migrateDelegation,
  backfillSkillObservationCollectionState,
  createClaudeDesktopSessionTables,
  createCodexWorkTables,
  addClaudeDesktopMessageTime,
  dropReplicationOutbox,
  createServedReportTables,
  assertLocalMachineProjection,
  backfillProviderQuotaReadProjections,
  addUsageRowColumns,
  createMachineFleetInvalidation,
  migrateMergeRowsToVcs,
  migrateRtkContributions,
  migrateMachineFleetMetadata,
  migrateMachineFleetOrder,
];

export const migrate = (db: SqliteDatabase): boolean => {
  const probe = probeStore(db);
  let schemaChanged = probe.schemaChanged;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const step of MIGRATION_STEPS) {
      if (step(db, probe)) {
        schemaChanged = true;
      }
    }
    db.exec(`PRAGMA user_version = ${USAGE_STORE_SCHEMA_VERSION}`);
    db.exec('COMMIT');
    return schemaChanged;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
