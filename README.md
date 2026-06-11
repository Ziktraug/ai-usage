# ai-usage

Unified local AI usage report for the tools installed on this machine.

The CLI reads local history files and databases, then prints per-session token usage, approximate API cost, and aggregate analytics. It does not call provider APIs.

## Supported sources

- Claude Code: `~/.claude/projects/**/*.jsonl`
- Codex: `~/.codex/sessions/**/*.jsonl`
- OpenCode: `~/.local/share/opencode/opencode.db`
- Cursor: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`

Cursor data is partial because some usage counters are stored server-side.

## Requirements

- Bun

Install dependencies:

```sh
bun install
```

## Run

Default report:

```sh
bun run start
```

Limit the displayed session table:

```sh
bun run start -- --limit 20
```

Filter by recent activity:

```sh
bun run start -- --since 30d
```

Filter by harness:

```sh
bun run start -- --harness codex
```

Show Codex subscription quota from the newest local rate-limit snapshot:

```sh
bun run quota
```

## Output formats

JSON:

```sh
bun run start -- --json
```

CSV:

```sh
bun run start -- --csv
```

HTML app report:

```sh
bun run build
bun run start -- --html > report.html
```

## Useful options

- `--since <24h|30d|12w>`: only sessions active since the duration
- `--harness <claude|codex|opencode|cursor>`: filter one source
- `--project <name>`: filter by project directory basename
- `--min-tokens <n>`: hide tiny sessions
- `--limit <n>`: limit only the displayed table; analytics still cover all filtered rows
- `--sort date|tokens|cost`: choose table sort
- `--wide`: add duration, turns, tool calls, and line delta columns
- `--no-cursor`: skip Cursor
- `--no-color` / `--color`: control ANSI color output

## Project layout

- `packages/usage-core`: shared row types, pricing, normalization, report preparation, and analytics
- `packages/local-collectors`: local filesystem/SQLite collectors for Claude, Codex, OpenCode, and Cursor
- `apps/cli`: terminal CLI, quota command, table/CSV/JSON/HTML renderers
- `apps/report`: Solid + TanStack Router + Panda CSS + Ark UI report app built as a single HTML file through Vite

## Development

Typecheck:

```sh
bun run check
```

Lint:

```sh
bun run lint
```

Format:

```sh
bun run format
```

Run the report app in development with demo data:

```sh
bun run dev:report
```

## Notes

`$API` is an approximate cost using the editable pricing table in `packages/usage-core/src/pricing.ts`. Subscription products bill differently, and models without public pricing are marked as unknown in the report.
