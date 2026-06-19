import { type HarnessKey, harnessKeyList, harnessLabelList, isHarnessKey } from '@ai-usage/core/harness-metadata';
import type { ReportOptions, SortKey } from '@ai-usage/core/report-data';
import { Effect } from 'effect';
import { CliArgumentError } from './errors';

export type OutputFormat = 'table' | 'json' | 'csv' | 'html' | 'payload';

export interface Args extends ReportOptions {
  harness: HarnessKey | null;
  format: OutputFormat;
  cursor: boolean;
  color: boolean | null;
  wide: boolean;
  synced?: boolean;
}

export interface SnapshotArgs {
  out: string;
  harness: HarnessKey | null;
  cursor: boolean;
}

export interface MergeArgs extends Args {
  files: string[];
  local: boolean;
  remote: string[];
  token: string | null;
}

export interface ServeArgs {
  host: string;
  port: number;
  token: string | null;
  harness: HarnessKey | null;
  cursor: boolean;
}

export interface ProjectsListArgs {
  files: string[];
  local: boolean;
  paths: boolean;
}

export interface SetupArgs {
  files: string[];
  local: boolean;
  port: number;
}

export interface CursorImportArgs {
  file: string;
}

export type SyncArgs =
  | { action: 'help' }
  | { action: 'add'; name: string; url: string; tokenEnv: string | null }
  | { action: 'list' }
  | { action: 'remove'; name: string }
  | { action: 'pull'; name: string | null; all: boolean; remote: string | null; tokenEnv: string | null }
  | { action: 'watch'; name: string | null; all: boolean; intervalMs: number };

export type CliCommand =
  | { _tag: 'Help' }
  | { _tag: 'Quota'; color: boolean | null }
  | { _tag: 'Report'; args: Args }
  | { _tag: 'Snapshot'; args: SnapshotArgs }
  | { _tag: 'Merge'; args: MergeArgs }
  | { _tag: 'Serve'; args: ServeArgs }
  | { _tag: 'Machine' }
  | { _tag: 'MachineSetLabel'; label: string }
  | { _tag: 'ProjectsList'; args: ProjectsListArgs }
  | { _tag: 'Setup'; args: SetupArgs }
  | { _tag: 'CursorImport'; args: CursorImportArgs }
  | { _tag: 'Sync'; args: SyncArgs };

const cliArgumentError = (message: string) => new CliArgumentError({ message });

const parseDuration = (v: string): Effect.Effect<Date, CliArgumentError> => {
  const m = /^(\d+)([hdw])$/.exec(v);
  if (!m) return Effect.fail(cliArgumentError('--since expects e.g. 24h, 30d, 12w'));
  const mult = { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2] as 'h' | 'd' | 'w'];
  return Effect.succeed(new Date(Date.now() - Number(m[1]) * mult));
};

const parseRequiredValue = (rest: string[], name: string): Effect.Effect<string, CliArgumentError> => {
  const value = rest.shift();
  return !value || value.startsWith('--')
    ? Effect.fail(cliArgumentError(`${name} expects a value`))
    : Effect.succeed(value);
};

const parsePositiveInt = (value: string, name: string): Effect.Effect<number, CliArgumentError> => {
  const n = Number.parseInt(value, 10);
  return !Number.isInteger(n) || n < 1 || String(n) !== value
    ? Effect.fail(cliArgumentError(`${name} expects a positive integer`))
    : Effect.succeed(n);
};

const parseSort = (value: string): Effect.Effect<SortKey, CliArgumentError> => {
  if (value === 'date' || value === 'tokens' || value === 'cost') return Effect.succeed(value);
  return Effect.fail(cliArgumentError('--sort expects one of: date, tokens, cost'));
};

const setOutputFormat = (args: Args, format: Exclude<OutputFormat, 'table'>): Effect.Effect<void, CliArgumentError> => {
  if (args.format !== 'table')
    return Effect.fail(cliArgumentError('--json, --csv, --html, and --payload-json are mutually exclusive'));
  args.format = format;
  return Effect.void;
};

const parseHarness = (value: string): Effect.Effect<HarnessKey, CliArgumentError> => {
  const h = value.toLowerCase();
  return isHarnessKey(h)
    ? Effect.succeed(h)
    : Effect.fail(cliArgumentError(`--harness expects one of: ${harnessKeyList}`));
};

