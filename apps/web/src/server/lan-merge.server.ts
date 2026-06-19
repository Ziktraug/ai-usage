import { discoverLanPeers, type DiscoveredLanPeer } from '@ai-usage/lan-pairing';
import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { readLanPeersConfig } from '@ai-usage/local-collectors/lan-peers';
import { createUsageMergeRuntime, lanIdentityFromMachine } from '@ai-usage/usage-merge';
import { usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import type { SyncServerResult } from './sync.server';

export interface LanMergePeerInput {
  machineId: string;
  url?: string | null;
}

export interface LanMergePairInput {
  discoveredPeerId: string;
  password: string;
  url?: string | null;
}

export interface LanMergeScanInput {
  hosts?: string[];
  timeoutMs?: number;
}

const toJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const errorResult = (error: unknown): SyncServerResult<never> => {
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  return {
    ok: false,
    error: {
      tag: typeof record._tag === 'string' ? record._tag : 'Error',
      message: error instanceof Error ? error.message : String(error),
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    },
  };
};

const mergeBundleUrlForPeer = (peer: DiscoveredLanPeer) => `http://${peer.host}:${peer.port}/lan/merge-bundle`;

const peerUrlsFromDiscovered = (peers: DiscoveredLanPeer[]) =>
  Object.fromEntries(peers.filter((peer) => peer.online).map((peer) => [peer.identity.id, mergeBundleUrlForPeer(peer)]));

const runLanMerge = async <A>(
  effect: Effect.Effect<A, unknown, import('@ai-usage/local-collectors/local-history').LocalHistoryStorage>,
): Promise<SyncServerResult<A>> => {
  try {
    return { ok: true, data: toJson(await Effect.runPromise(effect.pipe(Effect.provide(LocalHistoryStorageLive)))) };
  } catch (error) {
    return errorResult(error);
  }
};

const makeRuntime = (input: { discoveredPeers?: DiscoveredLanPeer[]; peerUrls?: Record<string, string> } = {}) =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const localMachine = yield* ensureMachineConfig;
    const peers = yield* readLanPeersConfig;
    return createUsageMergeRuntime({
      localMachine,
      dbPath: usageStorePath(storage.home),
      peers: peers.peers,
      discoveredPeers: input.discoveredPeers ?? [],
      peerUrls: input.peerUrls ?? peerUrlsFromDiscovered(input.discoveredPeers ?? []),
    });
  });

export const readLanMergeStateForServer = () =>
  runLanMerge(Effect.gen(function* () {
    const runtime = yield* makeRuntime();
    return yield* runtime.getLanMergeState();
  }));

export const scanLanMergePeersForServer = (input: LanMergeScanInput = {}) =>
  runLanMerge(Effect.gen(function* () {
    const localMachine = yield* ensureMachineConfig;
    const discoveredPeers = yield* discoverLanPeers({
      localIdentity: lanIdentityFromMachine(localMachine),
      ...(input.hosts === undefined ? {} : { hosts: input.hosts }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    const runtime = yield* makeRuntime({ discoveredPeers });
    return yield* runtime.getLanMergeState();
  }));

export const mergeLanPeerForServer = (input: LanMergePeerInput) =>
  runLanMerge(Effect.gen(function* () {
    const runtime = yield* makeRuntime({
      peerUrls: input.url ? { [input.machineId]: input.url } : {},
    });
    yield* runtime.mergePeer({ machineId: input.machineId });
    return yield* runtime.getLanMergeState();
  }));

export const pairLanPeerForServer = (input: LanMergePairInput) =>
  runLanMerge(Effect.gen(function* () {
    const runtime = yield* makeRuntime({
      discoveredPeers: [
        {
          identity: { id: input.discoveredPeerId, label: input.discoveredPeerId, protocol: 'ai-usage-lan-merge', version: 1 },
          host: 'paired-peer',
          port: 3847,
          online: Boolean(input.url),
          pairingAvailable: true,
          self: false,
          lastSeenAt: new Date().toISOString(),
        },
      ],
      peerUrls: input.url ? { [input.discoveredPeerId]: input.url } : {},
    });
    return yield* runtime.pairPeer({
      discoveredPeerId: input.discoveredPeerId,
      password: input.password,
    });
  }));

const objectInput = (input: unknown): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Expected object input');
  return input as Record<string, unknown>;
};

const stringField = (record: Record<string, unknown>, field: string) => {
  const value = record[field];
  if (typeof value !== 'string' || !value) throw new Error(`Expected ${field} to be a non-empty string`);
  return value;
};

const optionalStringField = (record: Record<string, unknown>, field: string) => {
  const value = record[field];
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`Expected ${field} to be a string`);
  return value;
};

export const lanMergePeerInputFrom = (input: unknown): LanMergePeerInput => {
  const record = objectInput(input);
  return { machineId: stringField(record, 'machineId'), url: optionalStringField(record, 'url') };
};

export const lanMergePairInputFrom = (input: unknown): LanMergePairInput => {
  const record = objectInput(input);
  return {
    discoveredPeerId: stringField(record, 'discoveredPeerId'),
    password: stringField(record, 'password'),
    url: optionalStringField(record, 'url'),
  };
};

export const lanMergeScanInputFrom = (input: unknown): LanMergeScanInput => {
  if (input == null) return {};
  const record = objectInput(input);
  const hosts = record.hosts;
  return {
    ...(Array.isArray(hosts) ? { hosts: hosts.map((host) => String(host)) } : {}),
    ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
  };
};
