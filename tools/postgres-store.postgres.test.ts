import { describe, expect, test } from 'bun:test';
import { PLATFORM_MIGRATIONS, type PlatformMigrationTrace } from '@ai-usage/postgres-store/migrations';
import { createPlatformTestingDatabase, type PlatformTestingDatabase } from '@ai-usage/postgres-store/testing';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const foundationMigrations = PLATFORM_MIGRATIONS.slice(0, 1);
// Ordinals 1 to 10: the schema that required an issuer on every provider account.
const issuerSchemaMigrations = PLATFORM_MIGRATIONS.slice(0, 10);
const providerKeyConstraintSql = `
  SELECT 1 FROM pg_constraint
  WHERE conname = 'authentication_provider_accounts_provider_id_account_id_key'
    AND conrelid = 'authentication_provider_accounts'::regclass AND contype = 'u'
`;
const issuerKeyConstraintSql = `
  SELECT 1 FROM pg_constraint
  WHERE conname = 'authentication_provider_accounts_issuer_account_id_key'
    AND conrelid = 'authentication_provider_accounts'::regclass
`;
const issuerColumnSql = `
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'authentication_provider_accounts' AND column_name = 'issuer' AND is_nullable = $1
`;

const insertPrincipalWithAccount = async (
  database: PlatformTestingDatabase,
  principalId: string,
  subject: string,
  issuer: string | null,
): Promise<void> => {
  await database.query(
    `INSERT INTO authentication_principals (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, TRUE, now(), now())`,
    [principalId, subject, `${principalId}@github.auth.ai-usage.invalid`],
  );
  await database.query(
    `INSERT INTO authentication_provider_accounts (issuer, account_id, provider_id, user_id, created_at, updated_at)
     VALUES ($1, $2, 'github', $3, now(), now())`,
    [issuer, subject, principalId],
  );
};

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

    test('applies the compiled ledger to ordinal 11 and verifies it cleanly', async () => {
      const { database, stop } = await startDatabase('migrations-compiled-verify');
      try {
        expect(await database.runMigrations({ mode: 'apply' })).toEqual({
          appliedIds: PLATFORM_MIGRATIONS.map(({ id }) => id),
          currentOrdinal: 11,
        });
        expect(await database.runMigrations({ mode: 'verify' })).toEqual({ appliedIds: [], currentOrdinal: 11 });
        expect(
          await database.queryRowCount(
            "SELECT 1 FROM platform_schema_metadata WHERE key = 'foundation_schema_version' AND value = '11'",
          ),
        ).toBe(1);
        expect(
          await database.queryRowCount(
            `SELECT 1 FROM pg_trigger
             WHERE tgname IN ('authentication_provider_accounts_keep_last', 'authentication_provider_accounts_refuse_revoked')
               AND tgrelid = 'authentication_provider_accounts'::regclass`,
          ),
        ).toBe(2);
        expect(await database.queryRowCount(providerKeyConstraintSql)).toBe(1);
        expect(await database.queryRowCount(issuerKeyConstraintSql)).toBe(0);
        expect(await database.queryRowCount(issuerColumnSql, ['YES'])).toBe(1);
      } finally {
        await stop();
      }
    }, 30_000);

    test('carries provider accounts written under the issuer schema over to the provider key', async () => {
      const { database, stop } = await startDatabase('migrations-provider-key');
      try {
        expect(await database.runMigrations({ migrations: issuerSchemaMigrations, mode: 'apply' })).toMatchObject({
          currentOrdinal: 10,
        });
        expect(await database.queryRowCount(issuerKeyConstraintSql)).toBe(1);
        const first = crypto.randomUUID();
        const second = crypto.randomUUID();
        await insertPrincipalWithAccount(database, first, 'first-subject', 'local:oauth:github');
        await insertPrincipalWithAccount(database, second, 'second-subject', 'local:oauth:github');

        expect(await database.runMigrations({ mode: 'apply' })).toEqual({
          appliedIds: ['0011_provider_key_account_identity'],
          currentOrdinal: 11,
        });

        // Rows of the earlier schema survive with their issuer; new rows leave it NULL.
        expect(
          await database.queryRowCount(
            "SELECT 1 FROM authentication_provider_accounts WHERE issuer = 'local:oauth:github'",
          ),
        ).toBe(2);
        await insertPrincipalWithAccount(database, crypto.randomUUID(), 'third-subject', null);
        expect(
          await database.queryRowCount('SELECT 1 FROM authentication_provider_accounts WHERE issuer IS NULL'),
        ).toBe(1);
        // The provider key is unique, whatever the issuer.
        await expect(
          database.query(
            `INSERT INTO authentication_provider_accounts
               (account_id, provider_id, user_id, created_at, updated_at)
             VALUES ('first-subject', 'github', $1, now(), now())`,
            [second],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        expect(await database.queryRowCount(providerKeyConstraintSql)).toBe(1);
        expect(await database.queryRowCount(issuerKeyConstraintSql)).toBe(0);
        expect(await database.queryRowCount(issuerColumnSql, ['YES'])).toBe(1);
      } finally {
        await stop();
      }
    }, 30_000);

    test('refuses the provider-key migration while a provider key maps to more than one row', async () => {
      const { database, stop } = await startDatabase('migrations-provider-key-duplicates');
      try {
        await database.runMigrations({ migrations: issuerSchemaMigrations, mode: 'apply' });
        await insertPrincipalWithAccount(database, crypto.randomUUID(), 'shared-subject', 'local:oauth:github');
        // The issuer schema could not hold this pair twice; a hand-edited
        // deployment can. The migration must refuse it, not the constraint.
        await database.query(
          'ALTER TABLE authentication_provider_accounts DROP CONSTRAINT authentication_provider_accounts_issuer_account_id_key',
        );
        await insertPrincipalWithAccount(database, crypto.randomUUID(), 'shared-subject', 'local:oauth:github');

        const failure = await database.runMigrations({ mode: 'apply' }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({ code: 'migration-failed', operation: 'apply-migration' });
        expect(failure instanceof Error ? failure.cause : undefined).toMatchObject({ code: 'IA003' });
        expect(await database.queryRowCount('SELECT 1 FROM platform_migrations WHERE ordinal = 11')).toBe(0);
        expect(await database.queryRowCount(providerKeyConstraintSql)).toBe(0);
        expect(await database.queryRowCount(issuerColumnSql, ['NO'])).toBe(1);
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
}
