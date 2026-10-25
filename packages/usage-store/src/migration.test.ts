import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { completeSkillObservationCollection } from '@ai-usage/report-core/skill-observation';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import {
  queryClaudeDesktopSessions,
  queryLatestExecutorObservations,
  queryLatestProviderQuotaObservations,
  queryProviderQuotaObservations,
  querySkillObservations,
  queryUsageLocalMachine,
  queryUsageStoreGeneration,
  USAGE_STORE_SCHEMA_VERSION,
} from './reader';
import { SERVED_REPORT_PROJECTION_SCHEMA_VERSION } from './served-revision';
import {
  importClaudeDesktopSessions,
  importExecutorObservations,
  importLocalRows,
  importProviderQuotaBatch,
  importSkillObservations,
  initializeUsageStore,
  updateUsageMachineLabel,
} from './writer';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

interface SchemaObject {
  readonly name: string;
  readonly sql: string | null;
  readonly tbl_name: string;
  readonly type: string;
}

const durableTables = [
  'checkout_status_observations',
  'executor_observations',
  'claude_desktop_collection_state',
  'claude_desktop_sessions',
  'claude_desktop_turn_declarations',
  'jira_issue_observations',
  'provider_quota_observations',
  'pull_request_observations',
  'served_report_revisions',
  'skill_observation_collection_state',
  'skill_observations',
  'usage_local_machine',
  'usage_rows',
  'work_fact_run_state',
] as const;

