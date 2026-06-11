import { type HarnessKey, harnessKeyList, harnessLabelList, isHarnessKey } from '@ai-usage/core/harness-metadata';
import type { ReportOptions, SortKey } from '@ai-usage/core/report-data';
import { Effect } from 'effect';
import { CliArgumentError } from './errors';

export type OutputFormat = 'table' | 'json' | 'csv' | 'html';

export interface Args extends ReportOptions {
  harness: HarnessKey | null;
  format: OutputFormat;
  cursor: boolean;
  color: boolean | null;
  wide: boolean;
}

export type CliCommand = { _tag: 'Help' } | { _tag: 'Quota'; color: boolean | null } | { _tag: 'Report'; args: Args };

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
  if (args.format !== 'table') return Effect.fail(cliArgumentError('--json, --csv, and --html are mutually exclusive'));
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
  `  quota                  Codex subscription quota (5h / 7d usage)\n\n` +
  `Options:\n` +
  `  --since <30d|12w|24h>  only sessions active since\n` +
  `  --harness <name>       ${harnessKeyList}\n` +
  `  --project <name>       filter by project dir basename (substring)\n` +
  `  --min-tokens <n>       hide sessions below n total tokens (default 1)\n` +
  `  --limit <n>            show only n table rows (analysis covers all)\n` +
  `  --sort date|tokens|cost\n` +
  `  --wide                 add Dur / Turns / Tools / ±Lines columns\n` +
  `  --no-cursor            skip Cursor (local data is partial)\n` +
  `  --no-color / --color   disable / force ANSI colors (default: auto)\n` +
  `  --json | --csv | --html\n`;

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
      else if (arg === '--no-cursor') args.cursor = false;
      else if (arg === '--no-color') args.color = false;
      else if (arg === '--color') args.color = true;
      else if (arg === '--wide') args.wide = true;
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

export const parseCommand = (argv: string[]): Effect.Effect<CliCommand, CliArgumentError> =>
  Effect.gen(function* () {
    const rest = [...argv];
    if (rest.includes('-h') || rest.includes('--help')) return { _tag: 'Help' };
    const command = rest[0];
    if (command === 'quota') {
      rest.shift();
      return { _tag: 'Quota', ...(yield* parseQuotaArgs(rest)) };
    }
    if (command === 'report') rest.shift();
    return { _tag: 'Report', args: yield* parseArgs(rest) };
  });