export const helpText =
  `ai-usage — per-session token usage across ${harnessLabelList}\n\n` +
  `Usage: bun ai-usage.ts [report] [options]   |   bun ai-usage.ts quota [--color|--no-color]\n\n` +
  `Subcommands:\n` +
  `  report (default)       per-session table + data analysis\n` +
  `  snapshot               write a portable usage snapshot\n` +
  `  merge                  merge usage snapshots into a report\n` +
  `  serve                  serve this machine's snapshot over HTTP\n` +
  `  sync                   persist remote snapshots for future reports\n` +
  `  machine                show or update this machine identity\n` +
  `  projects list          summarize detected projects\n` +
  `  cursor import <csv>    copy a Cursor usage export into local ignored storage\n` +
  `  setup --web            launch project alias setup UI\n` +
  `  quota                  Codex subscription quota (5h / 7d usage)\n\n` +
  `Options:\n` +
  `  --since <30d|12w|24h>  only sessions active since\n` +
  `  --harness <name>       ${harnessKeyList}\n` +
  `  --project <name>       filter by project dir basename (substring)\n` +
  `  --min-tokens <n>       hide sessions below n total tokens (default 1)\n` +
  `  --limit <n>            show only n table rows (analysis covers all)\n` +
  `  --sort date|tokens|cost\n` +
  `  --wide                 add Dur / Turns / Tools / ±Lines columns\n` +
  `  --no-synced            exclude stored synced snapshots from report\n` +
  `  --no-cursor            skip Cursor (local data is partial)\n` +
  `  --no-color / --color   disable / force ANSI colors (default: auto)\n` +
  `  --json | --csv | --html\n` +
  `  --payload-json         full report payload JSON (consumed by the report dev server)\n` +
  `\nSnapshot:\n` +
  `  snapshot --out <file>  export local usage rows with machine provenance\n` +
  `\nMerge:\n` +
  `  merge [files...]       merge snapshot files\n` +
  `  merge --local          include this machine's local history\n` +
  `  merge --remote <url>   fetch snapshot from a serve instance\n` +
  `\nServe:\n` +
  `  serve                  serve this machine's snapshot on LAN\n` +
  `  serve --host 0.0.0.0   bind to all interfaces (default: localhost)\n` +
  `  serve --port 3847      listen port (default: 3847)\n` +
  `  serve --token <secret> required when binding outside localhost\n` +
  `\nSync:\n` +
  `  sync add <name> <url> --token-env <env>\n` +
  `  sync pull [name] | --all\n` +
  `  sync pull --name <name> --remote <url> --token-env <env>\n` +
  `  sync watch [name] | --all --interval 60s\n` +
  `  sync list\n` +
  `  sync remove <name>\n` +
  `\nMachine:\n` +
  `  machine                show this machine id and label\n` +
  `  machine set-label <x>  update this machine label\n` +
  `\nProjects:\n` +
  `  projects list --paths [files...] [--local]\n` +
  `\nCursor:\n` +
  `  cursor import <csv>    import a cursor.com usage-events CSV export\n` +
  `\nSetup:\n` +
  `  setup --web [files...] [--local] [--port 3456]\n`;

export const parseArgs = (argv: string[]): Effect.Effect<Args, CliArgumentError> =>
  Effect.gen(function* () {
    const args: Args = {
      since: null,
      harness: null,
      project: null,
      limit: null,
      minTokens: 1,
      format: 'table',
      cursor: true,
      color: null,
      wide: false,
      sort: 'date',
      synced: true,
    };
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--since') args.since = yield* parseDuration(yield* parseRequiredValue(rest, '--since'));
      else if (arg === '--harness') args.harness = yield* parseHarness(yield* parseRequiredValue(rest, '--harness'));
      else if (arg === '--project') args.project = (yield* parseRequiredValue(rest, '--project')).toLowerCase();
      else if (arg === '--limit')
        args.limit = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--limit'), '--limit');
      else if (arg === '--min-tokens')
        args.minTokens = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--min-tokens'), '--min-tokens');
      else if (arg === '--json') yield* setOutputFormat(args, 'json');
      else if (arg === '--csv') yield* setOutputFormat(args, 'csv');
      else if (arg === '--html') yield* setOutputFormat(args, 'html');
      else if (arg === '--payload-json') yield* setOutputFormat(args, 'payload');
      else if (arg === '--no-cursor') args.cursor = false;
      else if (arg === '--no-color') args.color = false;
      else if (arg === '--color') args.color = true;
      else if (arg === '--wide') args.wide = true;
      else if (arg === '--no-synced') args.synced = false;
      else if (arg === '--sort') args.sort = yield* parseSort(yield* parseRequiredValue(rest, '--sort'));
      else if (arg === '-h' || arg === '--help')
        return yield* Effect.fail(cliArgumentError('Help is a command-level flag'));
      else return yield* Effect.fail(cliArgumentError(`Unknown option: ${arg}`));
    }
    return args;
  });

