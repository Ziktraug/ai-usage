import fs from 'node:fs';
import path from 'node:path';
import type { SyncRemoteConfig } from '@ai-usage/core/project-alias';
import { parseUsageSnapshot, type UsageSnapshot } from '@ai-usage/core/snapshot';
import { Effect } from 'effect';
import { LocalHistoryError, type LocalHistoryWarning } from './errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';
import { readAiUsageConfig, writeAiUsageConfig } from './machine-config';

export interface StoredSyncedSnapshot {
  remoteName: string;
  remoteUrl: string;
  fetchedAt: string;
  snapshot: UsageSnapshot;
}

export interface SyncedSnapshotsResult {
  records: StoredSyncedSnapshot[];
  warnings: LocalHistoryWarning[];
}

const syncError = (operation: string, filePath?: string) => (cause: unknown) =>
  new LocalHistoryError({ operation, cause, ...(filePath === undefined ? {} : { path: filePath }) });

const syncDir = (storage: LocalHistoryStorageService) => path.join(storage.home, '.local', 'share', 'ai-usage');

export const syncedSnapshotsDir = (storage: LocalHistoryStorageService) => path.join(syncDir(storage), 'snapshots');

export const userEnvPath = (storage: LocalHistoryStorageService) =>
  path.join(storage.home, '.config', 'ai-usage', '.env');

const remoteFileName = (name: string) => `${name.replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`;

export const syncedSnapshotPath = (storage: LocalHistoryStorageService, remoteName: string) =>
  path.join(syncedSnapshotsDir(storage), remoteFileName(remoteName));

const parseEnvText = (text: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
};

const readEnvFile = (filePath: string) =>
  Effect.try({
    try: () => (fs.existsSync(filePath) ? parseEnvText(fs.readFileSync(filePath, 'utf8')) : {}),
    catch: syncError('readSyncEnv', filePath),
  });

export const resolveSyncToken = (
  tokenEnv: string | undefined,
  configCwd = process.cwd(),
): Effect.Effect<string | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    if (!tokenEnv) return null;
    if (process.env[tokenEnv]) return process.env[tokenEnv]!;
    const storage = yield* LocalHistoryStorage;
    const userEnv = yield* readEnvFile(userEnvPath(storage));
    if (userEnv[tokenEnv]) return userEnv[tokenEnv]!;
    const repoEnv = yield* readEnvFile(path.join(configCwd, '.env'));
    return repoEnv[tokenEnv] ?? null;
  });

export const listSyncRemotes: Effect.Effect<SyncRemoteConfig[], LocalHistoryError, LocalHistoryStorageService> =
  Effect.gen(function* () {
    const config = yield* readAiUsageConfig;
    return config.sync?.remotes ?? [];
  });

export const upsertSyncRemote = (
  remote: SyncRemoteConfig,
): Effect.Effect<SyncRemoteConfig[], LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const config = yield* readAiUsageConfig;
    const remotes = config.sync?.remotes ?? [];
    const next = [...remotes.filter((item) => item.name !== remote.name), { ...remote, enabled: remote.enabled ?? true }];
    yield* writeAiUsageConfig({ ...config, sync: { ...(config.sync ?? {}), remotes: next } });
    return next;
  });

export const removeSyncRemote = (
  name: string,
  options: { removeSnapshot?: boolean } = {},
): Effect.Effect<boolean, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const config = yield* readAiUsageConfig;
    const remotes = config.sync?.remotes ?? [];
    const next = remotes.filter((remote) => remote.name !== name);
    yield* writeAiUsageConfig({ ...config, sync: { ...(config.sync ?? {}), remotes: next } });
    if (options.removeSnapshot ?? true) {
      const storage = yield* LocalHistoryStorage;
      const filePath = syncedSnapshotPath(storage, name);
      yield* Effect.try({
        try: () => {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        },
        catch: syncError('removeSyncedSnapshot', filePath),
      });
    }
    return next.length !== remotes.length;
  });

export const storeSyncedSnapshot = (input: {
  remote: SyncRemoteConfig;
  snapshot: UsageSnapshot;
  fetchedAt?: Date;
}): Effect.Effect<StoredSyncedSnapshot, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const record: StoredSyncedSnapshot = {
      remoteName: input.remote.name,
      remoteUrl: input.remote.url,
      fetchedAt: (input.fetchedAt ?? new Date()).toISOString(),
      snapshot: input.snapshot,
    };
    const filePath = syncedSnapshotPath(storage, input.remote.name);
    yield* Effect.try({
      try: () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      },
      catch: syncError('storeSyncedSnapshot', filePath),
    });
    return record;
  });

const parseStoredSyncedSnapshot = (text: string): StoredSyncedSnapshot => {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Stored snapshot must be an object');
  const record = value as Record<string, unknown>;
  if (typeof record.remoteName !== 'string') throw new Error('Stored snapshot missing remoteName');
  if (typeof record.remoteUrl !== 'string') throw new Error('Stored snapshot missing remoteUrl');
  if (typeof record.fetchedAt !== 'string') throw new Error('Stored snapshot missing fetchedAt');
  return {
    remoteName: record.remoteName,
    remoteUrl: record.remoteUrl,
    fetchedAt: record.fetchedAt,
    snapshot: parseUsageSnapshot(JSON.stringify(record.snapshot)),
  };
};

const warning = (operation: string, filePath: string, cause: unknown): LocalHistoryWarning => ({
  operation,
  path: filePath,
  message: `${operation} ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
});

export const readSyncedSnapshotRecords: Effect.Effect<
  SyncedSnapshotsResult,
  LocalHistoryError,
  LocalHistoryStorageService
> = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const dirPath = syncedSnapshotsDir(storage);
  const records: StoredSyncedSnapshot[] = [];
  const warnings: LocalHistoryWarning[] = [];

  yield* Effect.try({
    try: () => {
      if (!fs.existsSync(dirPath)) return;
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const filePath = path.join(dirPath, entry.name);
        try {
          records.push(parseStoredSyncedSnapshot(fs.readFileSync(filePath, 'utf8')));
        } catch (cause) {
          warnings.push(warning('readSyncedSnapshot', filePath, cause));
        }
      }
    },
    catch: syncError('listSyncedSnapshots', dirPath),
  });

  return {
    records: records.sort((a, b) => a.remoteName.localeCompare(b.remoteName)),
    warnings,
  };
});