const readUserVersion = (db: Database): number =>
  (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;

const readSchema = (db: Database): SchemaObject[] =>
  db
    .query("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as SchemaObject[];

const readMetadata = (db: Database): Array<{ key: string; value: number }> =>
  db.query('SELECT key, value FROM usage_store_metadata ORDER BY key').all() as Array<{ key: string; value: number }>;

const readCounts = (db: Database): Record<string, number> =>
  Object.fromEntries(
    durableTables.map((table) => [
      table,
      (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]),
  );

describe('usage-store forward migration', () => {
  test('preserves an incompatible served projection instead of deleting its current revision', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-served-schema-preservation-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(initializeUsageStore({ dbPath }));

    const legacy = new Database(dbPath, { create: false, readwrite: true });
    legacy.exec(`
      INSERT INTO served_report_revisions (
        revision, capture_fingerprint, private_capture_fingerprint, config_fingerprint,
        usage_store_generation, machine_fleet_generation, projection_schema_version,
        generated_at, published_at, expires_at, complete, row_count, segment_count,
        filter_key_count, rows_bytes, support_bytes, projection_bytes
      ) VALUES (
        'legacy-revision', '${'a'.repeat(64)}', '${'b'.repeat(64)}', '${'c'.repeat(64)}',
        1, 1, 15, '2026-07-30T10:00:00.000Z', 1000, 2000, 1, 0, 0, 0, 0, 0, 0
      );
      INSERT INTO served_report_current (singleton, revision, required_complete)
      VALUES (1, 'legacy-revision', 1);
      DROP INDEX idx_served_report_rows_local_time_cell;
      ALTER TABLE served_report_rows DROP COLUMN local_time_weekday;
      ALTER TABLE served_report_rows DROP COLUMN local_time_hour;
      ALTER TABLE served_report_rows DROP COLUMN harness_provider_key;
      ALTER TABLE served_report_rows DROP COLUMN lines_measured;
      PRAGMA user_version = 2;
    `);
    legacy.close(true);

    const outcome = await Effect.runPromise(Effect.result(initializeUsageStore({ dbPath })));
    expect(outcome._tag).toBe('Failure');

    const preserved = new Database(dbPath, { create: false, readonly: true });
    const currentRevision = preserved.query('SELECT revision FROM served_report_current WHERE singleton = 1').get() as {
      revision: string;
    } | null;
    const servedRevision = preserved
      .query('SELECT revision FROM served_report_revisions WHERE revision = ?')
      .get('legacy-revision') as { revision: string } | null;
    expect(currentRevision?.revision).toBe('legacy-revision');
    expect(servedRevision?.revision).toBe('legacy-revision');
    preserved.close(true);
  });

  test('rolls back all projection DDL on failure, preserves populated state, and retries idempotently', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE legacy_marker (value TEXT NOT NULL);
      INSERT INTO legacy_marker (value) VALUES ('preserved');
      CREATE VIEW served_report_rows AS SELECT 1 AS incompatible;
      PRAGMA user_version = 0;
    `);
    legacy.close(true);
    await chmod(dbPath, 0o600);

    const failed = await Effect.runPromise(Effect.result(initializeUsageStore({ dbPath })));
    expect(failed._tag).toBe('Failure');

    const afterFailure = new Database(dbPath, { create: false, readwrite: true });
    const failedVersion = afterFailure.query('PRAGMA user_version').get() as { user_version: number };
    const partialProjectionTables = afterFailure
      .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'served_%'")
      .all();
    const marker = afterFailure.query('SELECT value FROM legacy_marker').get() as { value: string };
    expect(failedVersion.user_version).toBe(0);
    expect(partialProjectionTables).toEqual([]);
    expect(marker.value).toBe('preserved');
    afterFailure.exec('DROP VIEW served_report_rows');
    afterFailure.close(true);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);

    const migrated = new Database(dbPath, { create: false, readonly: true });
    const migratedVersion = migrated.query('PRAGMA user_version').get() as { user_version: number };
    const servedTables = migrated
      .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'served_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(migratedVersion.user_version).toBe(USAGE_STORE_SCHEMA_VERSION);
    expect(servedTables.map(({ name }) => name)).toEqual([
      'served_report_current',
      'served_report_local_context',
      'served_report_revisions',
      'served_report_rows',
      'served_report_support',
      'served_session_model_filter_keys',
      'served_session_model_segments',
    ]);
    expect((migrated.query('SELECT value FROM legacy_marker').get() as { value: string }).value).toBe('preserved');
    migrated.close(true);
  });

  test('migrates a populated v1 store to the empty machine projection without changing durable data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-machine-v2-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    const machine = { id: 'migration-machine', label: 'Migration machine' };
    const row = normalizeUsageRow({
      calls: 1,
      cost: actualCost(null),
      date: new Date('2026-07-30T10:00:00.000Z'),
      durationMs: 1000,
      endDate: new Date('2026-07-30T10:01:00.000Z'),
      harness: 'Codex',
      model: 'gpt-5',
      name: 'Migrated session',
      project: 'ai-usage',
      provider: 'OpenAI',
      tokens: { cr: 0, cw: 0, in: 10, out: 20 },
    });
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
    await Effect.runPromise(importLocalRows({ dbPath, machine, rows: [row] }));

    const legacy = new Database(dbPath, { create: false, readwrite: true });
    const generationsBefore = legacy
      .query(
        "SELECT key, value FROM usage_store_metadata WHERE key IN ('generation', 'machine_fleet_generation') ORDER BY key",
      )
      .all();
    legacy.exec(`
      INSERT INTO served_report_revisions (
        revision, capture_fingerprint, private_capture_fingerprint, config_fingerprint,
        usage_store_generation, machine_fleet_generation, projection_schema_version,
        generated_at, published_at, expires_at, complete, row_count, segment_count,
        filter_key_count, rows_bytes, support_bytes, projection_bytes
      ) VALUES (
        'migration-revision', '${'a'.repeat(64)}', '${'b'.repeat(64)}', '${'c'.repeat(64)}',
        1, 1, 14, '2026-07-30T10:00:00.000Z', 1000, 2000, 1, 0, 0, 0, 0, 0, 0
      );
      INSERT INTO served_report_current (singleton, revision, required_complete)
      VALUES (1, 'migration-revision', 1);
      DROP TABLE usage_local_machine;
      PRAGMA user_version = 1;
    `);
    legacy.close(true);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);

    const migrated = new Database(dbPath, { create: false, readonly: true });
    expect((migrated.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      USAGE_STORE_SCHEMA_VERSION,
    );
    expect((migrated.query('SELECT COUNT(*) AS count FROM usage_rows').get() as { count: number }).count).toBe(1);
    expect(
      migrated
        .query(
          "SELECT key, value FROM usage_store_metadata WHERE key IN ('generation', 'machine_fleet_generation') ORDER BY key",
        )
        .all(),
    ).toEqual(generationsBefore);
    expect(migrated.query('SELECT revision FROM served_report_current WHERE singleton = 1').get()).toEqual({
      revision: 'migration-revision',
    });
    expect((migrated.query('SELECT COUNT(*) AS count FROM usage_local_machine').get() as { count: number }).count).toBe(
      0,
    );
    migrated.close();

    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
    expect(await Effect.runPromise(queryUsageLocalMachine({ dbPath }))).toEqual(machine);
  });

  test('rolls back v2 migration when a same-name machine table omits required constraints', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-machine-v2-conflict-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const conflict = new Database(dbPath, { create: false, readwrite: true });
    conflict.exec(`
      DROP TABLE usage_local_machine;
      CREATE TABLE usage_local_machine (
        singleton INTEGER PRIMARY KEY,
        machine_id TEXT NOT NULL,
        machine_label TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    conflict.close(true);

    const failed = await Effect.runPromise(Effect.result(initializeUsageStore({ dbPath })));
    expect(failed._tag).toBe('Failure');
    const afterFailure = new Database(dbPath, { create: false, readwrite: true });
    expect((afterFailure.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    const sql = afterFailure
      .query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'usage_local_machine'")
      .get() as { sql: string };
    expect(sql.sql).not.toContain('CHECK (singleton = 1)');
    afterFailure.exec('DROP TABLE usage_local_machine');
    afterFailure.close(true);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
  });

  test('backfills bounded quota read projections once for populated same-version stores', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-quota-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    const observation: ProviderQuotaObservation = {
      accountScope: null,
      machineId: 'machine-a',
      machineLabel: 'Machine A',
      observedAt: '2026-07-15T01:00:00.000Z',
      plan: 'plus',
      providerGeneratedAt: null,
      providerKey: 'codex',
      providerLabel: 'Codex',
      source: { confidence: 'authoritative', key: 'poll', mode: 'poll' },
      state: 'ok',
      windows: [],
    };
    await Effect.runPromise(
      importProviderQuotaBatch({
        checkpointUpdates: [],
        dbPath,
        items: [{ observation, sourceEventKey: 'event-a' }],
      }),
    );
    const beforeMigration = new Database(dbPath, { create: false, readwrite: true });
    beforeMigration.exec(`
      DROP TABLE provider_quota_latest_heads;
      DROP TABLE provider_quota_streams;
    `);
    beforeMigration.close(true);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    const history = await Effect.runPromise(
      queryProviderQuotaObservations({
        dbPath,
        from: '2026-07-15T02:00:00.000Z',
        to: '2026-07-15T03:00:00.000Z',
      }),
    );
    const latest = await Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath }));
    const migrated = new Database(dbPath, { create: false, readonly: true });
    const streamCount = migrated.query('SELECT COUNT(*) AS count FROM provider_quota_streams').get() as {
      count: number;
    };
    const headCount = migrated.query('SELECT COUNT(*) AS count FROM provider_quota_latest_heads').get() as {
      count: number;
    };
    migrated.close(true);

    expect(history.observations.map(({ firstObservedAt }) => firstObservedAt)).toEqual(['2026-07-15T01:00:00.000Z']);
    expect(latest.observations.map(({ firstObservedAt }) => firstObservedAt)).toEqual(['2026-07-15T01:00:00.000Z']);
    expect(streamCount.count).toBe(1);
    expect(headCount.count).toBe(1);
  });

  test('adds the skill observation family to a populated store already on the current version', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-skill-observation-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const machine = { id: 'legacy-machine', label: 'Legacy machine' };
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine,
        rows: [
          {
            ...normalizeUsageRow({
              calls: 1,
              cost: actualCost(null),
              date: new Date('2026-08-01T08:00:00.000Z'),
              durationMs: 1000,
              endDate: new Date('2026-08-01T08:01:00.000Z'),
              harness: 'Claude Code',
              model: 'claude-sonnet-4-6',
              name: 'Legacy session',
              project: 'ai-usage',
              provider: 'Claude sub',
              tokens: { cr: 0, cw: 0, in: 10, out: 20 },
            }),
            source: {
              harnessKey: 'claude',
              sourcePath: '/home/alex/Projects/ai-usage',
              sourceSessionId: 'legacy-session',
            },
          },
        ],
      }),
    );

    // A store written before this family existed carries the current
    // user_version, so absence of the table is the only available signal.
    const beforeMigration = new Database(dbPath, { create: false, readwrite: true });
    expect(
      beforeMigration.query('SELECT origin_machine_id, harness_key, source_authority FROM usage_rows').all(),
    ).toEqual([{ harness_key: 'claude', origin_machine_id: machine.id, source_authority: 'local-observed' }]);
    beforeMigration.exec('DROP TABLE skill_observations;');
    beforeMigration.exec('DROP TABLE skill_observation_collection_state;');
    const droppedVersion = beforeMigration.query('PRAGMA user_version').get() as { user_version: number };
    beforeMigration.close(true);
    expect(droppedVersion.user_version).toBe(USAGE_STORE_SCHEMA_VERSION);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    const legacyCompleteness = await Effect.runPromise(querySkillObservations({ dbPath }));
    expect(legacyCompleteness.collectionInvocationIncomplete).toBe(true);

    await Effect.runPromise(
      importSkillObservations({
        collection: {
          completeness: completeSkillObservationCollection(),
          harnessKey: 'opencode',
        },
        dbPath,
        machineId: 'machine-a',
        observations: [
          {
            argsPresent: null,
            harnessKey: 'opencode',
            observationKey: 'call_abc',
            observedAt: '2026-08-01T09:00:00.000Z',
            projectPath: null,
            resolvedPath: null,
            sessionId: 'session-1',
            skillName: 'write-a-skill',
            success: true,
            tier: 'declared',
          },
        ],
      }),
    );

    const migrated = new Database(dbPath, { create: false, readonly: true });
    const indexes = migrated
      .query("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'skill_observations' ORDER BY name")
      .all() as { name: string }[];
    const rowCount = migrated.query('SELECT COUNT(*) AS count FROM skill_observations').get() as { count: number };
    const stateCount = migrated.query('SELECT COUNT(*) AS count FROM skill_observation_collection_state').get() as {
      count: number;
    };
    migrated.close(true);

    expect(rowCount.count).toBe(1);
    expect(stateCount.count).toBe(2);
    expect(indexes.map(({ name }) => name)).toEqual([
      'idx_skill_observations_identity',
      'idx_skill_observations_machine',
      'idx_skill_observations_range',
      'idx_skill_observations_skill',
      // The tier-group read's covering index, added additively: `CREATE INDEX IF NOT EXISTS` in the
      // same schema statement as the other four, with no schema-version bump, so an existing store
      // gains it on the next open rather than through a migration step of its own.
      'idx_skill_observations_tier',
    ]);

    const read = await Effect.runPromise(querySkillObservations({ dbPath }));
    expect(read.skipped).toBe(0);
    expect(read.observations.map(({ observation }) => observation.skillName)).toEqual(['write-a-skill']);
  });

  test('adds the executor observation table to a current-version store without bumping user_version', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-executor-observation-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const generationBefore = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));

    const beforeMigration = new Database(dbPath, { create: false, readwrite: true });
    beforeMigration.exec('DROP TABLE executor_observations;');
    expect(readUserVersion(beforeMigration)).toBe(USAGE_STORE_SCHEMA_VERSION);
    beforeMigration.close(true);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    const observation = {
      authEvidence: 'codex login status exit 0 (output mentions "Logged in")',
      authState: 'logged-in',
      binaryPath: '/usr/bin/codex',
      harness: 'codex',
      machineId: 'machine-a',
      observedAt: '2026-10-21T21:00:00.000Z',
      outcome: 'observed',
      version: 'codex-cli 0.163.0',
    };
    const imported = await Effect.runPromise(
      importExecutorObservations({
        dbPath,
        observations: [
          ...Array.from({ length: 12 }, (_, index) => ({
            ...observation,
            observedAt: new Date(Date.parse(observation.observedAt) + index * 60_000).toISOString(),
          })),
          { ...observation, harness: 'claude-code', binaryPath: '/usr/bin/claude', version: '2.1.303 (Claude Code)' },
          { ...observation, harness: 'cursor' },
        ],
      }),
    );
    expect(imported).toEqual({ inserted: 13, pruned: 2, rejected: 1 });

    const migrated = new Database(dbPath, { create: false, readonly: true });
    expect(readUserVersion(migrated)).toBe(USAGE_STORE_SCHEMA_VERSION);
    const retained = migrated
      .query('SELECT harness, COUNT(*) AS count FROM executor_observations GROUP BY harness ORDER BY harness')
      .all();
    expect(retained).toEqual([
      { count: 1, harness: 'claude-code' },
      { count: 10, harness: 'codex' },
    ]);
    // A row that fails re-validation is counted, not served.
    migrated.close(true);
    const corrupting = new Database(dbPath, { create: false, readwrite: true });
    corrupting.exec(`
      INSERT INTO executor_observations (machine_id, harness, observed_at, binary_path, version, auth_state, auth_evidence, outcome)
      VALUES ('machine-b', 'codex', 'not-a-time', NULL, NULL, 'unknown', 'manual row', 'invalid');
    `);
    corrupting.close(true);

    const latest = await Effect.runPromise(queryLatestExecutorObservations({ dbPath }));
    expect(latest.truncated).toBe(false);
    expect(latest.skipped).toBe(1);
    expect(latest.observations.map(({ harness, observedAt }) => [harness, observedAt])).toEqual([
      ['claude-code', '2026-10-21T21:00:00.000Z'],
      ['codex', '2026-10-21T21:11:00.000Z'],
    ]);
    expect(await Effect.runPromise(queryLatestExecutorObservations({ dbPath, machineId: 'machine-b' }))).toEqual({
      observations: [],
      skipped: 1,
      truncated: false,
    });
    // Observations qualify routing; they are not report data and never request a publication.
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toEqual(generationBefore);
  });

  test('adds the delegation tables to a current-version store without bumping user_version, idempotently', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-delegation-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const generationBefore = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));

    const beforeMigration = new Database(dbPath, { create: false, readwrite: true });
    beforeMigration.exec(
      'DROP TABLE delegation_evaluations; DROP TABLE delegation_jobs; DROP TABLE delegation_qualifications;',
    );
    const schemaWithout = readSchema(beforeMigration);
    expect(readUserVersion(beforeMigration)).toBe(USAGE_STORE_SCHEMA_VERSION);
    beforeMigration.close(true);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    const migrated = new Database(dbPath, { create: false, readonly: true });
    expect(readUserVersion(migrated)).toBe(USAGE_STORE_SCHEMA_VERSION);
    const schemaAfter = readSchema(migrated);
    const added = schemaAfter.filter((object) => !schemaWithout.some((previous) => previous.name === object.name));
    expect(added.filter((object) => object.type === 'table').map((object) => object.name)).toEqual([
      'delegation_evaluations',
      'delegation_jobs',
      'delegation_qualifications',
    ]);
    expect(added.filter((object) => object.type === 'index').map((object) => object.name)).toEqual([
      'idx_delegation_evaluations_job',
      'idx_delegation_jobs_machine_state',
      'idx_delegation_jobs_pool',
      'idx_delegation_jobs_reserved_target',
      'idx_delegation_jobs_retry_of',
      'idx_delegation_jobs_target',
      'idx_delegation_qualifications_machine',
    ]);
    // Everything that was there before is unchanged.
    expect(schemaAfter.filter((object) => !added.includes(object))).toEqual(schemaWithout);
    migrated.close(true);

    // A second open changes nothing.
    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    const reopened = new Database(dbPath, { create: false, readonly: true });
    expect(readSchema(reopened)).toEqual(schemaAfter);
    reopened.close(true);
    // Jobs are not report data: the generation that drives publication did not move.
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toEqual(generationBefore);
  });

  test('adds the auth_method column to an executor_observations table written before it, without bumping user_version', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-executor-auth-method-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const generationBefore = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));

    // The table as the first implementation created it, with one row from that time.
    const before = new Database(dbPath, { create: false, readwrite: true });
    before.exec(`
      DROP TABLE executor_observations;
      CREATE TABLE executor_observations (
        id INTEGER PRIMARY KEY,
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL CHECK (harness IN ('claude-code', 'codex')),
        observed_at TEXT NOT NULL,
        binary_path TEXT,
        version TEXT,
        auth_state TEXT NOT NULL CHECK (auth_state IN ('logged-in', 'logged-out', 'unknown')),
        auth_evidence TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('observed', 'unavailable', 'timeout', 'invalid'))
      );
      INSERT INTO executor_observations (machine_id, harness, observed_at, binary_path, version, auth_state, auth_evidence, outcome)
      VALUES ('machine-a', 'codex', '2026-10-21T20:00:00.000Z', '/usr/bin/codex', 'codex-cli 0.163.0', 'logged-in', 'codex login status exit 0', 'observed');
    `);
    const columnsBefore = before.query('PRAGMA table_info(executor_observations)').all() as { name: string }[];
    expect(columnsBefore.map(({ name }) => name)).not.toContain('auth_method');
    before.close(true);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    const migrated = new Database(dbPath, { create: false, readonly: true });
    expect(readUserVersion(migrated)).toBe(USAGE_STORE_SCHEMA_VERSION);
    const columns = migrated.query('PRAGMA table_info(executor_observations)').all() as { name: string }[];
    expect(columns.map(({ name }) => name)).toContain('auth_method');
    migrated.close(true);

    // The pre-column row reads as "no method"; a new row carries the method it observed.
    const imported = await Effect.runPromise(
      importExecutorObservations({
        dbPath,
        observations: [
          {
            authEvidence: 'claude auth status exit 0 loggedIn=true authMethod=api-key',
            authMethod: 'api-key',
            authState: 'logged-in',
            binaryPath: '/usr/bin/claude',
            harness: 'claude-code',
            machineId: 'machine-a',
            observedAt: '2026-10-21T21:00:00.000Z',
            outcome: 'observed',
            version: '2.1.303 (Claude Code)',
          },
        ],
      }),
    );
    expect(imported).toEqual({ inserted: 1, pruned: 0, rejected: 0 });
    const latest = await Effect.runPromise(queryLatestExecutorObservations({ dbPath }));
    expect(latest.skipped).toBe(0);
    expect(latest.observations.map(({ harness, authMethod }) => [harness, authMethod])).toEqual([
      ['claude-code', 'api-key'],
      ['codex', null],
    ]);
    // Re-opening is idempotent and the store generation never moved.
    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toEqual(generationBefore);
  });

  test('adds the account_fingerprint column (ADR 0057) under the same user_version; older rows read as none', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-executor-fingerprint-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const generationBefore = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));
    const observed = {
      authEvidence: 'claude auth status exit 0 loggedIn=true authMethod=claude.ai',
      authMethod: 'claude.ai',
      authState: 'logged-in',
      binaryPath: '/usr/bin/claude',
      harness: 'claude-code',
      machineId: 'machine-a',
      observedAt: '2026-10-22T08:00:00.000Z',
      outcome: 'observed',
      version: '2.1.306 (Claude Code)',
    } as const;

    // The table as lot R created it (with auth_method, without account_fingerprint), with one row.
    const before = new Database(dbPath, { create: false, readwrite: true });
    before.exec(`
      DROP TABLE executor_observations;
      CREATE TABLE executor_observations (
        id INTEGER PRIMARY KEY,
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL CHECK (harness IN ('claude-code', 'codex')),
        observed_at TEXT NOT NULL,
        binary_path TEXT,
        version TEXT,
        auth_state TEXT NOT NULL CHECK (auth_state IN ('logged-in', 'logged-out', 'unknown')),
        auth_evidence TEXT NOT NULL,
        auth_method TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('observed', 'unavailable', 'timeout', 'invalid'))
      );
      INSERT INTO executor_observations (machine_id, harness, observed_at, binary_path, version, auth_state, auth_evidence, auth_method, outcome)
      VALUES ('machine-a', 'claude-code', '2026-10-22T07:00:00.000Z', '/usr/bin/claude', '2.1.306 (Claude Code)', 'logged-in', 'claude auth status exit 0 loggedIn=true', 'claude.ai', 'observed');
    `);
    before.close(true);

    // A query-only reader that meets the older table reads "no fingerprint" instead of failing.
    const unmigrated = await Effect.runPromise(queryLatestExecutorObservations({ dbPath }));
    expect(unmigrated.observations).toHaveLength(1);
    expect(unmigrated.observations[0] && 'accountFingerprint' in unmigrated.observations[0]).toBe(false);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    const migrated = new Database(dbPath, { create: false, readonly: true });
    expect(readUserVersion(migrated)).toBe(USAGE_STORE_SCHEMA_VERSION);
    const columns = migrated.query('PRAGMA table_info(executor_observations)').all() as { name: string }[];
    expect(columns.map(({ name }) => name)).toContain('account_fingerprint');
    migrated.close(true);

    expect(
      await Effect.runPromise(
        importExecutorObservations({
          dbPath,
          observations: [
            { ...observed, accountFingerprint: '0123456789abcdef' },
            { ...observed, accountFingerprint: 'NOT-A-FINGERPRINT', machineId: 'machine-b' },
          ],
        }),
      ),
    ).toEqual({ inserted: 1, pruned: 0, rejected: 1 });
    const latest = await Effect.runPromise(queryLatestExecutorObservations({ dbPath }));
    expect(latest.skipped).toBe(0);
    expect(latest.observations).toEqual([{ ...observed, accountFingerprint: '0123456789abcdef' }]);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toEqual(generationBefore);
  });

  test('adds the Claude Desktop session family to a populated store already on the current version', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-claude-desktop-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const machine = { id: 'desktop-legacy-machine', label: 'Desktop legacy machine' };
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine,
        rows: [
          {
            ...normalizeUsageRow({
              calls: 1,
              cost: actualCost(null),
              date: new Date('2026-10-01T08:00:00.000Z'),
              durationMs: 1000,
              endDate: new Date('2026-10-01T08:01:00.000Z'),
              harness: 'Claude Code',
              model: 'claude-sonnet-4-6',
              name: 'Desktop legacy session',
              project: 'ai-usage',
              provider: 'Claude sub',
              tokens: { cr: 0, cw: 0, in: 10, out: 20 },
            }),
            source: {
              harnessKey: 'claude',
              sourcePath: '/home/alex/Projects/ai-usage',
              sourceSessionId: 'desktop-legacy-session',
            },
          },
        ],
      }),
    );

    // A store written before this family existed carries the current user_version (4), so
    // absence of the tables is the only available signal, exactly as for skill observations.
    const beforeMigration = new Database(dbPath, { create: false, readwrite: true });
    const countsBefore = readCounts(beforeMigration);
    const metadataBefore = readMetadata(beforeMigration);
    beforeMigration.exec('DROP TABLE claude_desktop_sessions;');
    beforeMigration.exec('DROP TABLE claude_desktop_collection_state;');
    beforeMigration.exec('DROP TABLE claude_desktop_turn_declarations;');
    expect(readUserVersion(beforeMigration)).toBe(USAGE_STORE_SCHEMA_VERSION);
    beforeMigration.close(true);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);

    const migrated = new Database(dbPath, { create: false, readonly: true });
    expect(readUserVersion(migrated)).toBe(USAGE_STORE_SCHEMA_VERSION);
    expect(readCounts(migrated)).toEqual(countsBefore);
    // Adding the family moves no durable data and advances no generation.
    expect(readMetadata(migrated)).toEqual(metadataBefore);
    const indexes = migrated
      .query(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'claude_desktop_sessions' ORDER BY name",
      )
      .all() as { name: string }[];
    migrated.close(true);
    expect(indexes.map(({ name }) => name)).toEqual([
      'idx_claude_desktop_sessions_activity',
      'idx_claude_desktop_sessions_cli',
      'idx_claude_desktop_sessions_identity',
    ]);

    const imported = await Effect.runPromise(
      importClaudeDesktopSessions({
        completeness: { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 },
        dbPath,
        machineId: machine.id,
        observations: [
          {
            accountDirectory: 'account',
            archived: false,
            branch: null,
            cliSessionId: 'desktop-legacy-session',
            completedTurns: null,
            createdAt: '2026-10-01T08:00:00.000Z',
            cwd: '/home/alex/Projects/ai-usage',
            declaredPullRequests: [],
            desktopSessionId: 'local_legacy',
            effort: null,
            fileModifiedAt: '2026-10-01T08:01:00.000Z',
            filePath: '.config/Claude/claude-code-sessions/account/org/local_legacy.json',
            format: 'claude-desktop-session-v1',
            lastActivityAt: '2026-10-01T08:01:00.000Z',
            lastTurnReport: null,
            machineId: machine.id,
            model: null,
            observedAt: '2026-10-01T08:02:00.000Z',
            openSuggestions: [],
            organizationDirectory: 'org',
            originCwd: null,
            priorCliSessionIds: [],
            resolvedSuggestions: {},
            sideSessionNotes: [],
            sourceBranch: null,
            spawnedFrom: null,
            title: 'Fixture: legacy',
            titleSource: 'auto',
            turnSummary: null,
            unsupportedReason: null,
            worktreePath: null,
            wrapUpDescription: null,
            writtenBranches: [],
          },
        ],
      }),
    );
    expect(imported).toEqual({ inserted: 1, skipped: 0, unchanged: 0, updated: 0 });
    const read = await Effect.runPromise(queryClaudeDesktopSessions({ dbPath, machineId: machine.id }));
    expect(read.skipped).toBe(0);
    expect(read.observations.map(({ desktopSessionId }) => desktopSessionId)).toEqual(['local_legacy']);
  });

  test('adds the declaration history and the message time to a Desktop family written before them, without bumping user_version', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-desktop-history-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const generationBefore = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));
    await Effect.runPromise(
      importClaudeDesktopSessions({
        completeness: { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 },
        dbPath,
        machineId: 'machine-a',
        observations: [
          {
            accountDirectory: 'account',
            archived: false,
            cliSessionId: 'cli-before-history',
            createdAt: '2026-10-01T08:00:00.000Z',
            cwd: '/home/fixture/work/project',
            desktopSessionId: 'local_before_history',
            fileModifiedAt: '2026-10-01T09:00:00.000Z',
            filePath: '.config/Claude/claude-code-sessions/account/org/local_before_history.json',
            format: 'claude-desktop-session-v1',
            lastActivityAt: '2026-10-01T09:00:00.000Z',
            machineId: 'machine-a',
            observedAt: '2026-10-01T09:01:00.000Z',
            organizationDirectory: 'org',
            title: 'Before the history',
            titleSource: 'auto',
            turnSummary: {
              detail: 'Stopped.',
              needsAction: 'Which?',
              status: 'blocked',
              summarizesUuid: 'uuid-before',
            },
          },
        ],
      }),
    );

    // The family as ADR 0050 created it: no history table, no message-time column.
    const before = new Database(dbPath, { create: false, readwrite: true });
    before.exec('DROP TABLE claude_desktop_turn_declarations;');
    before.exec('ALTER TABLE claude_desktop_sessions DROP COLUMN latest_user_frame_at;');
    const countsBefore = before.query('SELECT COUNT(*) AS count FROM claude_desktop_sessions').get() as {
      count: number;
    };
    before.close(true);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    const migrated = new Database(dbPath, { create: false, readonly: true });
    expect(readUserVersion(migrated)).toBe(USAGE_STORE_SCHEMA_VERSION);
    const columns = migrated.query('PRAGMA table_info(claude_desktop_sessions)').all() as { name: string }[];
    expect(columns.map(({ name }) => name)).toContain('latest_user_frame_at');
    const history = migrated
      .query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'claude_desktop_turn_declarations'")
      .get();
    expect(history).not.toBeNull();
    expect(migrated.query('SELECT COUNT(*) AS count FROM claude_desktop_sessions').get()).toEqual(countsBefore);
    migrated.close(true);
    // The older row reads as "no message recorded"; the migration advances no generation.
    const read = await Effect.runPromise(queryClaudeDesktopSessions({ dbPath }));
    expect(read.observations.map((observation) => observation.latestUserFrameAt)).toEqual([null]);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toEqual(generationBefore);
  });

  test('migrates a populated schema-3 store to schema 4 by adding the replication outbox and refuses a newer schema', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-schema-3-to-4-migration-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    const machine = { id: 'schema-three-machine', label: 'Schema three machine' };
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine,
        rows: [
          {
            ...normalizeUsageRow({
              calls: 1,
              cost: actualCost(null),
              date: new Date('2026-08-20T08:00:00.000Z'),
              durationMs: 1000,
              endDate: new Date('2026-08-20T08:01:00.000Z'),
              harness: 'Claude Code',
              model: 'claude-sonnet-4-6',
              name: 'Schema three session',
              project: 'ai-usage',
              provider: 'Claude sub',
              tokens: { cr: 0, cw: 0, in: 10, out: 20 },
            }),
            source: {
              harnessKey: 'claude',
              sourcePath: '/home/alex/Projects/ai-usage',
              sourceSessionId: 'schema-three-session',
            },
          },
        ],
      }),
    );
    await Effect.runPromise(
      importSkillObservations({
        collection: {
          completeness: completeSkillObservationCollection(),
          harnessKey: 'claude',
        },
        dbPath,
        machineId: machine.id,
        observations: [
          {
            argsPresent: null,
            harnessKey: 'claude',
            observationKey: 'call_schema_three',
            observedAt: '2026-08-20T09:00:00.000Z',
            projectPath: null,
            resolvedPath: null,
            sessionId: 'schema-three-session',
            skillName: 'write-a-skill',
            success: true,
            tier: 'declared',
          },
        ],
      }),
    );
    const observation: ProviderQuotaObservation = {
      accountScope: null,
      machineId: machine.id,
      machineLabel: machine.label,
      observedAt: '2026-08-20T09:30:00.000Z',
      plan: 'plus',
      providerGeneratedAt: null,
      providerKey: 'codex',
      providerLabel: 'Codex',
      source: { confidence: 'authoritative', key: 'poll', mode: 'poll' },
      state: 'ok',
      windows: [],
    };
    await Effect.runPromise(
      importProviderQuotaBatch({
        checkpointUpdates: [],
        dbPath,
        items: [{ observation, sourceEventKey: 'event-schema-three' }],
      }),
    );

    // Shape the store exactly as schema 3 wrote it: the same tables minus the
    // replication outbox family, which is the only difference between the
    // schema-3 and schema-4 `migrate()` bodies.
    const legacy = new Database(dbPath, { create: false, readwrite: true });
    legacy.exec(`
      INSERT INTO served_report_revisions (
        revision, capture_fingerprint, private_capture_fingerprint, config_fingerprint,
        usage_store_generation, machine_fleet_generation, projection_schema_version,
        generated_at, published_at, expires_at, complete, row_count, segment_count,
        filter_key_count, rows_bytes, support_bytes, projection_bytes
      ) VALUES (
        'schema-three-revision', '${'a'.repeat(64)}', '${'b'.repeat(64)}', '${'c'.repeat(64)}',
        1, 1, ${SERVED_REPORT_PROJECTION_SCHEMA_VERSION}, '2026-08-20T10:00:00.000Z', 1000, 2000, 1, 0, 0, 0, 0, 0, 0
      );
      INSERT INTO served_report_current (singleton, revision, required_complete)
      VALUES (1, 'schema-three-revision', 1);
      DROP TABLE replication_outbox_events;
      DROP TABLE replication_outbox_state;
      PRAGMA user_version = 3;
    `);
    const metadataBefore = readMetadata(legacy);
    const countsBefore = readCounts(legacy);
    expect(readUserVersion(legacy)).toBe(3);
    expect(readSchema(legacy).some(({ name }) => name.includes('replication_outbox'))).toBe(false);
    legacy.close(true);
    const generationBefore = metadataBefore.find(({ key }) => key === 'generation')?.value;
    if (generationBefore === undefined) {
      throw new Error('The schema-3 fixture lost its generation counter.');
    }
    expect(generationBefore).toBeGreaterThan(0);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);

    const migrated = new Database(dbPath, { create: false, readonly: true });
    expect(readUserVersion(migrated)).toBe(USAGE_STORE_SCHEMA_VERSION);
    expect(
      readSchema(migrated)
        .filter(({ name }) => name.includes('replication_outbox'))
        .map(({ name }) => name),
    ).toEqual([
      'idx_replication_outbox_fact_history',
      'idx_replication_outbox_ready',
      'replication_outbox_events',
      'replication_outbox_state',
    ]);
    expect(readMetadata(migrated)).toEqual(metadataBefore);
    expect(readCounts(migrated)).toEqual(countsBefore);
    // The schema step creates the outbox tables only; binding a Device identity
    // is a separate, explicit replication setup.
    expect(migrated.query('SELECT COUNT(*) AS count FROM replication_outbox_state').get()).toEqual({ count: 0 });
    expect(migrated.query('SELECT COUNT(*) AS count FROM replication_outbox_events').get()).toEqual({ count: 0 });
    expect(migrated.query('SELECT revision FROM served_report_current WHERE singleton = 1').get()).toEqual({
      revision: 'schema-three-revision',
    });
    const schemaAfterMigration = readSchema(migrated);
    migrated.close(true);

    expect(await Effect.runPromise(initializeUsageStore({ dbPath }))).toBe(USAGE_STORE_SCHEMA_VERSION);
    const reopened = new Database(dbPath, { create: false, readonly: true });
    expect(readUserVersion(reopened)).toBe(USAGE_STORE_SCHEMA_VERSION);
    expect(readSchema(reopened)).toEqual(schemaAfterMigration);
    expect(readMetadata(reopened)).toEqual(metadataBefore);
    reopened.close(true);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(generationBefore);

    const newer = new Database(dbPath, { create: false, readwrite: true });
    newer.exec(`PRAGMA user_version = ${USAGE_STORE_SCHEMA_VERSION + 1}`);
    newer.close(true);
    const writerRefusal = await Effect.runPromise(Effect.flip(initializeUsageStore({ dbPath })));
    expect(writerRefusal).toMatchObject({
      _tag: 'UsageStoreError',
      operation: 'openUsageStoreWriter',
      reason: 'storage-failure',
    });
    expect(writerRefusal.message).toContain('newer than supported');
    const readerRefusal = await Effect.runPromise(Effect.flip(queryUsageStoreGeneration({ dbPath })));
    expect(readerRefusal).toMatchObject({ _tag: 'UsageStoreError', reason: 'schema-too-new' });
    const untouched = new Database(dbPath, { create: false, readonly: true });
    expect(readUserVersion(untouched)).toBe(USAGE_STORE_SCHEMA_VERSION + 1);
    expect(readSchema(untouched)).toEqual(schemaAfterMigration);
    expect(readMetadata(untouched)).toEqual(metadataBefore);
    expect(readCounts(untouched)).toEqual(countsBefore);
    untouched.close(true);
  });
});
