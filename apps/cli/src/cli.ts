import { isDelegationIdempotencyKey, isDelegationUuid } from '@ai-usage/report-core/delegation-request';
import {
  DELEGATION_ABSTENTION_REASONS,
  type DelegationAbstentionReason,
} from '@ai-usage/report-core/delegation-vocabulary';
import {
  type HarnessKey,
  harnessKeyList,
  harnessLabelList,
  isHarnessKey,
} from '@ai-usage/report-core/harness-metadata';
import type { ReportOptions, SortKey } from '@ai-usage/report-core/report-data';
import { Effect } from 'effect';
import { CliArgumentError } from './errors';

export type OutputFormat = 'table' | 'json' | 'csv' | 'payload';

export interface Args extends ReportOptions {
  color: boolean | null;
  cursor: boolean;
  format: OutputFormat;
  harness: HarnessKey | null;
  stored: boolean;
  wide: boolean;
}

export interface SnapshotArgs {
  cursor: boolean;
  harness: HarnessKey | null;
  out: string;
}

export interface MergeArgs extends Args {
  files: string[];
  local: boolean;
}

export interface ProjectsListArgs {
  files: string[];
  local: boolean;
  paths: boolean;
}

export interface CursorImportArgs {
  file: string;
}

export interface MemorySearchArgs {
  cursor: string | null;
  includeSpaceWide: boolean;
  json: boolean;
  limit: number;
  matchingMode: 'hybrid' | 'literal';
  projectId: string | null;
  query: string;
}

export interface ReplicationStatusArgs {
  json: boolean;
}

export interface WorkContextArgs {
  json: boolean;
  /** As given: a relative checkout path is resolved against the operator's working directory. */
  scope: { checkoutPath: string; kind: 'checkout' } | { kind: 'project-label'; projectLabel: string };
}

export interface DelegationQualifyArgs {
  json: boolean;
  /** A JSON request file path (relative to the operator's working directory) or `-` for stdin. */
  request: string;
  /** Record the qualification as a simulation: same function, nothing is meant to start from it. */
  simulation: boolean;
}

/** What the operator chose: a route (the CLI is then the selector) or an abstention with its reason. */
export type DelegationSelectionArgs =
  | { confidence: number | null; kind: 'route'; routeId: string; selectorVersion: string }
  | { kind: 'abstain'; reason: DelegationAbstentionReason };

export interface DelegationStartArgs {
  json: boolean;
  key: string;
  qualification: string;
  request: string;
  selection: DelegationSelectionArgs;
}

export interface DelegationJobArgs {
  jobId: string;
  json: boolean;
}

export interface DelegationListArgs {
  json: boolean;
  limit: number | null;
  live: boolean;
}

export type QuotaHistoryRange = '24h' | '7d' | '30d';

export const QUOTA_HISTORY_RANGES = ['24h', '7d', '30d'] as const satisfies readonly QuotaHistoryRange[];

const DEFAULT_QUOTA_HISTORY_RANGE: QuotaHistoryRange = '7d';

const isQuotaHistoryRange = (value: string): value is QuotaHistoryRange =>
  (QUOTA_HISTORY_RANGES as readonly string[]).includes(value);

export interface QuotaArgs {
  color: boolean | null;
  history: QuotaHistoryRange | null;
  /** Emit the versioned provider-status dataset instead of the terminal view. */
  json: boolean;
  /** Read the newest stored observation per provider without issuing collect-fresh-quota. */
  stored: boolean;
}

export type CliCommand =
  | { _tag: 'Help' }
  | ({ _tag: 'Quota' } & QuotaArgs)
  | { _tag: 'Report'; args: Args }
  | { _tag: 'Snapshot'; args: SnapshotArgs }
  | { _tag: 'Merge'; args: MergeArgs }
  | { _tag: 'Machine' }
  | { _tag: 'MachineSetLabel'; label: string }
  | { _tag: 'MemorySearch'; args: MemorySearchArgs }
  | { _tag: 'ReplicationStatus'; args: ReplicationStatusArgs }
  | { _tag: 'WorkContext'; args: WorkContextArgs }
  | { _tag: 'DelegationQualify'; args: DelegationQualifyArgs }
  | { _tag: 'DelegationStart'; args: DelegationStartArgs }
  | { _tag: 'DelegationStatus'; args: DelegationJobArgs }
  | { _tag: 'DelegationList'; args: DelegationListArgs }
  | { _tag: 'DelegationCancel'; args: DelegationJobArgs }
  | { _tag: 'ProjectsList'; args: ProjectsListArgs }
  | { _tag: 'CursorImport'; args: CursorImportArgs };

