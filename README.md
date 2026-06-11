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
bun src/main.ts
```

Limit the displayed session table:

```sh
bun src/main.ts --limit 20
```

Filter by recent activity:

```sh
bun src/main.ts --since 30d
```

Filter by harness:

```sh
bun src/main.ts --harness codex
```

Show Codex subscription quota from the newest local rate-limit snapshot:

```sh
bun src/main.ts quota
```

## Output formats

JSON:

```sh
bun src/main.ts --json
```

CSV:

```sh
bun src/main.ts --csv
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

## Notes

`$API` is an approximate cost using the editable pricing table in `src/pricing.ts`. Subscription products bill differently, and models without public pricing are marked as unknown in the report.
