import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { Effect } from 'effect';
import {
  queryLatestProviderQuotaObservations,
  queryProviderQuotaObservations,
  USAGE_STORE_SCHEMA_VERSION,
} from './reader';
import { importProviderQuotaBatch, initializeUsageStore } from './writer';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('usage-store forward migration', () => {
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
      'served_report_revisions',
      'served_report_rows',
      'served_report_support',
      'served_session_model_filter_keys',
      'served_session_model_segments',
    ]);
    expect((migrated.query('SELECT value FROM legacy_marker').get() as { value: string }).value).toBe('preserved');
    migrated.close(true);
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
});
