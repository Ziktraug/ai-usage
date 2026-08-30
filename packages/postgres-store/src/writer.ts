import { Pool } from 'pg';
import type { PlatformAuthenticationStore } from './authentication';
import type { PlatformAuthorizationStore } from './authorization';
import type { PlatformDeviceStore } from './devices';
import { asPlatformStoreError, PlatformStoreError } from './errors';
import type { PlatformIdentityStore } from './identity';
import { createPlatformAuthenticationStore } from './internal/authentication-adapter';
import { createPlatformAuthorizationStore } from './internal/authorization-adapter';
import { createPlatformDeviceStore } from './internal/device-adapter';
import { getInjectedPlatformStoreFactory } from './internal/factory-injection';
import { createPlatformIdentityStore } from './internal/identity-adapter';
import { createPlatformMemoryRepository } from './internal/memory-adapter';
import { runPlatformMigrations } from './internal/migration-runner';
import { createPlatformProjectCatalog } from './internal/project-adapter';
import { createPlatformStoreReader } from './internal/reader-adapter';
import { createPlatformReplicationStore } from './internal/replication-adapter';
import type { PlatformMemoryRepository } from './memory';
import type { PlatformMigrationMode } from './migrations';
import type { PlatformProjectCatalog } from './projects';
import type { PlatformReadiness, PlatformStoreReader } from './reader';
import type { PlatformReplicationStore } from './replication';

export type PlatformDatabaseTlsMode = 'disable' | 'require';

export type PlatformStoreDiagnostic =
  | { readonly code: 'idle-client-error'; readonly operation: 'pool' }
  | { readonly code: 'migration-complete'; readonly operation: 'startup' }
  | { readonly code: 'store-closed'; readonly operation: 'shutdown' };

export interface PlatformStoreConfig {
  readonly connectTimeoutMs: number;
  readonly databaseUrl: string;
  readonly migrationMode: PlatformMigrationMode;
  readonly onDiagnostic?: (diagnostic: PlatformStoreDiagnostic) => void;
  readonly poolSize: number;
  readonly queryTimeoutMs: number;
  readonly tlsMode: PlatformDatabaseTlsMode;
}

export interface PlatformStore {
  readonly authentication: PlatformAuthenticationStore;
  readonly authorization: PlatformAuthorizationStore;
  readonly checkReadiness: () => Promise<PlatformReadiness>;
  readonly close: () => Promise<void>;
  readonly devices: PlatformDeviceStore;
  readonly identity: PlatformIdentityStore;
  readonly memory: PlatformMemoryRepository;
  readonly projects: PlatformProjectCatalog;
  readonly reader: PlatformStoreReader;
  readonly replication: PlatformReplicationStore;
}

const positiveInteger = (value: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= maximum;

const validateStoreConfig = (config: PlatformStoreConfig): void => {
  if (
    config.databaseUrl.length === 0 ||
    !positiveInteger(config.poolSize, 100) ||
    !positiveInteger(config.connectTimeoutMs, 120_000) ||
    !positiveInteger(config.queryTimeoutMs, 120_000)
  ) {
    throw new PlatformStoreError('configuration-invalid', 'validate-store-config');
  }
};

export const createPlatformStore = async (config: PlatformStoreConfig): Promise<PlatformStore> => {
  const injectedFactory = getInjectedPlatformStoreFactory();
  if (injectedFactory) {
    return injectedFactory(config);
  }
  validateStoreConfig(config);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.connectTimeoutMs,
    max: config.poolSize,
    query_timeout: config.queryTimeoutMs,
    ssl: config.tlsMode === 'require' ? { rejectUnauthorized: true } : false,
  });
  pool.on('error', () => config.onDiagnostic?.({ code: 'idle-client-error', operation: 'pool' }));

  try {
    await runPlatformMigrations(pool, { mode: config.migrationMode });
    config.onDiagnostic?.({ code: 'migration-complete', operation: 'startup' });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw asPlatformStoreError(error, 'migration-failed', 'initialize-store');
  }

  const reader = createPlatformStoreReader(pool);
  const authentication = createPlatformAuthenticationStore(pool);
  const identity = createPlatformIdentityStore(pool);
  const authorization = createPlatformAuthorizationStore(pool);
  const devices = createPlatformDeviceStore(pool);
  const projects = createPlatformProjectCatalog(pool);
  const memory = createPlatformMemoryRepository(pool);
  const replication = createPlatformReplicationStore(pool);
  try {
    await reader.checkReadiness();
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw asPlatformStoreError(error, 'readiness-failed', 'initialize-store');
  }

  let lifecycle: 'closed' | 'closing' | 'open' = 'open';
  let closeOperation: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closeOperation ??= (async () => {
      if (lifecycle === 'closed') {
        return;
      }
      lifecycle = 'closing';
      try {
        await pool.end();
      } catch {
        lifecycle = 'closed';
        throw new PlatformStoreError('shutdown-failed', 'close-store');
      }
      lifecycle = 'closed';
      config.onDiagnostic?.({ code: 'store-closed', operation: 'shutdown' });
    })();
    return closeOperation;
  };

  return Object.freeze({
    authentication,
    authorization,
    checkReadiness: (): Promise<PlatformReadiness> => {
      if (lifecycle !== 'open') {
        throw new PlatformStoreError('store-closed', 'check-store-readiness');
      }
      return reader.checkReadiness();
    },
    close,
    devices,
    identity,
    memory,
    projects,
    reader,
    replication,
  });
};

export type { PlatformStoreErrorCode } from './errors';
export { isPlatformStoreError, PlatformStoreError } from './errors';
export type { PlatformMigrationMode } from './migrations';
export type { PlatformReadiness, PlatformStoreReader } from './reader';
