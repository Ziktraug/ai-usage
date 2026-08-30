import { describe, expect, test } from 'bun:test';
import { parsePlatformServerConfig, revealDatabaseUrl } from './config';

const authenticationSecret = Buffer.alloc(32, 13).toString('base64url');
const deviceTokenKey = Buffer.alloc(32, 17).toString('base64url');
const requiredEnvironment = {
  AI_USAGE_AUTH_SECRETS: `1:${authenticationSecret}`,
  AI_USAGE_DEVICE_TOKEN_KEYS: `1:${deviceTokenKey}`,
  AI_USAGE_GITHUB_CLIENT_ID: 'github-client-id',
  AI_USAGE_GITHUB_CLIENT_SECRET: 'github-client-secret-with-enough-entropy',
  AI_USAGE_PLATFORM_BASE_URL: 'https://platform.example.invalid',
} as const;

describe('platform server configuration', () => {
  test('parses a connected development configuration with redacted secret representation', () => {
    const rawDatabaseUrl = 'postgresql://operator:private-value@database.internal/platform';
    const config = parsePlatformServerConfig({
      ...requiredEnvironment,
      AI_USAGE_PLATFORM_DATABASE_URL: rawDatabaseUrl,
      AI_USAGE_PLATFORM_POOL_SIZE: '7',
      AI_USAGE_PLATFORM_PORT: '4510',
      NODE_ENV: 'development',
    });

    expect(config).toMatchObject({
      connectTimeoutMs: 5000,
      migrationMode: 'apply',
      poolSize: 7,
      port: 4510,
      queryTimeoutMs: 5000,
      runtimeEnvironment: 'development',
      shutdownTimeoutMs: 10_000,
      tlsMode: 'disable',
    });
    expect(String(config.databaseUrl)).toBe('[REDACTED]');
    expect(JSON.stringify(config)).not.toContain('private-value');
    expect(JSON.stringify(config)).not.toContain('database.internal');
    expect(JSON.stringify(config)).not.toContain(authenticationSecret);
    expect(JSON.stringify(config)).not.toContain(deviceTokenKey);
    expect(JSON.stringify(config)).not.toContain('github-client-secret');
    expect(revealDatabaseUrl(config.databaseUrl)).toBe(rawDatabaseUrl);
  });

  test('defaults production to verify mode and required TLS', () => {
    const config = parsePlatformServerConfig({
      ...requiredEnvironment,
      AI_USAGE_PLATFORM_DATABASE_URL: 'postgresql://operator@example.invalid/platform',
      NODE_ENV: 'production',
    });

    expect(config.migrationMode).toBe('verify');
    expect(config.tlsMode).toBe('require');
  });

  test('rejects missing, malformed, and production non-TLS configuration without echoing values', () => {
    const invalidEnvironments = [
      { ...requiredEnvironment, NODE_ENV: 'development' },
      {
        ...requiredEnvironment,
        AI_USAGE_PLATFORM_DATABASE_URL: 'private-malformed-value',
        NODE_ENV: 'development',
      },
      {
        ...requiredEnvironment,
        AI_USAGE_PLATFORM_DATABASE_TLS: 'disable',
        AI_USAGE_PLATFORM_DATABASE_URL: 'postgresql://operator:private-password@example.invalid/platform',
        NODE_ENV: 'production',
      },
    ] as const;

    for (const environment of invalidEnvironments) {
      let failure: unknown;
      try {
        parsePlatformServerConfig(environment);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: 'The platform server configuration is invalid.' });
      expect(String(failure)).not.toContain('private');
      expect(JSON.stringify(failure)).not.toContain('example.invalid');
    }
  });

  test('permits ephemeral port zero only in tests', () => {
    expect(
      parsePlatformServerConfig({
        ...requiredEnvironment,
        AI_USAGE_PLATFORM_DATABASE_URL: 'postgresql://postgres@localhost/postgres',
        AI_USAGE_PLATFORM_PORT: '0',
        NODE_ENV: 'test',
      }).port,
    ).toBe(0);
    expect(() =>
      parsePlatformServerConfig({
        ...requiredEnvironment,
        AI_USAGE_PLATFORM_DATABASE_URL: 'postgresql://postgres@localhost/postgres',
        AI_USAGE_PLATFORM_PORT: '0',
        NODE_ENV: 'development',
      }),
    ).toThrow();
  });

  test('rejects missing shared-authentication secrets and non-HTTPS production origins', () => {
    expect(() =>
      parsePlatformServerConfig({
        ...requiredEnvironment,
        AI_USAGE_AUTH_SECRETS: undefined,
        AI_USAGE_PLATFORM_DATABASE_URL: 'postgresql://postgres@localhost/postgres',
        NODE_ENV: 'test',
      }),
    ).toThrow();
    expect(() =>
      parsePlatformServerConfig({
        ...requiredEnvironment,
        AI_USAGE_PLATFORM_BASE_URL: 'http://platform.example.invalid',
        AI_USAGE_PLATFORM_DATABASE_URL: 'postgresql://postgres@localhost/postgres',
        NODE_ENV: 'production',
      }),
    ).toThrow();
  });
});
