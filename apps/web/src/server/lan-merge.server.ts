import { makeLanPairingService } from '@ai-usage/lan-pairing';
import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { readLanPeersConfig, upsertStoredLanPeer } from '@ai-usage/local-collectors/lan-peers';
import { createUsageMergeRuntime, upsertUsageMergeEnvToken, type UsageMergeService } from '@ai-usage/usage-merge';
import { usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';

export type LanMergeServerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        tag: string;
        message: string;
        reason?: string;
      };
    };

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

const errorResult = (error: unknown): LanMergeServerResult<never> => {
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

let runtimePromise: Promise<UsageMergeService> | undefined;

const createRuntime =
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const localMachine = yield* ensureMachineConfig;
    const peers = yield* readLanPeersConfig;
    const lanPairing = yield* makeLanPairingService;
    return createUsageMergeRuntime({
      localMachine,
      dbPath: usageStorePath(storage.home),
      peers: peers.peers,
      lanPairing,
      lanHost: '0.0.0.0',
      persistToken: (key, value) => {
        upsertUsageMergeEnvToken(key, value);
      },
      persistTrustedPeer: async (peer) => {
        await Effect.runPromise(upsertStoredLanPeer(peer).pipe(Effect.provideService(LocalHistoryStorage, storage)));
      },
    });
  });

const getRuntime = () => {
  runtimePromise ??= Effect.runPromise(createRuntime.pipe(Effect.provide(LocalHistoryStorageLive))).catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};

const runRuntime = async <A>(operation: (runtime: UsageMergeService) => Effect.Effect<A, unknown>): Promise<LanMergeServerResult<A>> => {
  try {
    const runtime = await getRuntime();
    return { ok: true, data: toJson(await Effect.runPromise(operation(runtime))) };
  } catch (error) {
    return errorResult(error);
  }
};

export const readLanMergeStateForServer = () =>
  runRuntime((runtime) => runtime.getLanMergeState());

export const startLanMergeForServer = () =>
  runRuntime((runtime) => runtime.startLanMerge().pipe(Effect.zipRight(runtime.getLanMergeState())));

export const stopLanMergeForServer = () =>
  runRuntime((runtime) => runtime.stopLanMerge().pipe(Effect.zipRight(runtime.getLanMergeState())));

export const scanLanMergePeersForServer = (_input: LanMergeScanInput = {}) =>
  runRuntime((runtime) => runtime.scanLanMergePeers());

export const mergeLanPeerForServer = (input: LanMergePeerInput) =>
  runRuntime((runtime) => runtime.mergePeer({ machineId: input.machineId }).pipe(Effect.zipRight(runtime.getLanMergeState())));

export const pairLanPeerForServer = (input: LanMergePairInput) =>
  runRuntime((runtime) =>
    runtime.pairPeer({
      discoveredPeerId: input.discoveredPeerId,
      password: input.password,
    }),
  );

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
