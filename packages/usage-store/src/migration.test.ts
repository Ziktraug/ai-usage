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
  queryLatestProviderQuotaObservations,
  queryProviderQuotaObservations,
  querySkillObservations,
  queryUsageLocalMachine,
  USAGE_STORE_SCHEMA_VERSION,
} from './reader';
import {
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

    const outcome = await Effect.runPromise(Effect.either(initializeUsageStore({ dbPath })));
    expect(outcome._tag).toBe('Left');

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

    const failed = await Effect.runPromise(Effect.either(initializeUsageStore({ dbPath })));
    expect(failed._tag).toBe('Left');

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

    const failed = await Effect.runPromise(Effect.either(initializeUsageStore({ dbPath })));
    expect(failed._tag).toBe('Left');
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
});
