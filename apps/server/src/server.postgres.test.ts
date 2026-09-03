import { describe, expect, test } from 'bun:test';
import { createPlatformStore, type PlatformStore } from '@ai-usage/postgres-store/writer';
import { startPostgresCluster } from '../../../tools/pg-harness';
import { createPlatformApplicationHandler } from './application';
import { parsePlatformServerConfig } from './config';
import { type StartPlatformHttpServerInput, startPlatformServer } from './server';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const authenticationEnvironment = {
  AI_USAGE_AUTH_SECRETS: `1:${Buffer.alloc(32, 3).toString('base64url')}`,
  AI_USAGE_DEVICE_TOKEN_KEYS: `1:${Buffer.alloc(32, 4).toString('base64url')}`,
  AI_USAGE_GITHUB_CLIENT_ID: 'github-client-id',
  AI_USAGE_GITHUB_CLIENT_SECRET: 'github-client-secret-with-enough-entropy',
  AI_USAGE_PLATFORM_BASE_URL: 'https://platform.example.invalid',
} as const;

const startHttpServer = (input: StartPlatformHttpServerInput) => {
  const listener = Bun.serve({ fetch: input.fetch, hostname: input.host, port: input.port });
  return {
    port: listener.port ?? input.port,
    stop: (force?: boolean) => listener.stop(force),
  };
};

if (runPostgresTests) {
  describe('platform server with PostgreSQL', () => {
    test('reports live and ready, then detects a stopped pool without disclosing internals', async () => {
      const cluster = await startPostgresCluster('server-health');
      let store: PlatformStore | undefined;
      let server: Awaited<ReturnType<typeof startPlatformServer>> | undefined;
      try {
        const config = parsePlatformServerConfig({
          ...authenticationEnvironment,
          AI_USAGE_PLATFORM_DATABASE_URL: cluster.url,
          AI_USAGE_PLATFORM_PORT: '0',
          NODE_ENV: 'test',
        });
        server = await startPlatformServer(config, {
          createApplicationHandler: createPlatformApplicationHandler,
          createStore: async (storeConfig) => {
            store = await createPlatformStore(storeConfig);
            return store;
          },
          startHttpServer,
        });
        const origin = `http://127.0.0.1:${server.port}`;

        const live = await fetch(`${origin}/health/live`);
        const ready = await fetch(`${origin}/health/ready`);
        expect(live.status).toBe(200);
        expect(await live.json()).toEqual({ status: 'live' });
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({ status: 'ready' });

        if (!store) {
          throw new Error('Platform store was not captured.');
        }
        await store.close();
        const stopped = await fetch(`${origin}/health/ready`);
        expect(stopped.status).toBe(503);
        expect(await stopped.text()).toBe('{"status":"not-ready"}');
      } finally {
        await server?.close().catch(() => undefined);
        await store?.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('refuses a missing migration in verify mode with a secret-free startup failure', async () => {
      const cluster = await startPostgresCluster('server-missing-migration');
      try {
        const secretUrl = new URL(cluster.url);
        secretUrl.password = 'foundation-secret';
        const config = parsePlatformServerConfig({
          ...authenticationEnvironment,
          AI_USAGE_PLATFORM_DATABASE_URL: secretUrl.toString(),
          AI_USAGE_PLATFORM_MIGRATION_MODE: 'verify',
          AI_USAGE_PLATFORM_PORT: '0',
          NODE_ENV: 'test',
        });

        let failure: unknown;
        try {
          await startPlatformServer(config, {
            createApplicationHandler: createPlatformApplicationHandler,
            createStore: createPlatformStore,
            startHttpServer,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ code: 'startup-failed', message: 'The platform server operation failed.' });
        expect(String(failure)).not.toContain('foundation-secret');
        expect(JSON.stringify(failure)).not.toContain('localhost');
      } finally {
        await cluster.stop();
      }
    }, 30_000);
  });
}
