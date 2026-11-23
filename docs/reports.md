# Reports: CLI, output formats and the interactive report

How to read usage once ai-usage is installed: the command-line report and its
options, the output formats, the provider quota view and its JSON feed, and
the interactive web report. Installation and the first run are in the root
[README](../README.md); merging several machines is in
[multi-machine usage](multi-machine.md).

## Command-line report

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

`bun run cli -- --help` prints every subcommand and option.

## Options

- `--since <24h|30d|12w>`: only sessions active since the duration
- `--harness <claude|codex|opencode|cursor>`: filter one source
- `--project <name>`: filter by project directory basename (substring match)
- `--min-tokens <n>`: hide tiny sessions (default 1)
- `--limit <n>`: limit only the displayed table; analytics still cover all filtered rows
- `--sort date|tokens|cost`: choose table sort
- `--wide`: add Machine, duration, turns, tool calls, and line delta columns
- `--no-cursor`: skip Cursor
- `--stored`: read the last compatible published revision without refreshing (see [Fresh and stored reads](#fresh-and-stored-reads))
- `--no-color` / `--color`: control ANSI color output (default: auto)
- `--json` / `--csv` / `--payload-json`: pick an output format (mutually exclusive)

`merge` accepts one or more snapshot file paths plus the same report options. Add `--local` to include this machine's local history.

Merged CSV/JSON payloads include row provenance (`source.machineLabel`, `source.machineId`, harness key, and source session ID) when available. The terminal table shows `Machine` in `--wide` mode.

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

`--payload-json` prints the full report payload for compatible consumers.

## Cost columns

- **`$API`** is an estimated cost at standard API prices, computed from local token counters and the editable pricing table in `packages/report-core/src/pricing.ts`. A `≥` value is the known subtotal when only some model segments have pricing; wholly unpriced usage remains unknown.
- **`$Actual`** is out-of-pocket spend when a harness reports it. Subscription products bill differently from per-token API rates, so the two columns can diverge.

## Fresh and stored reads

Normal CLI reports are fresh: they ask the usage engine to collect and publish,
then read the committed revision. When no engine is running, the command starts
one bounded foreground engine and reaps it after publication. To read the
latest compatible stored revision without starting an engine, use:

```sh
bun run cli -- --stored
```

If the engine stops after a compatible revision is published, Web and
`--stored` CLI reads continue while fresh and usage-domain mutating actions
fail explicitly. A live protocol mismatch fails closed instead of starting a
competing writer.

## Collection sources

The usage engine runs collection independently from browser visibility.
Collection sources include Claude, Codex, OpenCode, and Cursor sessions; Codex,
experimental Claude and OpenCode usage limits; RTK savings; Claude Desktop
sessions; executor capabilities; checkout status; pull requests; and Jira
issues. Each source has separate policy, detection, lifecycle, outcome, and
cadence state on `/sources`. Sparse policy overrides live only in
`~/.config/ai-usage/config.json`; repository config cannot enable background
work. Disabling a source, missing input, empty output, or failure never deletes
what was collected before.

If RTK (a token-killer CLI proxy) has a local history database at
`~/Library/Application Support/rtk/history.db`, sessions are enriched with the
token savings RTK achieved. Each RTK command is matched to a session by project
path and time window. Savings are persisted as an RTK-owned contribution
separate from the collector-owned base row, so later base re-imports, no-match
runs, disablement, and restarts preserve the last durable enrichment.

How collection, publication, the single writer and the control plane fit
together, and how to back up the SQLite store, is described in
[architecture](architecture.md) (see "Runtime and process ownership" and
"SQLite backup and recovery").

## Provider quota

Request fresh subscription quota observations from the enabled provider sources, then render the newest durable local observation for each provider:

```sh
bun run cli -- quota
```

Codex uses the installed `codex app-server`. Claude uses an experimental Agent SDK API whose shape may change, so an incompatible or unavailable response is recorded as unsupported instead of failing the complete quota view. The provider clients own communication and authentication; after collection, `ai-usage` reads the newest durable observations. ai-usage never reads provider credentials or stores or logs their raw payloads. The supported sources per provider are detailed in [provider quota data sources](provider-quota-data-sources.md).

If one refresh fails and a durable observation exists, the command renders the available observations while the `cli.quota` diagnostic boundary is degraded. Without a durable observation, it reports `No stored provider usage-limit observation is available.` A paused source is distinct from provider unavailability; the command fails only when every provider quota source is paused and identifies the source IDs to re-enable.

To show the newest stored observation per provider without refreshing, add `--stored`. It never starts or contacts a usage engine and never polls a provider; a machine that has never collected shows the empty state rather than an error:

```sh
bun run cli -- quota --stored
```

`quota --history [24h|7d|30d]` prints a trend from stored observations only (default `7d`).

### Quota JSON feed

Add `--json` to either form to print the same observations as a provider-status dataset on stdout, with nothing else on stdout and diagnostics on stderr:

```sh
bun run cli -- quota --json            # refresh, then emit
bun run cli -- quota --stored --json   # emit what is stored
```

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-12T09:00:00.000Z",
  "providers": [
    {
      "generatedAt": "2026-10-12T08:58:00.000Z",
      "key": "codex",
      "label": "Codex",
      "machineId": "…",
      "plan": "pro",
      "source": "live-api",
      "state": "ok",
      "windows": [
        {
          "blocked": false,
          "group": "5h",
          "id": "primary",
          "label": "5h",
          "limitSeconds": 18000,
          "remainingPercent": 80,
          "resetsAt": "2026-10-12T13:00:00.000Z",
          "scope": "global",
          "usedPercent": 20
        }
      ]
    }
  ]
}
```

The shape is `ProviderStatusDataset` from `packages/report-core/src/provider-status.ts`. The top-level `generatedAt` is the time of the read. Each provider's `generatedAt` is the most recent time this reading was observed; identical consecutive readings are merged, so a steady provider keeps advancing it. ai-usage judges freshness before printing, so a consumer never re-derives it: a `live-api` reading, or a `local-history` reading recovered from Codex session logs, whose `generatedAt` is more than 15 minutes old reports `state: "stale"`. Readings already `error`, `auth-required`, `stale` or `unsupported` keep that state. The web report dates readings the same way but never ages session-log readings, so the two can disagree on the state of an old session-log reading. Exit codes match the human view: `quota --json` exits 1 when every provider source is paused and 0 for a degraded refresh. `quota --stored --json` exits 0 with `"providers": []` only when no store exists yet; a store that exists but cannot be read exits 1 with the error on stderr. `--json` and `--stored` cannot be combined with `--history`.

`quota --stored --json` is the supported integration seam for desktop and status-bar consumers: poll it as often as needed, and run `quota --json` (for example from a timer) to refresh. Consumers must check `schemaVersion`; an incompatible change to the dataset increments it. Reading the SQLite store or the engine control plane directly is not supported ([ADR 0045](adr/0045-desktop-quota-feed-through-the-cli.md)).

## Interactive report

`bun run dev` (or `bun run start` after a build) serves the web report. It opens on Overview and lets you:

- switch between **Overview, Sessions, and Analysis**; Analysis offers Models, Harnesses & providers, and Projects;
- open **Campaigns** to explore related agent sessions as a temporal hierarchy, collapse descendants, compare recorded overlap, and open any node in the existing session drawer;
- switch Campaigns to **Project timeline** to compare projects and campaigns on one UTC scale, expand one campaign's sessions, or collapse a project;
- filter by date range with presets or a custom range, and read the activity timeline;
- analyze local Claude, Codex, and OpenCode chronology from the unified session drawer, using each harness's recorded, partial, or unavailable timing semantics;
- inspect source-dependent repository, branch-span, commit, and recorded pull-request facts when the harness owns them;
- show/hide columns (input/output/cache tokens, RTK savings, durations, turns, tools, line deltas, …), sort, and filter by field;

All exploration state (active view, filters, range, sorting, visible columns) is persisted in the URL, so a report link reopens exactly where you left off.
Detailed prompt bodies are read only on demand from the source machine's local history and may be truncated by safety budgets; that separate prompt collection is not added to report revisions, snapshots, sync payloads, or exports. Normal session names can still come from source-provided or prompt-derived titles and are portable report fields. Claude fallback names are technical identifiers rather than prompt bodies. Provider pull-request lookup is also local and on demand: it runs only after an explicit action, and its result remains ephemeral. Claude's session span is never presented as complete active time because recorded turn durations may cover only part of a session. See [session analysis data sources](session-analysis-sources.md) for the exact guarantees and limitations of each harness.

The other destinations of the left rail have their own documents: the Work
view in [Work view setup](work.md), Skills in
[skill management](skills-management.md), Sync in
[multi-machine usage](multi-machine.md#import-or-export-stored-usage-in-the-web-app)
and Delegation in [delegation](delegation.md). Sources shows the collection
sources described above.

### Campaigns

Campaigns are observed root-session groups, including standalone sessions; they
are not durable Work threads. The list is paged, and selecting a campaign loads
its members independently of the list filters. Its Agent Map uses recorded start
and end timestamps in UTC: overlapping session lifetimes do not prove concurrent
active compute. Missing parents, incomplete timing, unloaded members, and partial
token counters are disclosed beside the affected information. Titles reuse
published session labels and existing local campaign names; generic children
inherit parent context without fetching prompts or calling a model. `bun run
demo` includes an isolated example with nested and parallel agents.

### Project timeline

The Project timeline reuses the same paged discovery filters. Campaign bounds
cover all recorded members; only the expanded campaign loads individual session
rows. The shared scale fits the loaded campaigns within the selected period, and
clipped intervals are marked. Period filters retain the report's recorded-activity
semantics: they do not search for every session whose lifetime overlaps an
arbitrary historical period. Project bands preserve gaps between campaigns and
do not claim continuous work. `campaignView=timeline` preserves this view in the
URL; a selected campaign outside the loaded page can still open in the Agent Map.
