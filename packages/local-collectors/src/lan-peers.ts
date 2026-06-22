import fs from 'node:fs';
import path from 'node:path';
import { Effect } from 'effect';
import { LocalHistoryError } from './errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';

export const LAN_PEERS_CONFIG_FILE = 'lan-peers.json';

export interface StoredLanPeer {
  lastMergedAt?: string;
  lastSeenAt?: string;
  machineId: string;
  machineLabel: string;
  pairedAt: string;
  tokenEnv: string;
}

export interface LanPeersConfig {
  peers: StoredLanPeer[];
  version: 1;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';

const isStoredLanPeer = (value: unknown): value is StoredLanPeer => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.machineId === 'string' &&
    value.machineId.length > 0 &&
    typeof value.machineLabel === 'string' &&
    typeof value.tokenEnv === 'string' &&
    value.tokenEnv.length > 0 &&
    typeof value.pairedAt === 'string' &&
    isOptionalString(value.lastSeenAt) &&
    isOptionalString(value.lastMergedAt)
  );
};

export const lanPeersConfigPath = (storage: { home: string }) =>
  path.join(storage.home, '.config', 'ai-usage', LAN_PEERS_CONFIG_FILE);

export const emptyLanPeersConfig = (): LanPeersConfig => ({ version: 1, peers: [] });

export const parseLanPeersConfig = (text: string): LanPeersConfig => {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) {
    throw new Error('LAN peers config must be an object');
  }
  if (value.version !== 1) {
    throw new Error('Unsupported LAN peers config version');
  }
  if (!(Array.isArray(value.peers) && value.peers.every(isStoredLanPeer))) {
    throw new Error('LAN peers config contains invalid peers');
  }
  return {
    version: value.version,
    peers: value.peers,
  };
};

const lanPeersError = (operation: string, filePath: string) => (cause: unknown) =>
  new LocalHistoryError({ operation, path: filePath, cause });

export const readLanPeersConfig: Effect.Effect<LanPeersConfig, LocalHistoryError, LocalHistoryStorageService> =
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const filePath = lanPeersConfigPath(storage);
    if (!(yield* storage.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false))))) {
      return emptyLanPeersConfig();
    }
    return parseLanPeersConfig(yield* storage.readText(filePath));
  });

export const writeLanPeersConfig = (
  config: LanPeersConfig,
): Effect.Effect<void, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const filePath = lanPeersConfigPath(storage);
    yield* Effect.try({
      try: () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      },
      catch: lanPeersError('writeLanPeersConfig', filePath),
    });
  });

export const upsertStoredLanPeer = (
  peer: StoredLanPeer,
): Effect.Effect<LanPeersConfig, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const current = yield* readLanPeersConfig;
    const next: LanPeersConfig = {
      version: 1,
      peers: [...current.peers.filter((stored) => stored.machineId !== peer.machineId), peer].sort((a, b) =>
        a.machineLabel.localeCompare(b.machineLabel),
      ),
    };
    yield* writeLanPeersConfig(next);
    return next;
  });