const parseQuotaArgs = (argv: string[]): Effect.Effect<{ color: boolean | null }, CliArgumentError> =>
  Effect.gen(function* () {
    let color: boolean | null = null;
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--no-color') color = false;
      else if (arg === '--color') color = true;
      else if (arg === '-h' || arg === '--help')
        return yield* Effect.fail(cliArgumentError('Help is a command-level flag'));
      else return yield* Effect.fail(cliArgumentError(`Unknown option for quota: ${arg}`));
    }
    return { color };
  });

const parseSnapshotArgs = (argv: string[]): Effect.Effect<SnapshotArgs, CliArgumentError> =>
  Effect.gen(function* () {
    const args: SnapshotArgs = { out: '', harness: null, cursor: true };
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--out') args.out = yield* parseRequiredValue(rest, '--out');
      else if (arg === '--harness') args.harness = yield* parseHarness(yield* parseRequiredValue(rest, '--harness'));
      else if (arg === '--no-cursor') args.cursor = false;
      else return yield* Effect.fail(cliArgumentError(`Unknown option for snapshot: ${arg}`));
    }
    if (!args.out) return yield* Effect.fail(cliArgumentError('snapshot expects --out <file>'));
    return args;
  });

const parseMergeArgs = (argv: string[]): Effect.Effect<MergeArgs, CliArgumentError> =>
  Effect.gen(function* () {
    const baseArgs = yield* parseArgs([]);
    const args: MergeArgs = { ...baseArgs, files: [], local: false, remote: [], token: null };
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--local') args.local = true;
      else if (arg === '--remote') args.remote.push(yield* parseRequiredValue(rest, '--remote'));
      else if (arg === '--token') args.token = yield* parseRequiredValue(rest, '--token');
      else if (arg === '--since') args.since = yield* parseDuration(yield* parseRequiredValue(rest, '--since'));
      else if (arg === '--harness') args.harness = yield* parseHarness(yield* parseRequiredValue(rest, '--harness'));
      else if (arg === '--project') args.project = (yield* parseRequiredValue(rest, '--project')).toLowerCase();
      else if (arg === '--limit')
        args.limit = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--limit'), '--limit');
      else if (arg === '--min-tokens')
        args.minTokens = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--min-tokens'), '--min-tokens');
      else if (arg === '--json') yield* setOutputFormat(args, 'json');
      else if (arg === '--csv') yield* setOutputFormat(args, 'csv');
      else if (arg === '--html') yield* setOutputFormat(args, 'html');
      else if (arg === '--payload-json') yield* setOutputFormat(args, 'payload');
      else if (arg === '--no-cursor') args.cursor = false;
      else if (arg === '--no-color') args.color = false;
      else if (arg === '--color') args.color = true;
      else if (arg === '--wide') args.wide = true;
      else if (arg === '--no-synced') args.synced = false;
      else if (arg === '--sort') args.sort = yield* parseSort(yield* parseRequiredValue(rest, '--sort'));
      else if (arg.startsWith('--')) return yield* Effect.fail(cliArgumentError(`Unknown option for merge: ${arg}`));
      else args.files.push(arg);
    }
    if (!args.local && args.files.length === 0 && args.remote.length === 0)
      return yield* Effect.fail(cliArgumentError('merge expects files, --remote, or --local'));
    return args;
  });

const parseMachineCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    if (!rest.length) return { _tag: 'Machine' };
    const subcommand = rest.shift();
    if (subcommand === 'set-label') {
      const label = yield* parseRequiredValue(rest, 'machine set-label');
      if (rest.length) return yield* Effect.fail(cliArgumentError(`Unknown option for machine set-label: ${rest[0]}`));
      return { _tag: 'MachineSetLabel', label };
    }
    return yield* Effect.fail(cliArgumentError(`Unknown machine subcommand: ${subcommand}`));
  });

const parseProjectsListArgs = (argv: string[]): Effect.Effect<ProjectsListArgs, CliArgumentError> =>
  Effect.gen(function* () {
    const args: ProjectsListArgs = { files: [], local: false, paths: false };
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--local') args.local = true;
      else if (arg === '--paths') args.paths = true;
      else if (arg.startsWith('--'))
        return yield* Effect.fail(cliArgumentError(`Unknown option for projects list: ${arg}`));
      else args.files.push(arg);
    }
    if (!args.paths) return yield* Effect.fail(cliArgumentError('projects list expects --paths'));
    if (!args.local && args.files.length === 0)
      return yield* Effect.fail(cliArgumentError('projects list expects files or --local'));
    return args;
  });

const parseProjectsCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    const subcommand = rest.shift();
    if (subcommand === 'list') return { _tag: 'ProjectsList', args: yield* parseProjectsListArgs(rest) };
    return yield* Effect.fail(cliArgumentError(`Unknown projects subcommand: ${subcommand ?? ''}`.trim()));
  });

const parseCursorCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    const subcommand = rest.shift();
    if (subcommand === 'import') {
      const file = yield* parseRequiredValue(rest, 'cursor import');
      if (rest.length) return yield* Effect.fail(cliArgumentError(`Unknown option for cursor import: ${rest[0]}`));
      return { _tag: 'CursorImport', args: { file } };
    }
    return yield* Effect.fail(cliArgumentError(`Unknown cursor subcommand: ${subcommand ?? ''}`.trim()));
  });

const parseSetupArgs = (argv: string[]): Effect.Effect<SetupArgs, CliArgumentError> =>
  Effect.gen(function* () {
    const args: SetupArgs = { files: [], local: false, port: 3456 };
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--local') args.local = true;
      else if (arg === '--port')
        args.port = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--port'), '--port');
      else if (arg.startsWith('--')) return yield* Effect.fail(cliArgumentError(`Unknown option for setup: ${arg}`));
      else args.files.push(arg);
    }
    if (!args.local && args.files.length === 0)
      return yield* Effect.fail(cliArgumentError('setup expects files or --local'));
    return args;
  });

const parseServeArgs = (argv: string[]): Effect.Effect<ServeArgs, CliArgumentError> =>
  Effect.gen(function* () {
    const args: ServeArgs = { host: 'localhost', port: 3847, token: null, harness: null, cursor: true };
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--host') args.host = yield* parseRequiredValue(rest, '--host');
      else if (arg === '--port')
        args.port = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--port'), '--port');
      else if (arg === '--token') args.token = yield* parseRequiredValue(rest, '--token');
      else if (arg === '--harness') args.harness = yield* parseHarness(yield* parseRequiredValue(rest, '--harness'));
      else if (arg === '--no-cursor') args.cursor = false;
      else return yield* Effect.fail(cliArgumentError(`Unknown option for serve: ${arg}`));
    }
    if (args.host !== 'localhost' && args.host !== '127.0.0.1' && args.host !== '::1' && !args.token)
      return yield* Effect.fail(cliArgumentError('serve requires --token when binding outside localhost'));
    return args;
  });

const parseInterval = (value: string): Effect.Effect<number, CliArgumentError> => {
  const m = /^(\d+)(ms|s|m)?$/.exec(value);
  if (!m) return Effect.fail(cliArgumentError('--interval expects e.g. 60s, 5m, or 30000ms'));
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2] ?? 'ms';
  const mult = unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  return Effect.succeed(n * mult);
};