const cliArgumentError = (message: string) => new CliArgumentError({ message });

const DURATION_PATTERN = /^(\d+)([hdw])$/;

const parseDuration = (v: string): Effect.Effect<Date, CliArgumentError> => {
  const m = DURATION_PATTERN.exec(v);
  if (!m) {
    return Effect.fail(cliArgumentError('--since expects e.g. 24h, 30d, 12w'));
  }
  const mult = { h: 3600e3, d: 86_400e3, w: 604_800e3 }[m[2] as 'h' | 'd' | 'w'];
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
  if (value === 'date' || value === 'tokens' || value === 'cost') {
    return Effect.succeed(value);
  }
  return Effect.fail(cliArgumentError('--sort expects one of: date, tokens, cost'));
};

const setOutputFormat = (args: Args, format: Exclude<OutputFormat, 'table'>): Effect.Effect<void, CliArgumentError> => {
  if (args.format !== 'table') {
    return Effect.fail(cliArgumentError('--json, --csv, and --payload-json are mutually exclusive'));
  }
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
  'Usage: bun ai-usage.ts [report] [options]   |   bun ai-usage.ts quota [--stored] [--json]\n\n' +
  'Subcommands:\n' +
  '  report (default)       per-session table + data analysis\n' +
  '  snapshot               write a portable usage snapshot\n' +
  '  merge                  merge usage snapshots into a report\n' +
  '  machine                show or update this machine identity\n' +
  '  memory search <query>  search accepted local Memory\n' +
  '  replication status     show outbound publication state\n' +
  '  work context           stored Work context of one checkout or project\n' +
  '  delegation <command>   qualify, start, follow and cancel delegated read-only reviews\n' +
  '  projects list          summarize detected projects\n' +
  '  cursor import <csv>    copy a Cursor usage export into local ignored storage\n' +
  '  quota                  subscription quota per provider (Claude, Codex)\n\n' +
  'Options:\n' +
  '  --since <30d|12w|24h>  only sessions active since\n' +
  `  --harness <name>       ${harnessKeyList}\n` +
  '  --project <name>       filter by project dir basename (substring)\n' +
  '  --min-tokens <n>       hide sessions below n total tokens (default 1)\n' +
  '  --limit <n>            show only n table rows (analysis covers all)\n' +
  '  --sort date|tokens|cost\n' +
  '  --wide                 add Dur / Turns / Tools / ±Lines columns\n' +
  '  --no-cursor            skip Cursor (local data is partial)\n' +
  '  --stored               read the last compatible published revision without refreshing\n' +
  '  --no-color / --color   disable / force ANSI colors (default: auto)\n' +
  '  --json | --csv\n' +
  '  --payload-json         full report payload JSON for compatible consumers\n' +
  '\nQuota:\n' +
  '  quota                  refresh, then show the newest observation per provider\n' +
  '  quota --stored         show the newest stored observation per provider; starts no engine\n' +
  '  quota --json           print the newest observation per provider as a versioned JSON feed\n' +
  '                         (schemaVersion 1, stale state applied); combine with --stored\n' +
  '  quota --history [range]\n' +
  '                         trend from stored observations only (24h|7d|30d, default 7d)\n' +
  '                         (cannot be combined with --stored or --json)\n' +
  '\nSnapshot:\n' +
  '  snapshot --out <file>  export local usage rows with machine provenance\n' +
  '\nMerge:\n' +
  '  merge [files...]       merge snapshot files\n' +
  `  merge --local          include this machine's local history\n` +
  '\nMachine:\n' +
  '  machine                show this machine id and label\n' +
  '  machine set-label <x>  update this machine label\n' +
  '\nMemory:\n' +
  '  memory search <query> [--literal] [--project <id>] [--include-space-wide]\n' +
  '                         retrieve bounded accepted Memory cards\n' +
  '  --limit <n>            return 1..25 results (default 10)\n' +
  '  --cursor <cursor>      request the next page for the same query\n' +
  '  --json                 emit the exact search response contract\n' +
  '\nReplication:\n' +
  '  replication status [--json]\n' +
  '                         show content-free Usage and Memory outbox state\n' +
  '\nWork:\n' +
  '  work context (--checkout <path> | --project-label <name>) [--json]\n' +
  '                         waits, settled decisions, linked facts and coverage from\n' +
  '                         Claude Desktop sessions; reads the store only, starts no engine\n' +
  '\nDelegation (qualify, start and cancel need a running engine and never start one):\n' +
  '  delegation qualify --request <file|-> [--simulation] [--json]\n' +
  '                         admissible routes for a request (JSON file or stdin, at most 64 KiB)\n' +
  '  delegation start --request <file|-> --qualification <id> --key <idempotency-key>\n' +
  '                   (--route <id> [--selector-version <v>] [--confidence <0..1>] | --abstain <reason>)\n' +
  '                   [--json]  start the chosen route, or record an abstention\n' +
  '  delegation status <jobId> [--json]\n' +
  '                         one job: state, route, executed / verified / accepted; reads the store only\n' +
  '  delegation list [--live] [--limit <n>] [--json]\n' +
  '                         recent jobs, newest first; reads the store only\n' +
  '  delegation cancel <jobId> [--json]\n' +
  '                         stop a live job this engine runs\n' +
  '\nProjects:\n' +
  '  projects list --paths [files...] [--local]\n' +
  '\nCursor:\n' +
  '  cursor import <csv>    import a cursor.com usage-events CSV export\n';

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
      stored: false,
      wide: false,
      sort: 'date',
    };
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--since') {
        args.since = yield* parseDuration(yield* parseRequiredValue(rest, '--since'));
      } else if (arg === '--harness') {
        args.harness = yield* parseHarness(yield* parseRequiredValue(rest, '--harness'));
      } else if (arg === '--project') {
        args.project = (yield* parseRequiredValue(rest, '--project')).toLowerCase();
      } else if (arg === '--limit') {
        args.limit = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--limit'), '--limit');
      } else if (arg === '--min-tokens') {
        args.minTokens = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--min-tokens'), '--min-tokens');
      } else if (arg === '--json') {
        yield* setOutputFormat(args, 'json');
      } else if (arg === '--csv') {
        yield* setOutputFormat(args, 'csv');
      } else if (arg === '--payload-json') {
        yield* setOutputFormat(args, 'payload');
      } else if (arg === '--no-cursor') {
        args.cursor = false;
      } else if (arg === '--stored') {
        args.stored = true;
      } else if (arg === '--no-color') {
        args.color = false;
      } else if (arg === '--color') {
        args.color = true;
      } else if (arg === '--wide') {
        args.wide = true;
      } else if (arg === '--sort') {
        args.sort = yield* parseSort(yield* parseRequiredValue(rest, '--sort'));
      } else if (arg === '-h' || arg === '--help') {
        return yield* Effect.fail(cliArgumentError('Help is a command-level flag'));
      } else {
        return yield* Effect.fail(cliArgumentError(`Unknown option: ${arg}`));
      }
    }
    return args;
  });

