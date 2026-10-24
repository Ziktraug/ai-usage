import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { PLATFORM_MIGRATIONS } from '@ai-usage/postgres-store/migrations';
import { createPlatformTestingDatabase, type PlatformTestingDatabase } from '@ai-usage/postgres-store/testing';
import { startPostgresCluster } from '../../../tools/pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const mainModulePath = path.join(import.meta.dir, 'main.ts');
const processExitTimeoutMs = 20_000;
// Ordinals 1 to 10: the schema that keyed provider accounts by issuer.
const issuerSchemaMigrations = PLATFORM_MIGRATIONS.slice(0, 10);

const insertProviderAccount = async (database: PlatformTestingDatabase, subject: string): Promise<void> => {
  const principalId = crypto.randomUUID();
  await database.query(
    `INSERT INTO authentication_principals (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, TRUE, now(), now())`,
    [principalId, subject, `${principalId}@github.auth.ai-usage.invalid`],
  );
  await database.query(
    `INSERT INTO authentication_provider_accounts (issuer, account_id, provider_id, user_id, created_at, updated_at)
     VALUES ('local:oauth:github', $1, 'github', $2, now(), now())`,
    [subject, principalId],
  );
};

if (runPostgresTests) {
  describe('platform server process with PostgreSQL', () => {
    test('emits the SQLSTATE of a refused migration in its start-failure line', async () => {
      const cluster = await startPostgresCluster('server-process-migration-refusal');
      try {
        const database = createPlatformTestingDatabase(cluster.url);
        try {
          await database.runMigrations({ migrations: issuerSchemaMigrations, mode: 'apply' });
          // Two rows under one provider key: ordinal 11 refuses with IA003.
          await database.query(
            'ALTER TABLE authentication_provider_accounts DROP CONSTRAINT authentication_provider_accounts_issuer_account_id_key',
          );
          await insertProviderAccount(database, 'shared-subject');
          await insertProviderAccount(database, 'shared-subject');
        } finally {
          await database.close();
        }

        const databasePassword = 'database-password-must-not-leak';
        const databaseUrl = new URL(cluster.url);
        databaseUrl.password = databasePassword;
        // An explicit environment: nothing local is inherited by the child.
        const child = Bun.spawn({
          cmd: [process.execPath, '--no-env-file', mainModulePath],
          env: {
            AI_USAGE_AUTH_SECRETS: `1:${Buffer.alloc(32, 7).toString('base64url')}`,
            AI_USAGE_DEVICE_TOKEN_KEYS: `1:${Buffer.alloc(32, 8).toString('base64url')}`,
            AI_USAGE_GITHUB_CLIENT_ID: 'github-client-id',
            AI_USAGE_GITHUB_CLIENT_SECRET: 'github-client-secret-with-enough-entropy',
            AI_USAGE_PLATFORM_BASE_URL: 'https://platform.example.invalid',
            AI_USAGE_PLATFORM_DATABASE_URL: databaseUrl.toString(),
            AI_USAGE_PLATFORM_MIGRATION_MODE: 'apply',
            AI_USAGE_PLATFORM_PORT: '0',
            NODE_ENV: 'test',
          },
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
          timeout: processExitTimeoutMs,
        });
        const [exitCode, stderr, stdout] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          new Response(child.stdout).text(),
        ]);

        expect(exitCode).toBe(1);
        expect(stdout).toBe('');
        const lines = stderr.trimEnd().split('\n');
        expect(lines.at(-1)).toBe(
          JSON.stringify({
            component: 'platform-server',
            code: 'process-start-failed',
            operation: 'startup',
            store: { code: 'migration-failed', operation: 'apply-migration', sqlState: 'IA003' },
          }),
        );
        expect(stderr).not.toContain(databasePassword);
        expect(stderr).not.toContain(path.basename(cluster.socketDir));
        expect(stderr).not.toContain('authentication_provider_accounts');
      } finally {
        await cluster.stop();
      }
    }, 60_000);
  });
}
