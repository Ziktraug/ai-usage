import type { SyncRemoteConfig } from '@ai-usage/core/project-alias';
import type { LocalHistoryError } from '@ai-usage/local-collectors/errors';
import { LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import {
  listSyncRemotes,
  removeSyncRemote,
  resolveSyncToken,
  storeSyncedSnapshot,
  syncedSnapshotPath,
  upsertSyncRemote,
  type StoredSyncedSnapshot,
} from '@ai-usage/local-collectors/sync-storage';
import { Effect } from 'effect';
import { SyncTransportError } from './errors';
import { SyncWorkflowError } from './errors';
import { fetchRemoteSnapshot } from './transport';

export interface AddSyncRemoteInput {
  name: string;
  url: string;
  tokenEnv: string | null;
}

export interface PullSyncRemoteResult {
  record: StoredSyncedSnapshot;
  path: string;
  durationMs: number;
}

export const validateSyncUrl = (url: string): Effect.Effect<void, SyncWorkflowError> =>
  Effect.try({
    try: () => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error('URL must start with http:// or https://');
    },
    catch: (cause) =>
      new SyncWorkflowError({
        operation: 'validateSyncUrl',
        reason: 'invalid-url',
        message: `Invalid sync URL ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

export const validateTokenEnv = (tokenEnv: string | null): Effect.Effect<void, SyncWorkflowError> =>
  Effect.try({
    try: () => {
      if (tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv))
        throw new Error('environment variable names may contain letters, digits, and underscores');
    },
    catch: (cause) =>
      new SyncWorkflowError({
        operation: 'validateTokenEnv',
        reason: 'invalid-token-env',
        message: `Invalid --token-env ${tokenEnv}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

export const addSyncRemote = (
  input: AddSyncRemoteInput,
): Effect.Effect<
  SyncRemoteConfig[],
  LocalHistoryError | SyncWorkflowError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    yield* validateSyncUrl(input.url);
    yield* validateTokenEnv(input.tokenEnv);
    const remote = {
      name: input.name,
      url: input.url,
      ...(input.tokenEnv ? { tokenEnv: input.tokenEnv } : {}),
    };
    return yield* upsertSyncRemote(remote);
  });

export const removeConfiguredSyncRemote = (
  name: string,
): Effect.Effect<boolean, LocalHistoryError, import('@ai-usage/local-collectors/local-history').LocalHistoryStorage> =>
  removeSyncRemote(name);

export const setSyncRemoteEnabled = (
  name: string,
  enabled: boolean,
): Effect.Effect<
  SyncRemoteConfig[],
  LocalHistoryError | SyncWorkflowError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    const remote = yield* findSyncRemote(name);
    return yield* upsertSyncRemote({ ...remote, enabled });
  });

export const findSyncRemote = (
  name: string,
): Effect.Effect<
  SyncRemoteConfig,
  LocalHistoryError | SyncWorkflowError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    const remotes = yield* listSyncRemotes;
    const remote = remotes.find((item) => item.name === name);
    if (!remote) {
      return yield* Effect.fail(
        new SyncWorkflowError({
          operation: 'findSyncRemote',
          reason: 'unknown-remote',
          remoteName: name,
          message: `Unknown sync remote: ${name}`,
        }),
      );
    }
    return remote;
  });

export const tokenForSyncRemote = (
  remote: SyncRemoteConfig,
): Effect.Effect<
  string | null,
  LocalHistoryError | SyncWorkflowError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    const token = yield* resolveSyncToken(remote.tokenEnv);
    if (remote.tokenEnv && !token) {
      return yield* Effect.fail(
        new SyncWorkflowError({
          operation: 'resolveSyncToken',
          reason: 'missing-token',
          remoteName: remote.name,
          message: `Missing token env ${remote.tokenEnv}. Set it in your shell or ~/.config/ai-usage/.env.`,
        }),
      );
    }
    return token;
  });

export const selectSyncRemotesToPull = (
  name: string | null,
): Effect.Effect<
  SyncRemoteConfig[],
  LocalHistoryError | SyncWorkflowError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    if (name) return [yield* findSyncRemote(name)];
    const remotes = (yield* listSyncRemotes).filter((remote) => remote.enabled !== false);
    if (!remotes.length) {
      return yield* Effect.fail(
        new SyncWorkflowError({
          operation: 'selectSyncRemotesToPull',
          reason: 'no-remotes',
          message: 'No enabled sync remotes configured.',
        }),
      );
    }
    return remotes;
  });

export const applyPullTokenEnvOverride = (remotes: SyncRemoteConfig[], tokenEnv: string | null): SyncRemoteConfig[] =>
  tokenEnv ? remotes.map((remote) => ({ ...remote, tokenEnv })) : remotes;

export const pullSyncRemote = (
  remote: SyncRemoteConfig,
): Effect.Effect<
  PullSyncRemoteResult,
  LocalHistoryError | SyncTransportError | SyncWorkflowError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    const started = Date.now();
    const token = yield* tokenForSyncRemote(remote);
    const snapshot = yield* fetchRemoteSnapshot(remote.url, token);
    const localMachine = yield* ensureMachineConfig;
    if (snapshot.machine.id === localMachine.id) {
      return yield* Effect.fail(
        new SyncWorkflowError({
          operation: 'pullSyncRemote',
          reason: 'self-sync',
          remoteName: remote.name,
          message: `Refusing to sync remote ${remote.name}: snapshot machine id matches this machine (${localMachine.id}).`,
        }),
      );
    }
    const record = yield* storeSyncedSnapshot({ remote, snapshot });
    const storage = yield* LocalHistoryStorage;
    return { record, path: syncedSnapshotPath(storage, remote.name), durationMs: Date.now() - started };
  });

export const pullOneShotSyncRemote = (
  input: AddSyncRemoteInput,
): Effect.Effect<
  PullSyncRemoteResult,
  LocalHistoryError | SyncTransportError | SyncWorkflowError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    yield* validateSyncUrl(input.url);
    yield* validateTokenEnv(input.tokenEnv);
    return yield* pullSyncRemote({
      name: input.name,
      url: input.url,
      ...(input.tokenEnv ? { tokenEnv: input.tokenEnv } : {}),
    });
  });
