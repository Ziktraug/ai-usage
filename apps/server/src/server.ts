import { createPlatformStore, type PlatformStore, type PlatformStoreConfig } from '@ai-usage/postgres-store/writer';
import { createPlatformApplicationHandler, type ReplicationIngestMetric } from './application';
import { type PlatformServerConfig, revealDatabaseUrl } from './config';
import { createPlatformHealthHandler } from './health';

export type PlatformServerErrorCode = 'http-start-failed' | 'shutdown-failed' | 'shutdown-timeout' | 'startup-failed';

export class PlatformServerError extends Error {
  readonly code: PlatformServerErrorCode;

  constructor(code: PlatformServerErrorCode) {
    super('The platform server operation failed.');
    this.name = 'PlatformServerError';
    this.code = code;
  }
}

export type PlatformServerDiagnostic =
  | { readonly code: 'device-token-key-version-active'; readonly keyVersion: number; readonly operation: 'security' }
  | { readonly code: 'drain-forced'; readonly operation: 'shutdown' }
  | { readonly code: 'ready'; readonly operation: 'startup' }
  | ({ readonly code: 'replication-batch'; readonly operation: 'replication' } & ReplicationIngestMetric)
  | { readonly code: 'shutdown-complete'; readonly operation: 'shutdown' }
  | { readonly code: 'startup-failed'; readonly operation: 'startup' }
  | { readonly code: 'store-event'; readonly operation: 'store' };

export interface PlatformHttpServer {
  readonly port: number;
  readonly stop: (force?: boolean) => Promise<void> | void;
}

export interface StartPlatformHttpServerInput {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly host: string;
  readonly port: number;
}

export interface PlatformServerDependencies {
  readonly createApplicationHandler: (
    config: PlatformServerConfig,
    store: PlatformStore,
    onReplicationMetric: (metric: ReplicationIngestMetric) => void,
  ) => (request: Request) => Promise<Response>;
  readonly createStore: (config: PlatformStoreConfig) => Promise<PlatformStore>;
  readonly onDiagnostic?: (diagnostic: PlatformServerDiagnostic) => void;
  readonly startHttpServer: (input: StartPlatformHttpServerInput) => PlatformHttpServer;
}

export interface RunningPlatformServer {
  readonly close: () => Promise<void>;
  readonly port: number;
}

const defaultStartHttpServer = (input: StartPlatformHttpServerInput): PlatformHttpServer => {
  const server = Bun.serve({
    fetch: input.fetch,
    hostname: input.host,
    port: input.port,
  });
  return {
    port: server.port ?? input.port,
    stop: (force?: boolean) => server.stop(force),
  };
};

const defaultDependencies: PlatformServerDependencies = {
  createApplicationHandler: createPlatformApplicationHandler,
  createStore: createPlatformStore,
  startHttpServer: defaultStartHttpServer,
};

interface TimeoutResult<T> {
  readonly status: 'completed';
  readonly value: T;
}

interface TimedOutResult {
  readonly status: 'timed-out';
}

interface FailedResult {
  readonly status: 'failed';
}

const runWithTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<FailedResult | TimeoutResult<T> | TimedOutResult> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<TimedOutResult>((resolve) => {
    timeout = setTimeout(() => resolve({ status: 'timed-out' }), timeoutMs);
  });
  const completed: Promise<FailedResult | TimeoutResult<T>> = operation.then(
    (value): TimeoutResult<T> => ({ status: 'completed', value }),
    (): FailedResult => ({ status: 'failed' }),
  );
  const result = await Promise.race([completed, timedOut]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  return result;
};

export const startPlatformServer = async (
  config: PlatformServerConfig,
  dependencies: PlatformServerDependencies = defaultDependencies,
): Promise<RunningPlatformServer> => {
  let lifecycle: 'closed' | 'closing' | 'ready' | 'starting' = 'starting';
  let store: PlatformStore | undefined;
  let applicationHandler: ((request: Request) => Promise<Response>) | undefined;
  const healthHandler = createPlatformHealthHandler({
    checkReadiness: async (): Promise<void> => {
      if (lifecycle !== 'ready' || !store) {
        throw new PlatformServerError('startup-failed');
      }
      await store.checkReadiness();
    },
  });

  let httpServer: PlatformHttpServer;
  try {
    httpServer = dependencies.startHttpServer({
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/health/live' || path === '/health/ready') {
          return healthHandler(request);
        }
        if (lifecycle !== 'ready' || !applicationHandler) {
          return Promise.resolve(
            new Response('{"status":"not-ready"}', {
              headers: { 'content-type': 'application/json' },
              status: 503,
            }),
          );
        }
        return applicationHandler(request);
      },
      host: config.host,
      port: config.port,
    });
  } catch {
    throw new PlatformServerError('http-start-failed');
  }

  try {
    store = await dependencies.createStore({
      connectTimeoutMs: config.connectTimeoutMs,
      databaseUrl: revealDatabaseUrl(config.databaseUrl),
      migrationMode: config.migrationMode,
      onDiagnostic: () => dependencies.onDiagnostic?.({ code: 'store-event', operation: 'store' }),
      poolSize: config.poolSize,
      queryTimeoutMs: config.queryTimeoutMs,
      tlsMode: config.tlsMode,
    });
    applicationHandler = dependencies.createApplicationHandler(config, store, (metric) =>
      dependencies.onDiagnostic?.({ code: 'replication-batch', operation: 'replication', ...metric }),
    );
    lifecycle = 'ready';
    dependencies.onDiagnostic?.({
      code: 'device-token-key-version-active',
      keyVersion: config.deviceTokenKeyRing.current.keyVersion,
      operation: 'security',
    });
    dependencies.onDiagnostic?.({ code: 'ready', operation: 'startup' });
  } catch {
    lifecycle = 'closed';
    dependencies.onDiagnostic?.({ code: 'startup-failed', operation: 'startup' });
    await runWithTimeout(Promise.resolve(httpServer.stop(true)), config.shutdownTimeoutMs);
    await runWithTimeout(store?.close() ?? Promise.resolve(), config.shutdownTimeoutMs);
    throw new PlatformServerError('startup-failed');
  }

  let closeOperation: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closeOperation ??= (async () => {
      if (lifecycle === 'closed') {
        return;
      }
      lifecycle = 'closing';

      const drain = await runWithTimeout(Promise.resolve(httpServer.stop(false)), config.shutdownTimeoutMs);
      let httpShutdownFailed = false;
      if (drain.status !== 'completed') {
        dependencies.onDiagnostic?.({ code: 'drain-forced', operation: 'shutdown' });
        const forced = await runWithTimeout(Promise.resolve(httpServer.stop(true)), config.shutdownTimeoutMs);
        httpShutdownFailed = forced.status !== 'completed';
      }

      const storeClose = await runWithTimeout(store?.close() ?? Promise.resolve(), config.shutdownTimeoutMs);
      lifecycle = 'closed';
      if (storeClose.status === 'timed-out') {
        throw new PlatformServerError('shutdown-timeout');
      }
      if (httpShutdownFailed || storeClose.status === 'failed') {
        throw new PlatformServerError('shutdown-failed');
      }
      dependencies.onDiagnostic?.({ code: 'shutdown-complete', operation: 'shutdown' });
    })();
    return closeOperation;
  };

  return Object.freeze({ close, port: httpServer.port });
};
