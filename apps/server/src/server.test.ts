import { describe, expect, test } from 'bun:test';
import type { PlatformStore } from '@ai-usage/postgres-store/writer';
import { parsePlatformServerConfig } from './config';
import { type PlatformHttpServer, type PlatformServerDependencies, startPlatformServer } from './server';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolveOperation: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveOperation = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      if (!resolveOperation) {
        throw new Error('Deferred operation was not initialized.');
      }
      resolveOperation(value);
    },
  };
};

const config = parsePlatformServerConfig({
  AI_USAGE_AUTH_SECRETS: `1:${Buffer.alloc(32, 1).toString('base64url')}`,
  AI_USAGE_DEVICE_TOKEN_KEYS: `1:${Buffer.alloc(32, 2).toString('base64url')}`,
  AI_USAGE_GITHUB_CLIENT_ID: 'github-client-id',
  AI_USAGE_GITHUB_CLIENT_SECRET: 'github-client-secret-with-enough-entropy',
  AI_USAGE_PLATFORM_DATABASE_URL: 'postgresql://operator:server-secret@example.invalid/platform',
  AI_USAGE_PLATFORM_BASE_URL: 'https://platform.example.invalid',
  AI_USAGE_PLATFORM_PORT: '0',
  AI_USAGE_PLATFORM_SHUTDOWN_TIMEOUT_MS: '100',
  NODE_ENV: 'test',
});

const createFakeStore = (events: string[] = []): PlatformStore => {
  let open = true;
  const checkReadiness = (): Promise<{ readonly schemaVersion: number; readonly status: 'ready' }> =>
    open ? Promise.resolve({ schemaVersion: 1, status: 'ready' }) : Promise.reject(new Error('store closed'));
  return {
    authentication: {} as PlatformStore['authentication'],
    authorization: {} as PlatformStore['authorization'],
    checkReadiness,
    close: () => {
      events.push('store-close');
      open = false;
      return Promise.resolve();
    },
    devices: {} as PlatformStore['devices'],
    identity: {} as PlatformStore['identity'],
    memory: {} as PlatformStore['memory'],
    projects: {} as PlatformStore['projects'],
    reader: { checkReadiness },
    replication: {} as PlatformStore['replication'],
  };
};

const createFakeHttpServer = (events: string[]): PlatformHttpServer => ({
  port: 4511,
  stop: (force) => {
    events.push(`http-stop:${force === true ? 'force' : 'drain'}`);
    return Promise.resolve();
  },
});

const createFakeApplicationHandler = () => () => Promise.resolve(new Response('application'));

describe('platform server lifecycle', () => {
  test('serves liveness while starting and readiness after store compatibility', async () => {
    const events: string[] = [];
    const diagnostics: string[] = [];
    const capture: { handler?: (request: Request) => Promise<Response> } = {};
    const store = createFakeStore(events);
    const deferredStore = createDeferred<PlatformStore>();
    const dependencies: PlatformServerDependencies = {
      createApplicationHandler: createFakeApplicationHandler,
      createStore: () => deferredStore.promise,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(
          diagnostic.code === 'device-token-key-version-active'
            ? `${diagnostic.code}:${diagnostic.keyVersion}`
            : diagnostic.code,
        );
      },
      startHttpServer: (input) => {
        capture.handler = input.fetch;
        return createFakeHttpServer(events);
      },
    };

    const starting = startPlatformServer(config, dependencies);
    const handler = capture.handler;
    if (!handler) {
      throw new Error('Health handler was not captured.');
    }
    expect((await handler(new Request('http://platform.test/health/live'))).status).toBe(200);
    expect((await handler(new Request('http://platform.test/health/ready'))).status).toBe(503);

    deferredStore.resolve(store);
    const server = await starting;
    expect((await handler(new Request('http://platform.test/health/ready'))).status).toBe(200);
    expect(diagnostics).toEqual(['device-token-key-version-active:1', 'ready']);

    await server.close();
    expect(events).toEqual(['http-stop:drain', 'store-close']);
  });

  test('falls back to a forced HTTP stop before closing the pool', async () => {
    const events: string[] = [];
    const store = createFakeStore(events);
    const server = await startPlatformServer(config, {
      createApplicationHandler: createFakeApplicationHandler,
      createStore: () => Promise.resolve(store),
      startHttpServer: () => ({
        port: 4512,
        stop: (force) => {
          events.push(`http-stop:${force === true ? 'force' : 'drain'}`);
          return force === true ? Promise.resolve() : Promise.reject(new Error('drain failed'));
        },
      }),
    });

    await server.close();
    expect(events).toEqual(['http-stop:drain', 'http-stop:force', 'store-close']);
  });

  test('closes the listener and exposes only a generic startup error when the store fails', async () => {
    const events: string[] = [];
    const starting = startPlatformServer(config, {
      createApplicationHandler: createFakeApplicationHandler,
      createStore: () => Promise.reject(new Error('server-secret at example.invalid')),
      startHttpServer: () => ({
        port: 4513,
        stop: (force) => {
          events.push(`http-stop:${force === true ? 'force' : 'drain'}`);
          return Promise.resolve();
        },
      }),
    });

    let failure: unknown;
    try {
      await starting;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'startup-failed', message: 'The platform server operation failed.' });
    expect(String(failure)).not.toContain('server-secret');
    expect(String(failure)).not.toContain('example.invalid');
    expect(events).toEqual(['http-stop:force']);
  });
});
