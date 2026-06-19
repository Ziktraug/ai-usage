import type { SyncRemoteConfig } from '@ai-usage/core/project-alias';
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import {
  addSyncRemote,
  discoverConfiguredSnapshotRemotes,
  findSyncRemote,
  getSyncState,
  pullOneShotSyncRemote,
  pullSyncRemote,
  readSnapshotEndpointHealth,
  removeConfiguredSyncRemote,
  setSyncRemoteEnabled,
} from '@ai-usage/sync';
import { Effect } from 'effect';

export interface SyncRemoteInput {
  name: string;
  url: string;
  tokenEnv: string | null;
}

export interface SyncRemoteNameInput {
  name: string;
}

export interface SyncRemoteEnabledInput {
  name: string;
  enabled: boolean;
}

export interface SyncDiscoverInput {
  hosts?: string[];
  port?: number;
  timeoutMs?: number;
}

export interface SyncValidateRemoteInput {
  url: string;
  token?: string | null;
}

export type SyncServerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        tag: string;
        message: string;
        reason?: string;
      };
    };

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

const runSync = async <A>(
  effect: Effect.Effect<A, unknown, import('@ai-usage/local-collectors/local-history').LocalHistoryStorage>,
): Promise<SyncServerResult<A>> => {
  try {
    return { ok: true, data: toJson(await Effect.runPromise(effect.pipe(Effect.provide(LocalHistoryStorageLive)))) };
  } catch (error) {
    return errorResult(error);
  }
};

const stateAfter = <A>(effect: Effect.Effect<A, unknown, import('@ai-usage/local-collectors/local-history').LocalHistoryStorage>) =>
  runSync(effect.pipe(Effect.flatMap(() => getSyncState)));

const healthUrlForRemoteUrl = (remoteUrl: string) => {
  const url = new URL(remoteUrl);
  url.pathname = '/health';
  url.search = '';
  url.hash = '';
  return url.toString();
};

export const readSyncStateForServer = () => runSync(getSyncState);

export const discoverSyncPeersForServer = (input: SyncDiscoverInput = {}) =>
  runSync(discoverConfiguredSnapshotRemotes(input));

export const validateSyncRemoteForServer = (input: SyncValidateRemoteInput) =>
  runSync(readSnapshotEndpointHealth(healthUrlForRemoteUrl(input.url), input.token ?? null));

export const upsertSyncRemoteForServer = (input: SyncRemoteInput) => stateAfter(addSyncRemote(input));

export const setSyncRemoteEnabledForServer = (input: SyncRemoteEnabledInput) =>
  stateAfter(setSyncRemoteEnabled(input.name, input.enabled));

export const pullSyncRemoteForServer = (input: SyncRemoteNameInput) =>
  stateAfter(
    Effect.gen(function* () {
      const remote = yield* findSyncRemote(input.name);
      return yield* pullSyncRemote(remote);
    }),
  );

export const pullOneShotSyncRemoteForServer = (input: SyncRemoteInput) =>
  stateAfter(pullOneShotSyncRemote(input));

export const removeSyncRemoteForServer = (input: SyncRemoteNameInput) =>
  stateAfter(removeConfiguredSyncRemote(input.name));

export const syncRemoteInputFrom = (input: unknown): SyncRemoteInput => {
  const record = objectInput(input);
  const name = stringField(record, 'name');
  const url = stringField(record, 'url');
  const tokenEnv = nullableStringField(record, 'tokenEnv');
  return { name, url, tokenEnv };
};

export const syncRemoteNameInputFrom = (input: unknown): SyncRemoteNameInput => ({
  name: stringField(objectInput(input), 'name'),
});

export const syncRemoteEnabledInputFrom = (input: unknown): SyncRemoteEnabledInput => {
  const record = objectInput(input);
  return { name: stringField(record, 'name'), enabled: booleanField(record, 'enabled') };
};

export const syncDiscoverInputFrom = (input: unknown): SyncDiscoverInput => {
  if (input == null) return {};
  const record = objectInput(input);
  const hosts = record.hosts;
  return {
    ...(Array.isArray(hosts) ? { hosts: hosts.map((host) => String(host)) } : {}),
    ...(record.port == null ? {} : { port: positiveNumberField(record, 'port') }),
    ...(record.timeoutMs == null ? {} : { timeoutMs: positiveNumberField(record, 'timeoutMs') }),
  };
};

export const syncValidateRemoteInputFrom = (input: unknown): SyncValidateRemoteInput => {
  const record = objectInput(input);
  return {
    url: stringField(record, 'url'),
    ...(record.token == null ? {} : { token: String(record.token) }),
  };
};

const objectInput = (input: unknown): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Expected object input');
  return input as Record<string, unknown>;
};

const stringField = (record: Record<string, unknown>, field: string) => {
  const value = record[field];
  if (typeof value !== 'string' || !value) throw new Error(`Expected ${field} to be a non-empty string`);
  return value;
};

const nullableStringField = (record: Record<string, unknown>, field: string) => {
  const value = record[field];
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`Expected ${field} to be a string or null`);
  return value || null;
};

const booleanField = (record: Record<string, unknown>, field: string) => {
  const value = record[field];
  if (typeof value !== 'boolean') throw new Error(`Expected ${field} to be a boolean`);
  return value;
};

const positiveNumberField = (record: Record<string, unknown>, field: string) => {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) throw new Error(`Expected ${field} to be a positive number`);
  return value;
};

export type SyncRemoteConfigForServer = SyncRemoteConfig;
