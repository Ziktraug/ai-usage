# ai-usage

Unified local AI usage report for the coding tools installed on this machine — and across multiple machines via portable snapshots.

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

## Multi-machine usage

If you work across multiple machines (e.g. a Mac and a Linux PC), you can merge their usage into one report.

### 1. Export a snapshot on the other machine

```sh
bun run cli -- snapshot --out ~/Desktop/mac-usage.json
```

Transfer the file to this machine (AirDrop, scp, Syncthing, USB...).

The first export creates a stable machine identity in `~/.config/ai-usage/machine.json`. Rename it for friendlier labels:

```sh
bun run cli -- machine                 # show current id + label
bun run cli -- machine set-label "MacBook Pro"
```

### 2. Merge snapshots into a report

```sh
# Merge a remote snapshot with this machine's local history
bun run cli -- merge ./mac-usage.json --local

# All normal report options work on merged data
bun run cli -- merge ./mac-usage.json --local --since 30d --project exalibur --html
```

Duplicate sessions (same machine, same harness, same session ID) are deduplicated automatically. The newest snapshot wins.

### 3. Merge over LAN (no file transfer)

Instead of copying snapshot files, run a snapshot server on the other machine.

On the Mac:

```sh
# Serve snapshot over LAN (token required when binding outside localhost)
bun run cli -- serve --host 0.0.0.0 --token mysecret
```

Keep that command running. It prints one or more `http://...:3847/snapshot` URLs detected from the Mac's network interfaces; use one of those URLs from the other machine. If `macbook.local` does not resolve on your network, use the printed IP address instead.

On the PC:

```sh
# Fetch and merge in one command, without storing the remote snapshot
bun run cli -- merge --remote http://macbook.local:3847/snapshot --token mysecret --local
```

The server collects a fresh snapshot on each request, so you always get the latest data for that command. For localhost-only access (same machine, different terminal), omit `--host` and `--token`:

```sh
bun run cli -- serve
# Then in another terminal:
bun run cli -- merge --remote http://localhost:3847/snapshot --local
```

### 4. Sync over LAN

For a persistent workflow, register the other machine as a snapshot remote and pull it into local storage:

```sh
# First, keep the snapshot server running on the other machine:
bun run cli -- serve --host 0.0.0.0 --token mysecret

# Store this in your shell, ./.env, or ~/.config/ai-usage/.env
# .env is gitignored in this repo.
AI_USAGE_SYNC_MACBOOK_TOKEN=mysecret

# Use one of the snapshot URLs printed by the serve command.
bun run cli -- sync add macbook http://macbook.local:3847/snapshot --token-env AI_USAGE_SYNC_MACBOOK_TOKEN
bun run cli -- sync pull macbook
```

If you do not know the host name ahead of time, that is expected: start `serve` first, copy the printed URL, then run `sync add`. To test a URL before saving it as a remote, you can do a one-shot pull:

```sh
bun run cli -- sync pull --name macbook --remote http://192.168.1.63:3847/snapshot --token-env AI_USAGE_SYNC_MACBOOK_TOKEN
```

Future reports include synced snapshots by default:

```sh
bun run cli -- report --wide
```

Use `--no-synced` to report only this machine's local history:

```sh
bun run cli -- report --no-synced
```

You can keep a remote fresh with polling:

```sh
bun run cli -- sync watch macbook --interval 60s
```

Bidirectional sync is symmetric pull: run `serve` on both machines and configure each machine to pull the other's snapshot.

The interactive report also includes a LAN sync console at `/sync` when served through the report app. Use it to start or stop this machine's snapshot server, discover peers, validate endpoints, add remotes, pull now, enable or disable remotes, and remove remotes without calling CLI code from the web UI.

### 5. See where sessions come from

Merged reports include a `Machine` column (CLI `--wide`, CSV, and HTML dashboard). CSV also includes `machine_id` for scripting.

### 6. Group project folders across machines

The same project often lives at different paths on different machines. Project aliases let you merge them under one name.

Create `~/.config/ai-usage/config.json`:

```json
{
  "projectAliases": [
    { "name": "exalibur", "match": ["*/exalibur", "*/exalibur-*"] }
  ]
}
```

Or use the local setup UI:

```sh
bun run cli -- setup ./mac-usage.json --local --port 3456
```

Then open `http://localhost:3456` in a browser. The UI shows all detected project sources, suggests merges for matching basenames, and saves aliases directly to your config.

Once configured, aliases apply before filtering and analytics, so `--project exalibur` matches the grouped project. Config stays local to your machine and is never read from the repo.

### 5. Discover project sources

See all project folders across machines to decide which ones to alias:

```sh
bun run cli -- projects list --paths ./mac-usage.json --local
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
- `--wide`: add Machine, duration, turns, tool calls, and line delta columns
- `--no-cursor`: skip Cursor
- `--no-color` / `--color`: control ANSI color output (default: auto)
- `--json` / `--csv` / `--html`: pick an output format (mutually exclusive)

`merge` accepts the same report options and adds `--local` to include the current machine's local history, `--remote <url>` to fetch a snapshot from a serve instance, and `--token <secret>` for authentication.

`sync` stores remote snapshots locally. `sync add` registers a remote, `sync pull` fetches and stores a snapshot, `sync watch` polls repeatedly, and `sync list` shows remote status. Persistent remotes should use `--token-env <name>` instead of storing raw tokens in config.

Merged CSV/JSON/HTML payloads include row provenance (`source.machineLabel`, `source.machineId`, harness key, and source session ID) when available. The terminal table shows `Machine` in `--wide` mode.

## Project layout

- `packages/usage-core` (`@ai-usage/core`): pure row types, pricing, normalization, analytics, report payloads, snapshots, and HTML inlining primitives
- `packages/local-collectors` (`@ai-usage/local-collectors`): Effect-based local history collectors for Claude, Codex, OpenCode, Cursor, RTK enrichment, machine identity, and user config
- `packages/reporting` (`@ai-usage/reporting`): report orchestration seam over core plus local collectors
- `packages/design-system` (`@ai-usage/design-system`): Panda/Solid primitives, report style slots, and generated Panda consumer exports
- `apps/cli`: terminal CLI, quota/setup/serve commands, and table/CSV/JSON/HTML output adapters
- `apps/report`: Solid + TanStack Start/Router/Table + Panda CSS report app and browser export adapters

Architecture docs:

- `docs/architecture.md`: package ownership, data flow, adapter rules, and guardrails
- `docs/future-work.md`: global backlog for known follow-ups
- `docs/public-package-interfaces.md`: public package exports and import rules
- `docs/generated-tooling-ownership.md`: Panda/TanStack/Nitro/Turbo generated file ownership

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