const parseSyncArgs = (argv: string[]): Effect.Effect<SyncArgs, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    const action = rest.shift();
    if (!action) return { action: 'help' };

    if (action === 'add') {
      const name = yield* parseRequiredValue(rest, 'sync add <name>');
      const url = yield* parseRequiredValue(rest, 'sync add <url>');
      let tokenEnv: string | null = null;
      while (rest.length) {
        const arg = rest.shift()!;
        if (arg === '--token-env') tokenEnv = yield* parseRequiredValue(rest, '--token-env');
        else return yield* Effect.fail(cliArgumentError(`Unknown option for sync add: ${arg}`));
      }
      return { action: 'add', name, url, tokenEnv };
    }

    if (action === 'list') {
      if (rest.length) return yield* Effect.fail(cliArgumentError(`Unknown option for sync list: ${rest[0]}`));
      return { action: 'list' };
    }

    if (action === 'remove') {
      const name = yield* parseRequiredValue(rest, 'sync remove <name>');
      if (rest.length) return yield* Effect.fail(cliArgumentError(`Unknown option for sync remove: ${rest[0]}`));
      return { action: 'remove', name };
    }

    if (action === 'pull') {
      let name: string | null = null;
      let remote: string | null = null;
      let tokenEnv: string | null = null;
      let all = false;
      while (rest.length) {
        const arg = rest.shift()!;
        if (arg === '--all') all = true;
        else if (arg === '--remote') remote = yield* parseRequiredValue(rest, '--remote');
        else if (arg === '--name') name = yield* parseRequiredValue(rest, '--name');
        else if (arg === '--token-env') tokenEnv = yield* parseRequiredValue(rest, '--token-env');
        else if (arg.startsWith('--')) return yield* Effect.fail(cliArgumentError(`Unknown option for sync pull: ${arg}`));
        else if (!name) name = arg;
        else return yield* Effect.fail(cliArgumentError(`Unexpected argument for sync pull: ${arg}`));
      }
      if (all && (name || remote)) return yield* Effect.fail(cliArgumentError('sync pull --all cannot be combined with a remote name or --remote'));
      if (remote && !name) return yield* Effect.fail(cliArgumentError('sync pull --remote expects --name <name>'));
      return { action: 'pull', name, all, remote, tokenEnv };
    }

    if (action === 'watch') {
      let name: string | null = null;
      let all = false;
      let intervalMs = 60_000;
      while (rest.length) {
        const arg = rest.shift()!;
        if (arg === '--all') all = true;
        else if (arg === '--interval') intervalMs = yield* parseInterval(yield* parseRequiredValue(rest, '--interval'));
        else if (arg.startsWith('--')) return yield* Effect.fail(cliArgumentError(`Unknown option for sync watch: ${arg}`));
        else if (!name) name = arg;
        else return yield* Effect.fail(cliArgumentError(`Unexpected argument for sync watch: ${arg}`));
      }
      if (all && name) return yield* Effect.fail(cliArgumentError('sync watch --all cannot be combined with a remote name'));
      if (intervalMs < 30_000) return yield* Effect.fail(cliArgumentError('sync watch --interval must be at least 30s'));
      return { action: 'watch', name, all, intervalMs };
    }

    return yield* Effect.fail(cliArgumentError(`Unknown sync subcommand: ${action}`));
  });

export const parseCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    if (rest.includes('-h') || rest.includes('--help')) return { _tag: 'Help' };
    const command = rest[0];
    if (command === 'quota') {
      rest.shift();
      return { _tag: 'Quota', ...(yield* parseQuotaArgs(rest)) };
    }
    if (command === 'snapshot') {
      rest.shift();
      return { _tag: 'Snapshot', args: yield* parseSnapshotArgs(rest) };
    }
    if (command === 'merge') {
      rest.shift();
      return { _tag: 'Merge', args: yield* parseMergeArgs(rest) };
    }
    if (command === 'machine') {
      rest.shift();
      return yield* parseMachineCommand(rest);
    }
    if (command === 'projects') {
      rest.shift();
      return yield* parseProjectsCommand(rest);
    }
    if (command === 'cursor') {
      rest.shift();
      return yield* parseCursorCommand(rest);
    }
    if (command === 'setup') {
      rest.shift();
      return { _tag: 'Setup', args: yield* parseSetupArgs(rest) };
    }
    if (command === 'serve') {
      rest.shift();
      return { _tag: 'Serve', args: yield* parseServeArgs(rest) };
    }
    if (command === 'sync') {
      rest.shift();
      return { _tag: 'Sync', args: yield* parseSyncArgs(rest) };
    }
    if (command === 'report') rest.shift();
    return { _tag: 'Report', args: yield* parseArgs(rest) };
  });