const parseQuotaArgs = (argv: string[]): Effect.Effect<QuotaArgs, CliArgumentError> =>
  Effect.gen(function* () {
    let color: boolean | null = null;
    let history: QuotaHistoryRange | null = null;
    let json = false;
    let stored = false;
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--no-color') {
        color = false;
      } else if (arg === '--color') {
        color = true;
      } else if (arg === '--json') {
        json = true;
      } else if (arg === '--stored') {
        stored = true;
      } else if (arg === '--history') {
        // The range is optional: a bare --history means the default window, and anything starting
        // with "-" is the next flag rather than a range, so `--history --color` still parses.
        const next = rest[0];
        if (next === undefined || next.startsWith('-')) {
          history = DEFAULT_QUOTA_HISTORY_RANGE;
        } else {
          rest.shift();
          if (!isQuotaHistoryRange(next)) {
            return yield* Effect.fail(
              cliArgumentError(`Unknown quota history range: ${next} (expected 24h, 7d, or 30d)`),
            );
          }
          history = next;
        }
      } else if (arg === '-h' || arg === '--help') {
        return yield* Effect.fail(cliArgumentError('Help is a command-level flag'));
      } else {
        return yield* Effect.fail(cliArgumentError(`Unknown option for quota: ${arg}`));
      }
    }
    // --history is a trend rather than the newest-observation feed, and it is already a stored-only read.
    if (history !== null && json) {
      return yield* Effect.fail(
        cliArgumentError('quota --history cannot be combined with --json; the JSON feed is quota [--stored] --json'),
      );
    }
    if (history !== null && stored) {
      return yield* Effect.fail(
        cliArgumentError('quota --history cannot be combined with --stored; --history already reads stored data only'),
      );
    }
    return { color, history, json, stored };
  });

