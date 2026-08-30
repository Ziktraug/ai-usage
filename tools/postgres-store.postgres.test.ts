import { describe, expect, test } from 'bun:test';
import { PLATFORM_MIGRATIONS, type PlatformMigrationTrace } from '@ai-usage/postgres-store/migrations';
import { createPlatformTestingDatabase, type PlatformTestingDatabase } from '@ai-usage/postgres-store/testing';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const foundationMigrations = PLATFORM_MIGRATIONS.slice(0, 1);

const ledgerSql = `
  CREATE TABLE platform_migrations (
    id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

interface DatabaseFixture {
  readonly database: PlatformTestingDatabase;
  readonly stop: () => Promise<void>;
}

const startDatabase = async (label: string): Promise<DatabaseFixture> => {
  const cluster = await startPostgresCluster(label);
  const database = createPlatformTestingDatabase(cluster.url);
  return {
    database,
    stop: async (): Promise<void> => {
      await database.close().catch(() => undefined);
      await cluster.stop();
    },
  };
};

if (runPostgresTests) {
  describe('PostgreSQL platform migrations', () => {
    test('migrates an empty database in explicit ordinal order and keeps production schema minimal', async () => {
      const { database, stop } = await startDatabase('migrations-empty');
      try {
        const trace: PlatformMigrationTrace[] = [];
        expect(await database.listPublicTables()).toEqual([]);

        const result = await database.runMigrations({
          migrations: foundationMigrations,
          mode: 'apply',
          onTrace: (event) => trace.push(event),
        });

        expect(result).toEqual({
          appliedIds: ['0001_platform_schema_metadata'],
          currentOrdinal: 1,
        });
        expect(trace).toEqual([
          { type: 'lock-acquired' },
          { id: '0001_platform_schema_metadata', ordinal: 1, type: 'migration-applied' },
          { type: 'lock-released' },
        ]);
        expect(await database.listPublicTables()).toEqual(['platform_migrations', 'platform_schema_metadata']);
      } finally {
        await stop();
      }
    }, 30_000);

    test('is idempotent after the compiled sequence is applied', async () => {
      const { database, stop } = await startDatabase('migrations-idempotent');
      try {
        await database.runMigrations({ migrations: foundationMigrations, mode: 'apply' });
        expect(await database.runMigrations({ migrations: foundationMigrations, mode: 'apply' })).toEqual({
          appliedIds: [],
          currentOrdinal: 1,
        });
      } finally {
        await stop();
      }
    }, 30_000);

    test('continues from a prior empty ledger fixture', async () => {
      const { database, stop } = await startDatabase('migrations-prior');
      try {
        await database.query(ledgerSql);
        expect(await database.runMigrations({ migrations: foundationMigrations, mode: 'apply' })).toEqual({
          appliedIds: ['0001_platform_schema_metadata'],
          currentOrdinal: 1,
        });
      } finally {
        await stop();
      }
    }, 30_000);

    test('refuses an unknown future migration', async () => {
      const { database, stop } = await startDatabase('migrations-future');
      try {
        await database.runMigrations({ mode: 'apply' });
        await database.query('INSERT INTO platform_migrations (id, ordinal) VALUES ($1, $2)', [
          '9999_unknown_future',
          9999,
        ]);

        await expect(database.runMigrations({ mode: 'apply' })).rejects.toMatchObject({
          code: 'migration-incompatible',
          operation: 'verify-migration-ledger',
        });
      } finally {
        await stop();
      }
    }, 30_000);

    test('refuses a known migration recorded under the wrong ordinal', async () => {
      const { database, stop } = await startDatabase('migrations-ordinal-mismatch');
      try {
        await database.query(ledgerSql);
        await database.query('INSERT INTO platform_migrations (id, ordinal) VALUES ($1, $2)', [
          PLATFORM_MIGRATIONS[0]?.id,
          7,
        ]);

        await expect(database.runMigrations({ mode: 'apply' })).rejects.toMatchObject({
          code: 'migration-incompatible',
          operation: 'verify-migration-ledger',
        });
      } finally {
        await stop();
      }
    }, 30_000);

    test('serializes two concurrent runners under one advisory lock', async () => {
      const { database, stop } = await startDatabase('migrations-concurrent');
      try {
        const trace: PlatformMigrationTrace[] = [];
        const results = await Promise.all([
          database.runMigrations({
            migrations: foundationMigrations,
            mode: 'apply',
            onTrace: (event) => trace.push(event),
          }),
          database.runMigrations({
            migrations: foundationMigrations,
            mode: 'apply',
            onTrace: (event) => trace.push(event),
          }),
        ]);

        expect(results.flatMap(({ appliedIds }) => appliedIds)).toEqual(['0001_platform_schema_metadata']);
        expect(trace.filter(({ type }) => type === 'lock-acquired')).toHaveLength(2);
        expect(trace.filter(({ type }) => type === 'migration-applied')).toEqual([
          { id: '0001_platform_schema_metadata', ordinal: 1, type: 'migration-applied' },
        ]);
        expect(trace.filter(({ type }) => type === 'lock-released')).toHaveLength(2);
      } finally {
        await stop();
      }
    }, 30_000);

    test('verify mode refuses a pending migration without applying it', async () => {
      const { database, stop } = await startDatabase('migrations-verify');
      try {
        await expect(database.runMigrations({ mode: 'verify' })).rejects.toMatchObject({
          code: 'migration-required',
          operation: 'verify-migrations',
        });
        expect(await database.listPublicTables()).toEqual(['platform_migrations']);
      } finally {
        await stop();
      }
    }, 30_000);

    test('rejects an invalid test-only storage value at the validated reader boundary', async () => {
      const { database, stop } = await startDatabase('contract-fixture-invalid');
      try {
        await database.createContractFixture();
        await database.insertContractFixture({ id: 'invalid-state', state: 'unknown' });

        await expect(database.readContractFixture('invalid-state')).rejects.toMatchObject({
          code: 'validation-failed',
          operation: 'map-contract-fixture',
        });
      } finally {
        await stop();
      }
    }, 30_000);
  });
} else {
  // biome-ignore lint/suspicious/noSkippedTests: PostgreSQL integration requires the repository-owned PostgreSQL 17 binaries.
  describe.skip('PostgreSQL platform migrations', () => {
    test('requires AI_USAGE_RUN_POSTGRES_TESTS=1', () => undefined);
  });
}
