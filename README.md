# ai-usage

See how much you use your AI coding tools. ai-usage reads the session history that Claude Code, Codex, OpenCode and Cursor already keep on your machine and turns it into one report: tokens, estimated cost, activity over time, and a breakdown by project, model and session. You read it in the terminal or in a local web dashboard.

Everything stays on your machine: there is no account, no server to deploy and no telemetry. The usage report only reads local files, and ai-usage never reads provider credentials. A few optional features ask command-line tools you already have installed and signed in: the Codex, Claude or OpenCode client for your remaining subscription quota, and `gh` and `acli` for pull requests and Jira tickets in the Work view. Those tools handle their own sign-in.

## Supported session sources

| Harness | Local history |
| --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` (+ `~/.claude.json`) |
| Codex | `~/.codex/sessions/**/*.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |

Cursor data is partial because some usage counters are stored server-side; those rows are flagged in the report. A tool you do not use is simply skipped.

## Requirements

- [Bun](https://bun.sh/) (the version this repository is developed with is pinned under `packageManager` in `package.json`)
- For real data, at least one of the tools above with some history. The demo needs none.

## Quick start

Clone the repository, then install dependencies:

```sh
bun install
```

### 1. Try the demo

```sh
bun run demo
```

Open <http://127.0.0.1:4176>. The demo shows the dashboard with made-up data. It does not read your history and cannot change anything on your machine, so it is the safe way to look around.

### 2. Run it on your own history

```sh
bun run dev
```

This starts two local processes: a background engine that reads your tools' history into a local SQLite database, and the web dashboard (the address is printed in the terminal, <http://127.0.0.1:5173> by default). The first collection can take a moment; the dashboard fills in when it finishes.

Prefer the terminal? This prints a per-session table and a summary, without the dashboard:

```sh
bun run cli
bun run cli -- --since 30d --harness codex
```

## Main commands

| Command | What it does |
| --- | --- |
| `bun run demo` | Dashboard on synthetic data, isolated from your history |
| `bun run dev` | Engine + dashboard on your own history, with live reload |
| `bun run cli` | Terminal report; add `-- --help` for filters and formats (`--json`, `--csv`) |
| `bun run cli -- quota` | Remaining subscription quota per provider |
| `bun run build` then `bun run start` | Production build, then engine + dashboard without the dev tooling |
| `bun run mcp` | Local MCP server that lets a coding agent read its Work context |
| `bun run verify` | Everything a pull request must pass: checks, lint, typecheck, tests, build |

## What is in the dashboard

- **Overview, Sessions, Analysis**: usage over time, every session with its tokens and cost, and breakdowns by model, tool and project.
- **Campaigns**: sessions that belong together (an agent and the sub-agents it started) on one timeline.
- **Work**: what is waiting on you across sessions, pull requests and tickets. Optional, and needs some setup.
- **Skills, Sync, Sources, Delegation**: manage local agent skills, move usage between machines by file, see what is collected and when, and let one agent hand a read-only review to another.

Cost is an estimate at standard API prices, computed from the token counts in your history. It is not what a subscription actually charged you.

## Documentation

Using ai-usage:

- [Reports](docs/reports.md): CLI options, output formats, the quota view and its JSON feed, and a tour of the dashboard.
- [Multi-machine usage](docs/multi-machine.md): export a snapshot on one machine, merge it on another, and group the same project across machines.
- [Work view setup](docs/work.md): reviews by a local harness, Jira replies, branch linking, and Work context for agents.
- [Delegation](docs/delegation.md) and the [local MCP server](docs/mcp.md).
- [Local store upgrade](docs/local-store-upgrade.md): back up and move your database across versions.

Working on ai-usage:

- [Development](docs/development.md): run modes, checks, and the test suites.
- [Architecture](docs/architecture.md): how the engine, the database, the web app and the CLI fit together.
- [Documentation map](docs/README.md): everything else, including the decision records and the project vocabulary in [CONTEXT.md](CONTEXT.md).

## How it is built

A Bun workspace in TypeScript:

- `apps/usage-engine`: the background process that collects history and is the only writer of the database
- `apps/web`: the SvelteKit dashboard, which reads the database read-only
- `apps/cli`: the terminal report and commands
- `apps/mcp`: the local MCP server
- `packages/*`: shared libraries (collectors, report logic, storage, design system), each described in [architecture](docs/architecture.md#package-ownership)

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and synthetic-fixture guidance and [SECURITY.md](SECURITY.md) for private vulnerability reporting. ai-usage is available under the [MIT License](LICENSE).
