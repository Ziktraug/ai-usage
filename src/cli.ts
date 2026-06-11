import { CliArgumentError } from './errors';

export type SortKey = 'date' | 'tokens' | 'cost';
export type HarnessKey = 'claude' | 'codex' | 'opencode' | 'cursor';

export interface Args {
  since: Date | null;
  harness: HarnessKey | null;
  project: string | null;
  limit: number | null;
  minTokens: number;
  json: boolean;
  csv: boolean;
  cursor: boolean;
  color: boolean | null;
  wide: boolean;
  sort: SortKey;
}

export type CliCommand = { _tag: 'Help' } | { _tag: 'Quota' } | { _tag: 'Report'; args: Args };

const parseDuration = (v: string): Date => {
  const m = /^(\d+)([hdw])$/.exec(v);
  if (!m) throw new CliArgumentError({ message: '--since expects e.g. 24h, 30d, 12w' });
  const mult = { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2] as 'h' | 'd' | 'w'];
  return new Date(Date.now() - Number(m[1]) * mult);
};

const parseRequiredValue = (rest: string[], name: string) => {
  const value = rest.shift();
  if (!value || value.startsWith('--')) throw new CliArgumentError({ message: `${name} expects a value` });
  return value;
};

const parsePositiveInt = (value: string, name: string) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || String(n) !== value) {
    throw new CliArgumentError({ message: `${name} expects a positive integer` });
  }
  return n;
};

const parseSort = (value: string): SortKey => {
  if (value === 'date' || value === 'tokens' || value === 'cost') return value;
  throw new CliArgumentError({ message: '--sort expects one of: date, tokens, cost' });
};

const parseHarness = (value: string): HarnessKey => {
  const h = value.toLowerCase();
  if (h === 'claude' || h === 'codex' || h === 'opencode' || h === 'cursor') return h;
  throw new CliArgumentError({ message: '--harness expects one of: claude, codex, opencode, cursor' });
};

export const helpText =
  `ai-usage — per-session token usage across Claude Code / Codex / OpenCode / Cursor\n\n` +
  `Usage: bun ai-usage.ts [report] [options]   |   bun ai-usage.ts quota\n\n` +
  `Subcommands:\n` +
  `  report (default)       per-session table + data analysis\n` +
  `  quota                  Codex subscription quota (5h / 7d usage)\n\n` +
  `Options:\n` +
  `  --since <30d|12w|24h>  only sessions active since\n` +
  `  --harness <name>       claude|codex|opencode|cursor\n` +
  `  --project <name>       filter by project dir basename (substring)\n` +
  `  --min-tokens <n>       hide sessions below n total tokens (default 1)\n` +
  `  --limit <n>            show only n table rows (analysis covers all)\n` +
  `  --sort date|tokens|cost\n` +
  `  --wide                 add Dur / Turns / Tools / ±Lines columns\n` +
  `  --no-cursor            skip Cursor (local data is partial)\n` +
  `  --no-color / --color   disable / force ANSI colors (default: auto)\n` +
  `  --json | --csv         machine-readable output (full metadata)\n`;

export const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    since: null,
    harness: null,
    project: null,
    limit: null,
    minTokens: 1,
    json: false,
    csv: false,
    cursor: true,
    color: null,
    wide: false,
    sort: 'date',
  };
  const rest = [...argv];
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === '--since') args.since = parseDuration(parseRequiredValue(rest, '--since'));
    else if (arg === '--harness') args.harness = parseHarness(parseRequiredValue(rest, '--harness'));
    else if (arg === '--project') args.project = parseRequiredValue(rest, '--project').toLowerCase();
    else if (arg === '--limit') args.limit = parsePositiveInt(parseRequiredValue(rest, '--limit'), '--limit');
    else if (arg === '--min-tokens')
      args.minTokens = parsePositiveInt(parseRequiredValue(rest, '--min-tokens'), '--min-tokens');
    else if (arg === '--json') args.json = true;
    else if (arg === '--csv') args.csv = true;
    else if (arg === '--no-cursor') args.cursor = false;
    else if (arg === '--no-color') args.color = false;
    else if (arg === '--color') args.color = true;
    else if (arg === '--wide') args.wide = true;
    else if (arg === '--sort') args.sort = parseSort(parseRequiredValue(rest, '--sort'));
    else if (arg === '-h' || arg === '--help') throw new CliArgumentError({ message: 'Help is a command-level flag' });
    else throw new CliArgumentError({ message: `Unknown option: ${arg}` });
  }
  return args;
};

export const parseCommand = (argv: string[]): CliCommand => {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) return { _tag: 'Help' };
  const command = rest[0];
  if (command === 'quota') return { _tag: 'Quota' };
  if (command === 'report') rest.shift();
  return { _tag: 'Report', args: parseArgs(rest) };
};
