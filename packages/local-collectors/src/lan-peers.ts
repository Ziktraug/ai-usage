import path from 'node:path';

export const LAN_PEERS_CONFIG_FILE = 'lan-peers.json';

export interface StoredLanPeer {
  machineId: string;
  machineLabel: string;
  tokenEnv: string;
  pairedAt: string;
  lastSeenAt?: string;
  lastMergedAt?: string;
}

export interface LanPeersConfig {
  version: 1;
  peers: StoredLanPeer[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';

const isStoredLanPeer = (value: unknown): value is StoredLanPeer => {
  if (!isRecord(value)) return false;
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
  if (!isRecord(value)) throw new Error('LAN peers config must be an object');
  if (value.version !== 1) throw new Error('Unsupported LAN peers config version');
  if (!Array.isArray(value.peers) || !value.peers.every(isStoredLanPeer)) {
    throw new Error('LAN peers config contains invalid peers');
  }
  return {
    version: value.version,
    peers: value.peers,
  };
};
