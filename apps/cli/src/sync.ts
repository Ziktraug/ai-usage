import type { SyncRemoteConfig } from '@ai-usage/core/project-alias';
import { LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import {
  listSyncRemotes,
  readSyncedSnapshotRecords,
  removeSyncRemote,
  resolveSyncToken,
  type StoredSyncedSnapshot,
  storeSyncedSnapshot,
  syncedSnapshotPath,
  upsertSyncRemote,
} from '@ai-usage/local-collectors/sync-storage';
import { Console, Effect } from 'effect';
import type { SyncArgs } from './cli';
import { CliArgumentError } from './errors';
import { pad, trunc } from './render/format';
import { fetchRemoteSnapshot } from './snapshot-transport';

const renderSyncHelp = () =>
  [
    'No sync remotes configured.',
    '',
    'On the other machine, run:',
    '  ai-usage serve --host 0.0.0.0 --token <secret>',
    '',
    'On this machine, store the token in your shell or ~/.config/ai-usage/.env:',
    '  AI_USAGE_SYNC_MACBOOK_TOKEN=<secret>',
    '',
    'Then add and pull the remote:',
    '  ai-usage sync add macbook http://<other-machine-ip>:3847/snapshot --token-env AI_USAGE_SYNC_MACBOOK_TOKEN',
    '  ai-usage sync pull macbook',
  ].join('\n');

const validateSyncUrl = (url: string) =>
  Effect.try({
    try: () => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error('URL must start with http:// or https://');
    },
    catch: (cause) =>
      new CliArgumentError({
        message: `Invalid sync URL ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const validateTokenEnv = (tokenEnv: string | null) =>
  Effect.try({
    try: () => {
      if (tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv))
        throw new Error('environment variable names may contain letters, digits, and underscores');
    },
    catch: (cause) =>
      new CliArgumentError({
        message: `Invalid --token-env ${tokenEnv}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const findRemote = (name: string) =>
  Effect.gen(function* () {
    const remotes = yield* listSyncRemotes;
    const remote = remotes.find((item) => item.name === name);
    if (!remote) {
      return yield* Effect.fail(new CliArgumentError({ message: `Unknown sync remote: ${name}` }));
    }
    return remote;
  });

const tokenForRemote = (remote: SyncRemoteConfig) =>
  Effect.gen(function* () {
    const token = yield* resolveSyncToken(remote.tokenEnv);
    if (remote.tokenEnv && !token) {
      return yield* Effect.fail(
        new CliArgumentError({
          message: `Missing token env ${remote.tokenEnv}. Set it in your shell or ~/.config/ai-usage/.env.`,
        }),
      );
    }
    return token;
  });

const pullSyncRemote = (remote: SyncRemoteConfig) =>
  Effect.gen(function* () {
    const started = Date.now();
    yield* Console.log(`[sync] pulling remote=${remote.name} url=${remote.url}`);
    const token = yield* tokenForRemote(remote);
    const snapshot = yield* fetchRemoteSnapshot(remote.url, token);
    const localMachine = yield* ensureMachineConfig;
    if (snapshot.machine.id === localMachine.id) {
      return yield* Effect.fail(
        new CliArgumentError({
          message: `Refusing to sync remote ${remote.name}: snapshot machine id matches this machine (${localMachine.id}).`,
        }),
      );
    }
    yield* Console.log(
      `[sync] fetched remote=${remote.name} machine=${snapshot.machine.label} rows=${snapshot.rows.length} generatedAt=${snapshot.generatedAt}`,
    );
    const record = yield* storeSyncedSnapshot({ remote, snapshot });
    const storage = yield* LocalHistoryStorage;
    return { record, path: syncedSnapshotPath(storage, remote.name), durationMs: Date.now() - started };
  });

const renderSyncList = (remotes: SyncRemoteConfig[], records: StoredSyncedSnapshot[]) => {
  if (!remotes.length) return renderSyncHelp();
  const byName = new Map(records.map((record) => [record.remoteName, record]));
  const cols = [
    { h: 'Name', w: 16, f: (r: SyncRemoteConfig) => r.name },
    { h: 'Enabled', w: 7, f: (r: SyncRemoteConfig) => (r.enabled === false ? 'no' : 'yes') },
    { h: 'Token', w: 28, f: (r: SyncRemoteConfig) => r.tokenEnv ?? 'none' },
    { h: 'Machine', w: 22, f: (r: SyncRemoteConfig) => byName.get(r.name)?.snapshot.machine.label ?? 'not pulled' },
    { h: 'Rows', w: 8, r: true, f: (r: SyncRemoteConfig) => String(byName.get(r.name)?.snapshot.rows.length ?? 0) },
    { h: 'Fetched', w: 24, f: (r: SyncRemoteConfig) => byName.get(r.name)?.fetchedAt ?? 'never' },
    { h: 'URL', w: 44, f: (r: SyncRemoteConfig) => r.url },
  ];
  const header = cols.map((col) => pad(col.h, col.w, col.r)).join('  ');
  const body = remotes.map((remote) => cols.map((col) => pad(trunc(col.f(remote), col.w), col.w, col.r)).join('  '));
  return [header, ...body].join('\n');
};

const readSyncedRecordsForCli = () =>
  Effect.gen(function* () {
    const result = yield* readSyncedSnapshotRecords;
    return result.records;
  });

const syncRemotesToPull = (args: Extract<SyncArgs, { action: 'pull' | 'watch' }>) =>
  Effect.gen(function* () {
    if (args.name) return [yield* findRemote(args.name)];
    const remotes = (yield* listSyncRemotes).filter((remote) => remote.enabled !== false);
    if (!remotes.length) return yield* Effect.fail(new CliArgumentError({ message: renderSyncHelp() }));
    return remotes;
  });

export const applyPullTokenEnvOverride = (remotes: SyncRemoteConfig[], tokenEnv: string | null): SyncRemoteConfig[] =>
  tokenEnv ? remotes.map((remote) => ({ ...remote, tokenEnv })) : remotes;

const sleep = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

const runSyncWatch = (args: Extract<SyncArgs, { action: 'watch' }>) =>
  Effect.gen(function* () {
    const remotes = yield* syncRemotesToPull(args);
    yield* Console.log(
      `[sync] watching ${remotes.map((remote) => remote.name).join(', ')} interval=${Math.round(args.intervalMs / 1000)}s`,
    );
    while (true) {
      for (const remote of remotes) {
        yield* pullSyncRemote(remote).pipe(
          Effect.catchAll((error) => Console.error(`[sync] pull failed remote=${remote.name}: ${error.message}`)),
        );
      }
      yield* sleep(args.intervalMs);
    }
  });

export const runSyncCommand = (args: SyncArgs) =>
  Effect.gen(function* () {
    if (args.action === 'help') {
      yield* Console.log(renderSyncHelp());
      return;
    }

    if (args.action === 'add') {
      yield* validateSyncUrl(args.url);
      yield* validateTokenEnv(args.tokenEnv);
      const remote = { name: args.name, url: args.url, ...(args.tokenEnv ? { tokenEnv: args.tokenEnv } : {}) };
      yield* upsertSyncRemote(remote);
      yield* Console.log(`Added sync remote ${args.name}`);
      if (args.tokenEnv) {
        yield* Console.log(`Token env: ${args.tokenEnv}`);
      }
      yield* Console.log(`Next: ai-usage sync pull ${args.name}`);
      return;
    }

    if (args.action === 'list') {
      const remotes = yield* listSyncRemotes;
      const records = yield* readSyncedRecordsForCli();
      yield* Console.log(renderSyncList(remotes, records));
      return;
    }

    if (args.action === 'remove') {
      const removed = yield* removeSyncRemote(args.name);
      yield* Console.log(removed ? `Removed sync remote ${args.name}` : `Sync remote not found: ${args.name}`);
      return;
    }

    if (args.action === 'pull') {
      yield* validateTokenEnv(args.tokenEnv);
      const remotes = args.remote
        ? [{ name: args.name!, url: args.remote, ...(args.tokenEnv ? { tokenEnv: args.tokenEnv } : {}) }]
        : applyPullTokenEnvOverride(yield* syncRemotesToPull(args), args.tokenEnv);
      for (const remote of remotes) {
        const { record, path, durationMs } = yield* pullSyncRemote(remote);
        yield* Console.log(
          `[sync] stored remote=${record.remoteName} path=${path} fetchedAt=${record.fetchedAt} duration=${durationMs}ms`,
        );
      }
      return;
    }

    if (args.action === 'watch') {
      yield* runSyncWatch(args);
    }
  });
