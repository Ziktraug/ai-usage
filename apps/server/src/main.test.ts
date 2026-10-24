import { describe, expect, test } from 'bun:test';
import { installPlatformStoreFactoryForTesting } from '@ai-usage/postgres-store/testing';
import { PlatformStoreError } from '@ai-usage/postgres-store/writer';
import { DatabaseError } from 'pg';
import { type PlatformProcessDiagnostic, runPlatformServerProcess } from './main';

const databaseUrlSecret = 'database-password-must-not-leak';
const environment = {
  AI_USAGE_AUTH_SECRETS: `1:${Buffer.alloc(32, 5).toString('base64url')}`,
  AI_USAGE_DEVICE_TOKEN_KEYS: `1:${Buffer.alloc(32, 6).toString('base64url')}`,
  AI_USAGE_GITHUB_CLIENT_ID: 'github-client-id',
  AI_USAGE_GITHUB_CLIENT_SECRET: 'github-client-secret-with-enough-entropy',
  AI_USAGE_PLATFORM_BASE_URL: 'https://platform.example.invalid',
  AI_USAGE_PLATFORM_DATABASE_URL: `postgresql://operator:${databaseUrlSecret}@database.example.invalid/platform`,
  AI_USAGE_PLATFORM_PORT: '0',
  AI_USAGE_PLATFORM_SHUTDOWN_TIMEOUT_MS: '100',
  NODE_ENV: 'test',
} as const;

const runProcess = async (
  processEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly diagnostics: readonly PlatformProcessDiagnostic[]; readonly exitCode: unknown }> => {
  const diagnostics: PlatformProcessDiagnostic[] = [];
  const previousExitCode = process.exitCode;
  try {
    await runPlatformServerProcess({
      environment: processEnvironment,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    return { diagnostics, exitCode: process.exitCode };
  } finally {
    // Bun ignores an `undefined` exit code, so the default is restored as 0.
    process.exitCode = previousExitCode ?? 0;
  }
};

const runWithStoreFailure = async (failure: Error) => {
  const restore = installPlatformStoreFactoryForTesting(() => Promise.reject(failure));
  try {
    return await runProcess(environment);
  } finally {
    restore();
  }
};

const startFailures = (diagnostics: readonly PlatformProcessDiagnostic[]) =>
  diagnostics.filter(({ code }) => code === 'process-start-failed');

describe('platform server process start failures', () => {
  test('names the store failure and the SQLSTATE of a refused migration without its text', async () => {
    const refusalText =
      'authentication_provider_accounts holds 1 (provider_id, account_id) key(s) with more than one row';
    const refusal = new DatabaseError(refusalText, refusalText.length, 'error');
    refusal.code = 'IA003';

    const { diagnostics, exitCode } = await runWithStoreFailure(
      new PlatformStoreError('migration-failed', 'apply-migration', { cause: refusal }),
    );

    expect(exitCode).toBe(1);
    expect(startFailures(diagnostics)).toEqual([
      {
        code: 'process-start-failed',
        operation: 'startup',
        store: { code: 'migration-failed', operation: 'apply-migration', sqlState: 'IA003' },
      },
    ]);
    const emitted = JSON.stringify(diagnostics);
    expect(emitted).not.toContain(databaseUrlSecret);
    expect(emitted).not.toContain('database.example.invalid');
    expect(emitted).not.toContain('authentication_provider_accounts');
  });

  test('names a store failure that PostgreSQL did not refuse without a SQLSTATE', async () => {
    const { diagnostics } = await runWithStoreFailure(
      new PlatformStoreError('connection-failed', 'connect-for-migrations', {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${environment.AI_USAGE_PLATFORM_DATABASE_URL}`), {
          code: 'ECONNREFUSED',
        }),
      }),
    );

    expect(startFailures(diagnostics)).toEqual([
      {
        code: 'process-start-failed',
        operation: 'startup',
        store: { code: 'connection-failed', operation: 'connect-for-migrations' },
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(databaseUrlSecret);
  });

  test('reports a failure outside the store with the bare start-failure code', async () => {
    const { diagnostics, exitCode } = await runProcess({ ...environment, AI_USAGE_PLATFORM_DATABASE_URL: undefined });

    expect(exitCode).toBe(1);
    expect(diagnostics).toEqual([{ code: 'process-start-failed', operation: 'startup' }]);
  });
});