const parseSnapshotArgs = (argv: string[]): Effect.Effect<SnapshotArgs, CliArgumentError> =>
  Effect.gen(function* () {
    const args: SnapshotArgs = { out: '', harness: null, cursor: true };
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--out') {
        args.out = yield* parseRequiredValue(rest, '--out');
      } else if (arg === '--harness') {
        args.harness = yield* parseHarness(yield* parseRequiredValue(rest, '--harness'));
      } else if (arg === '--no-cursor') {
        args.cursor = false;
      } else {
        return yield* Effect.fail(cliArgumentError(`Unknown option for snapshot: ${arg}`));
      }
    }
    if (!args.out) {
      return yield* Effect.fail(cliArgumentError('snapshot expects --out <file>'));
    }
    return args;
  });

const parseMergeArgs = (argv: string[]): Effect.Effect<MergeArgs, CliArgumentError> =>
  Effect.gen(function* () {
    const baseArgs = yield* parseArgs([]);
    const args: MergeArgs = { ...baseArgs, files: [], local: false };
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--local') {
        args.local = true;
      } else if (arg === '--since') {
        args.since = yield* parseDuration(yield* parseRequiredValue(rest, '--since'));
      } else if (arg === '--harness') {
        args.harness = yield* parseHarness(yield* parseRequiredValue(rest, '--harness'));
      } else if (arg === '--project') {
        args.project = (yield* parseRequiredValue(rest, '--project')).toLowerCase();
      } else if (arg === '--limit') {
        args.limit = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--limit'), '--limit');
      } else if (arg === '--min-tokens') {
        args.minTokens = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--min-tokens'), '--min-tokens');
      } else if (arg === '--json') {
        yield* setOutputFormat(args, 'json');
      } else if (arg === '--csv') {
        yield* setOutputFormat(args, 'csv');
      } else if (arg === '--payload-json') {
        yield* setOutputFormat(args, 'payload');
      } else if (arg === '--no-cursor') {
        args.cursor = false;
      } else if (arg === '--no-color') {
        args.color = false;
      } else if (arg === '--color') {
        args.color = true;
      } else if (arg === '--wide') {
        args.wide = true;
      } else if (arg === '--sort') {
        args.sort = yield* parseSort(yield* parseRequiredValue(rest, '--sort'));
      } else if (arg.startsWith('--')) {
        return yield* Effect.fail(cliArgumentError(`Unknown option for merge: ${arg}`));
      } else {
        args.files.push(arg);
      }
    }
    if (!args.local && args.files.length === 0) {
      return yield* Effect.fail(cliArgumentError('merge expects files or --local'));
    }
    return args;
  });

const parseMachineCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    if (!rest.length) {
      return { _tag: 'Machine' };
    }
    const subcommand = rest.shift();
    if (subcommand === 'set-label') {
      const label = yield* parseRequiredValue(rest, 'machine set-label');
      if (rest.length) {
        return yield* Effect.fail(cliArgumentError(`Unknown option for machine set-label: ${rest[0]}`));
      }
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
      if (arg === '--local') {
        args.local = true;
      } else if (arg === '--paths') {
        args.paths = true;
      } else if (arg.startsWith('--')) {
        return yield* Effect.fail(cliArgumentError(`Unknown option for projects list: ${arg}`));
      } else {
        args.files.push(arg);
      }
    }
    if (!args.paths) {
      return yield* Effect.fail(cliArgumentError('projects list expects --paths'));
    }
    if (!args.local && args.files.length === 0) {
      return yield* Effect.fail(cliArgumentError('projects list expects files or --local'));
    }
    return args;
  });

const parseProjectsCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    const subcommand = rest.shift();
    if (subcommand === 'list') {
      return { _tag: 'ProjectsList', args: yield* parseProjectsListArgs(rest) };
    }
    return yield* Effect.fail(cliArgumentError(`Unknown projects subcommand: ${subcommand ?? ''}`.trim()));
  });

const parseCursorCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    const subcommand = rest.shift();
    if (subcommand === 'import') {
      const file = yield* parseRequiredValue(rest, 'cursor import');
      if (rest.length) {
        return yield* Effect.fail(cliArgumentError(`Unknown option for cursor import: ${rest[0]}`));
      }
      return { _tag: 'CursorImport', args: { file } };
    }
    return yield* Effect.fail(cliArgumentError(`Unknown cursor subcommand: ${subcommand ?? ''}`.trim()));
  });

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const parseMemorySearchArgs = (argv: string[]): Effect.Effect<MemorySearchArgs, CliArgumentError> =>
  Effect.gen(function* () {
    const args: MemorySearchArgs = {
      cursor: null,
      includeSpaceWide: false,
      json: false,
      limit: 10,
      matchingMode: 'hybrid',
      projectId: null,
      query: '',
    };
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--literal') {
        args.matchingMode = 'literal';
      } else if (arg === '--project') {
        const projectId = yield* parseRequiredValue(rest, '--project');
        if (!PROJECT_ID_PATTERN.test(projectId)) {
          return yield* Effect.fail(cliArgumentError('--project expects a UUID'));
        }
        args.projectId = projectId;
      } else if (arg === '--include-space-wide') {
        args.includeSpaceWide = true;
      } else if (arg === '--limit') {
        args.limit = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--limit'), '--limit');
        if (args.limit > 25) {
          return yield* Effect.fail(cliArgumentError('--limit expects an integer from 1 to 25'));
        }
      } else if (arg === '--cursor') {
        const cursor = yield* parseRequiredValue(rest, '--cursor');
        if (new TextEncoder().encode(cursor).byteLength > 4096) {
          return yield* Effect.fail(cliArgumentError('--cursor exceeds its byte limit'));
        }
        args.cursor = cursor;
      } else if (arg === '--json') {
        args.json = true;
      } else if (arg.startsWith('--')) {
        return yield* Effect.fail(cliArgumentError(`Unknown option for memory search: ${arg}`));
      } else if (args.query.length === 0) {
        args.query = arg.trim();
      } else {
        return yield* Effect.fail(cliArgumentError('memory search expects one quoted query'));
      }
    }
    if (args.query.length === 0) {
      return yield* Effect.fail(cliArgumentError('memory search expects a query'));
    }
    if ([...args.query].length > 512 || new TextEncoder().encode(args.query).byteLength > 2048) {
      return yield* Effect.fail(cliArgumentError('memory search query exceeds its limit'));
    }
    if (args.includeSpaceWide && args.projectId === null) {
      return yield* Effect.fail(cliArgumentError('--include-space-wide requires --project'));
    }
    return args;
  });

const parseMemoryCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    const subcommand = rest.shift();
    if (subcommand === 'search') {
      return { _tag: 'MemorySearch', args: yield* parseMemorySearchArgs(rest) };
    }
    return yield* Effect.fail(cliArgumentError(`Unknown memory subcommand: ${subcommand ?? ''}`.trim()));
  });

const parseReplicationCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    const subcommand = rest.shift();
    if (subcommand !== 'status') {
      return yield* Effect.fail(cliArgumentError(`Unknown replication subcommand: ${subcommand ?? ''}`.trim()));
    }
    let json = false;
    while (rest.length) {
      const arg = rest.shift();
      if (arg === '--json') {
        json = true;
      } else {
        return yield* Effect.fail(cliArgumentError(`Unknown option for replication status: ${arg ?? ''}`.trim()));
      }
    }
    return { _tag: 'ReplicationStatus', args: { json } };
  });

const WORK_CONTEXT_SCOPE_MESSAGE = 'work context expects exactly one of --checkout or --project-label';

const parseWorkCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    const subcommand = rest.shift();
    if (subcommand !== 'context') {
      return yield* Effect.fail(cliArgumentError(`Unknown work subcommand: ${subcommand ?? ''}`.trim()));
    }
    let json = false;
    const scopes: WorkContextArgs['scope'][] = [];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--json') {
        json = true;
      } else if (arg === '--checkout') {
        scopes.push({ checkoutPath: yield* parseRequiredValue(rest, '--checkout'), kind: 'checkout' });
      } else if (arg === '--project-label') {
        scopes.push({ kind: 'project-label', projectLabel: yield* parseRequiredValue(rest, '--project-label') });
      } else {
        return yield* Effect.fail(cliArgumentError(`Unknown option for work context: ${arg}`));
      }
    }
    const [scope, ...others] = scopes;
    if (scope === undefined || others.length > 0) {
      return yield* Effect.fail(cliArgumentError(WORK_CONTEXT_SCOPE_MESSAGE));
    }
    return { _tag: 'WorkContext', args: { json, scope } };
  });

const DEFAULT_DELEGATION_SELECTOR_VERSION = 'operator/ai-usage-cli';
/** Jobs one `delegation list` answer carries at most (the read side's own bound). */
const DELEGATION_LIST_MAX_LIMIT = 50;

const isAbstentionReason = (value: string): value is DelegationAbstentionReason =>
  (DELEGATION_ABSTENTION_REASONS as readonly string[]).includes(value);

const parseDelegationJobId = (value: string | undefined, usage: string): Effect.Effect<string, CliArgumentError> => {
  if (value === undefined || value.startsWith('--')) {
    return Effect.fail(cliArgumentError(`${usage} expects a job id`));
  }
  return isDelegationUuid(value)
    ? Effect.succeed(value)
    : Effect.fail(cliArgumentError(`${usage} expects the lowercase UUID of a job`));
};

const parseJsonOnly = (rest: string[], usage: string): Effect.Effect<boolean, CliArgumentError> => {
  let json = false;
  for (const arg of rest) {
    if (arg !== '--json') {
      return Effect.fail(cliArgumentError(`Unknown option for ${usage}: ${arg}`));
    }
    json = true;
  }
  return Effect.succeed(json);
};

const parseDelegationQualifyArgs = (argv: string[]): Effect.Effect<DelegationQualifyArgs, CliArgumentError> =>
  Effect.gen(function* () {
    let request: string | null = null;
    let json = false;
    let simulation = false;
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--request') {
        request = yield* parseRequiredValue(rest, '--request');
      } else if (arg === '--json') {
        json = true;
      } else if (arg === '--simulation') {
        simulation = true;
      } else {
        return yield* Effect.fail(cliArgumentError(`Unknown option for delegation qualify: ${arg}`));
      }
    }
    if (request === null) {
      return yield* Effect.fail(cliArgumentError('delegation qualify expects --request <file|->'));
    }
    return { json, request, simulation };
  });

const parseDelegationStartArgs = (argv: string[]): Effect.Effect<DelegationStartArgs, CliArgumentError> =>
  Effect.gen(function* () {
    let request: string | null = null;
    let qualification: string | null = null;
    let key: string | null = null;
    let routeId: string | null = null;
    let selectorVersion: string | null = null;
    let confidence: number | null = null;
    let abstain: DelegationAbstentionReason | null = null;
    let json = false;
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--request') {
        request = yield* parseRequiredValue(rest, '--request');
      } else if (arg === '--qualification') {
        const value = yield* parseRequiredValue(rest, '--qualification');
        if (!isDelegationUuid(value)) {
          return yield* Effect.fail(cliArgumentError('--qualification expects the lowercase UUID of a qualification'));
        }
        qualification = value;
      } else if (arg === '--key') {
        const value = yield* parseRequiredValue(rest, '--key');
        if (!isDelegationIdempotencyKey(value)) {
          return yield* Effect.fail(
            cliArgumentError(
              '--key expects 8 to 128 characters of letters, digits, dots, underscores, colons or dashes',
            ),
          );
        }
        key = value;
      } else if (arg === '--route') {
        routeId = yield* parseRequiredValue(rest, '--route');
      } else if (arg === '--selector-version') {
        selectorVersion = yield* parseRequiredValue(rest, '--selector-version');
      } else if (arg === '--confidence') {
        const value = Number(yield* parseRequiredValue(rest, '--confidence'));
        if (!(Number.isFinite(value) && value >= 0 && value <= 1)) {
          return yield* Effect.fail(cliArgumentError('--confidence expects a number from 0 to 1'));
        }
        confidence = value;
      } else if (arg === '--abstain') {
        const value = yield* parseRequiredValue(rest, '--abstain');
        if (!isAbstentionReason(value)) {
          return yield* Effect.fail(
            cliArgumentError(`--abstain expects one of: ${DELEGATION_ABSTENTION_REASONS.join(', ')}`),
          );
        }
        abstain = value;
      } else if (arg === '--json') {
        json = true;
      } else {
        return yield* Effect.fail(cliArgumentError(`Unknown option for delegation start: ${arg}`));
      }
    }
    if (request === null || qualification === null || key === null) {
      return yield* Effect.fail(
        cliArgumentError(
          'delegation start expects --request <file|->, --qualification <id> and --key <idempotency-key>',
        ),
      );
    }
    if ((routeId === null) === (abstain === null)) {
      return yield* Effect.fail(
        cliArgumentError('delegation start expects exactly one of --route <id> or --abstain <reason>'),
      );
    }
    if (abstain !== null && (selectorVersion !== null || confidence !== null)) {
      return yield* Effect.fail(
        cliArgumentError(
          '--selector-version and --confidence describe a route choice; they cannot accompany --abstain',
        ),
      );
    }
    const selection: DelegationSelectionArgs =
      routeId === null
        ? { kind: 'abstain', reason: abstain! }
        : {
            confidence,
            kind: 'route',
            routeId,
            selectorVersion: selectorVersion ?? DEFAULT_DELEGATION_SELECTOR_VERSION,
          };
    return { json, key, qualification, request, selection };
  });

