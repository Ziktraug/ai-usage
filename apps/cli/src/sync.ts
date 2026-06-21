import {
  addSyncRemote,
  applyPullTokenEnvOverride,
  getSyncState,
  pullSyncRemote,
  removeConfiguredSyncRemote,
  selectSyncRemotesToPull,
  validateTokenEnv,
} from '@ai-usage/sync';
import { SyncWorkflowError } from '@ai-usage/sync/errors';
import type { SyncRemoteState, SyncState } from '@ai-usage/sync/state';
import { Console, Effect } from 'effect';
import type { SyncArgs } from './cli';
import { CliArgumentError } from './errors';
import { pad, trunc } from './render/format';

const renderSyncHelp = () =>
  [
    'No sync remotes configured.',
    '',
    'On the other machine, run:',
    '  ai-usage serve --host 0.0.0.0 --token <secret>',
    '  # Keep it running and copy one of the printed http://...:3847/snapshot URLs.',
    '',
    'On this machine, store the token in your shell or ~/.config/ai-usage/.env:',
    '  AI_USAGE_SYNC_MACBOOK_TOKEN=<secret>',
    '',
    'Then add and pull the remote:',
    '  ai-usage sync add macbook http://<other-machine-ip>:3847/snapshot --token-env AI_USAGE_SYNC_MACBOOK_TOKEN',
    '  ai-usage sync pull macbook',
    '',
    'Or test the URL once before saving it:',
    '  ai-usage sync pull --name macbook --remote http://<other-machine-ip>:3847/snapshot --token-env AI_USAGE_SYNC_MACBOOK_TOKEN',
  ].join('\n');

const noRemoteHelp = (error: unknown) =>
  error instanceof SyncWorkflowError && error.reason === 'no-remotes'
    ? new CliArgumentError({ message: renderSyncHelp() })
    : error;

const syncRemotesToPull = (args: Extract<SyncArgs, { action: 'pull' | 'watch' }>) =>
  selectSyncRemotesToPull(args.name).pipe(Effect.mapError(noRemoteHelp));

const renderSyncList = (state: SyncState) => {
  if (!state.remotes.length) {
    return renderSyncHelp();
  }
  const cols = [
    { h: 'Name', w: 16, f: (r: SyncRemoteState) => r.name },
    { h: 'Enabled', w: 7, f: (r: SyncRemoteState) => (r.enabled ? 'yes' : 'no') },
    { h: 'Token', w: 28, f: (r: SyncRemoteState) => r.tokenEnv ?? r.tokenStatus },
    { h: 'Machine', w: 22, f: (r: SyncRemoteState) => r.machineLabel ?? 'not pulled' },
    { h: 'Rows', w: 8, r: true, f: (r: SyncRemoteState) => String(r.rows) },
    { h: 'Fetched', w: 24, f: (r: SyncRemoteState) => r.fetchedAt ?? 'never' },
    { h: 'URL', w: 44, f: (r: SyncRemoteState) => r.url },
  ];
  const header = cols.map((col) => pad(col.h, col.w, col.r)).join('  ');
  const body = state.remotes.map((remote) =>
    cols.map((col) => pad(trunc(col.f(remote), col.w), col.w, col.r)).join('  '),
  );
  return [header, ...body].join('\n');
};

const sleep = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

const runSyncWatch = (args: Extract<SyncArgs, { action: 'watch' }>) =>
  Effect.gen(function* () {
    const remotes = yield* syncRemotesToPull(args);
    yield* Console.log(
      `[sync] watching ${remotes.map((remote) => remote.name).join(', ')} interval=${Math.round(args.intervalMs / 1000)}s`,
    );
    while (true) {
      for (const remote of remotes) {
        yield* Console.log(`[sync] pulling remote=${remote.name} url=${remote.url}`);
        yield* pullSyncRemote(remote).pipe(
          Effect.tap(({ record }) =>
            Console.log(
              `[sync] fetched remote=${remote.name} machine=${record.snapshot.machine.label} rows=${record.snapshot.rows.length} generatedAt=${record.snapshot.generatedAt}`,
            ),
          ),
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
      yield* addSyncRemote({ name: args.name, url: args.url, tokenEnv: args.tokenEnv });
      yield* Console.log(`Added sync remote ${args.name}`);
      if (args.tokenEnv) {
        yield* Console.log(`Token env: ${args.tokenEnv}`);
      }
      yield* Console.log(`Next: ai-usage sync pull ${args.name}`);
      return;
    }

    if (args.action === 'list') {
      yield* Console.log(renderSyncList(yield* getSyncState));
      return;
    }

    if (args.action === 'remove') {
      const removed = yield* removeConfiguredSyncRemote(args.name);
      yield* Console.log(removed ? `Removed sync remote ${args.name}` : `Sync remote not found: ${args.name}`);
      return;
    }

    if (args.action === 'pull') {
      yield* validateTokenEnv(args.tokenEnv);
      const remotes = args.remote
        ? [{ name: args.name!, url: args.remote, ...(args.tokenEnv ? { tokenEnv: args.tokenEnv } : {}) }]
        : applyPullTokenEnvOverride(yield* syncRemotesToPull(args), args.tokenEnv);
      for (const remote of remotes) {
        yield* Console.log(`[sync] pulling remote=${remote.name} url=${remote.url}`);
        const { record, path, durationMs } = yield* pullSyncRemote(remote);
        yield* Console.log(
          `[sync] fetched remote=${remote.name} machine=${record.snapshot.machine.label} rows=${record.snapshot.rows.length} generatedAt=${record.snapshot.generatedAt}`,
        );
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
