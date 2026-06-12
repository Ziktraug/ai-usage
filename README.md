# ai-usage

Unified local AI usage report for the coding tools installed on this machine.

The CLI reads local history files and databases written by each tool, then reports per-session token usage, estimated cost, and aggregate analytics — in the terminal or as an interactive single-file HTML app. It never calls provider APIs; everything is computed from local data.

## Supported sources

| Harness | Local history |
| --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` (+ `~/.claude.json`) |
| Codex | `~/.codex/sessions/**/*.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |

Cursor data is partial because some usage counters are stored server-side; those rows are flagged in the report.

### RTK savings (optional)

If RTK (a token-killer CLI proxy) has a local history database at `~/Library/Application Support/rtk/history.db`, sessions are enriched with the token savings RTK achieved. Each RTK command is matched to a session by project path and time window, and the matched saved / input / output token counts surface in the report. Sources without RTK data are left untouched.

## Requirements

- Bun

Install dependencies:

```sh
bun install
```

## Run

Default report (per-session table + analytics):

```sh
bun run cli
```

Limit the displayed session table:

```sh
bun run cli -- --limit 20
```

Filter by recent activity:

```sh
bun run cli -- --since 30d
```

Filter by harness:

```sh
bun run cli -- --harness codex
```

Show Codex subscription quota (5h / 7d windows) from the newest local rate-limit snapshot:

```sh
bun run cli -- quota
```

## Output formats

The default output is a terminal table with an analytics summary. The same report can be emitted in other formats:

JSON:

```sh
bun run cli -- --json
```

CSV:

```sh
bun run cli -- --csv
```

HTML app report:

```sh
bun run html export
```

This builds the report app and writes a dated single-file report to `ai-usage-reports/`, which is ignored by git. Pass normal report filters through the export command:

```sh
bun run html export --since 30d --limit 20
```

### Interactive report

The HTML report is a self-contained Solid app, not a static dump. It opens on the session table and lets you:

- switch between **Sessions, Models, Providers, Harnesses, and Projects** views;
- filter by date range with presets or a custom range, and read the activity timeline;
- show/hide columns (input/output/cache tokens, RTK savings, durations, turns, tools, line deltas, …), sort, and filter by field;
- export the current view to CSV.

All exploration state (active view, filters, range, sorting, visible columns) is persisted in the URL, so a report link reopens exactly where you left off.

## Useful options

- `--since <24h|30d|12w>`: only sessions active since the duration
- `--harness <claude|codex|opencode|cursor>`: filter one source
- `--project <name>`: filter by project directory basename (substring match)
- `--min-tokens <n>`: hide tiny sessions (default 1)
- `--limit <n>`: limit only the displayed table; analytics still cover all filtered rows
- `--sort date|tokens|cost`: choose table sort
- `--wide`: add duration, turns, tool calls, and line delta columns
- `--no-cursor`: skip Cursor
- `--no-color` / `--color`: control ANSI color output (default: auto)
- `--json` / `--csv` / `--html`: pick an output format (mutually exclusive)

## Project layout

- `packages/usage-core` (`@ai-usage/core`): shared row types, pricing, normalization, report preparation, and analytics
- `packages/local-collectors`: Effect-based local filesystem/SQLite collectors for Claude, Codex, OpenCode, and Cursor, plus RTK savings enrichment
- `apps/cli`: terminal CLI, `quota` command, and table/CSV/JSON/HTML renderers
- `apps/report`: Solid + TanStack Router + TanStack Table + Panda CSS + Ark UI report app, built as a single HTML file through Vite

## Development

Typecheck:

```sh
bun run check
```

Lint:

```sh
bunx biome check .
```

Format:

```sh
bunx biome format --write .
```

Run the report app in development:

```sh
bun run dev
```

The dev server injects this machine's real usage data into the app (the same payload `--html` produces, refreshed in the background). When collection fails it falls back to a demo payload, which is flagged in the UI.

## Notes

- **`$API`** is an estimated cost at standard API prices, computed from local token counters and the editable pricing table in `packages/usage-core/src/pricing.ts`. Models without public pricing are marked as unknown.
- **`$Actual`** is out-of-pocket spend when a harness reports it. Subscription products bill differently from per-token API rates, so the two columns can diverge.