const parseDelegationListArgs = (argv: string[]): Effect.Effect<DelegationListArgs, CliArgumentError> =>
  Effect.gen(function* () {
    let json = false;
    let live = false;
    let limit: number | null = null;
    const rest = [...argv];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '--json') {
        json = true;
      } else if (arg === '--live') {
        live = true;
      } else if (arg === '--limit') {
        limit = yield* parsePositiveInt(yield* parseRequiredValue(rest, '--limit'), '--limit');
        if (limit > DELEGATION_LIST_MAX_LIMIT) {
          return yield* Effect.fail(
            cliArgumentError(`--limit expects an integer from 1 to ${DELEGATION_LIST_MAX_LIMIT}`),
          );
        }
      } else {
        return yield* Effect.fail(cliArgumentError(`Unknown option for delegation list: ${arg}`));
      }
    }
    return { json, limit, live };
  });

const parseDelegationCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    const subcommand = rest.shift();
    if (subcommand === 'qualify') {
      return { _tag: 'DelegationQualify', args: yield* parseDelegationQualifyArgs(rest) };
    }
    if (subcommand === 'start') {
      return { _tag: 'DelegationStart', args: yield* parseDelegationStartArgs(rest) };
    }
    if (subcommand === 'list') {
      return { _tag: 'DelegationList', args: yield* parseDelegationListArgs(rest) };
    }
    if (subcommand === 'status' || subcommand === 'cancel') {
      const usage = `delegation ${subcommand}`;
      const jobId = yield* parseDelegationJobId(rest.shift(), usage);
      const json = yield* parseJsonOnly(rest, usage);
      return subcommand === 'status'
        ? { _tag: 'DelegationStatus', args: { jobId, json } }
        : { _tag: 'DelegationCancel', args: { jobId, json } };
    }
    return yield* Effect.fail(cliArgumentError(`Unknown delegation subcommand: ${subcommand ?? ''}`.trim()));
  });

export const parseCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    if (rest.includes('-h') || rest.includes('--help')) {
      return { _tag: 'Help' };
    }
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
    if (command === 'memory') {
      rest.shift();
      return yield* parseMemoryCommand(rest);
    }
    if (command === 'replication') {
      rest.shift();
      return yield* parseReplicationCommand(rest);
    }
    if (command === 'cursor') {
      rest.shift();
      return yield* parseCursorCommand(rest);
    }
    if (command === 'work') {
      rest.shift();
      return yield* parseWorkCommand(rest);
    }
    if (command === 'delegation') {
      rest.shift();
      return yield* parseDelegationCommand(rest);
    }
    if (command === 'report') {
      rest.shift();
    }
    return { _tag: 'Report', args: yield* parseArgs(rest) };
  });
