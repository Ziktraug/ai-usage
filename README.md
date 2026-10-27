# ai-usage

Unified local AI usage reporting for the coding tools installed on this machine — and across multiple machines through portable snapshots.

ai-usage reads sessions from Codex, Claude Code, OpenCode, and Cursor, then makes their token usage, estimated cost, activity, and chronology available through a CLI and an interactive dashboard. Normal report collection stays on the local machine. Provider quota sources are the narrow exception: Codex may invoke the installed `codex app-server`, and the experimental Claude source may open the installed Claude Agent SDK. Those provider clients own communication and authentication. ai-usage never reads provider credentials or stores or logs their raw payloads.

## Supported session sources

| Harness | Local history |
| --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` (+ `~/.claude.json`) |
| Codex | `~/.codex/sessions/**/*.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |

Cursor data is partial because some usage counters are stored server-side; those rows are flagged in the report.

### RTK savings (optional)

If RTK (a token-killer CLI proxy) has a local history database at `~/Library/Application Support/rtk/history.db`, sessions are enriched with the token savings RTK achieved. Each RTK command is matched to a session by project path and time window. Savings are persisted as an RTK-owned contribution separate from the collector-owned base row, so later base re-imports, no-match runs, disablement, and restarts preserve the last durable enrichment.

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

Request fresh subscription quota observations from the enabled provider sources, then render the newest durable local observation for each provider:

```sh
bun run cli -- quota
```

Codex uses the installed `codex app-server`. Claude uses an experimental Agent SDK API whose shape may change, so an incompatible or unavailable response is recorded as unsupported instead of failing the complete quota view. The provider clients own communication and authentication; after collection, `ai-usage` reads the newest durable observations.

If one refresh fails and a durable observation exists, the command renders the available observations while the `cli.quota` diagnostic boundary is degraded. Without a durable observation, it reports `No stored provider usage-limit observation is available.` A paused source is distinct from provider unavailability; the command fails only when every provider quota source is paused and identifies the source IDs to re-enable.

To show the newest stored observation per provider without refreshing, add `--stored`. It never starts or contacts a usage engine and never polls a provider; a machine that has never collected shows the empty state rather than an error:

```sh
bun run cli -- quota --stored
```

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

`quota --stored --json` is the supported integration seam for desktop and status-bar consumers: poll it as often as needed, and run `quota --json` (for example from a timer) to refresh. Consumers must check `schemaVersion`; an incompatible change to the dataset increments it. Reading the SQLite store or the engine control plane directly is not supported ([ADR 0045](docs/adr/0045-desktop-quota-feed-through-the-cli.md)).

Normal CLI reports are fresh: they ask the usage engine to collect and publish,
then read the committed revision. To read the latest compatible stored revision
without starting an engine, use:

```sh
bun run cli -- --stored
```

The dedicated usage engine runs collection independently from browser
visibility. Its nine collection sources are Claude, Codex, OpenCode, and
Cursor sessions; Codex and experimental Claude usage limits; RTK savings;
Cursor commit attribution; and executor capabilities (which harness CLIs this
machine can run, for the Work view's review routing).
Each source has separate policy, detection, lifecycle, outcome, and cadence
state on `/sources`. Sparse policy overrides live only in
`~/.config/ai-usage/config.json`; repository config cannot enable background
work.

Collectors persist normalized contributions before a separate stored-only
publication job creates an immutable revision-keyed SQLite projection.
Publication requests use monotonic demand, and timed-out work aborts at the
provider boundary before later writes. Disabling, missing input, empty output,
or failure never deletes prior contributions. The browser strictly decodes
sanitized replacement status plus publication events through one SSE
connection. TanStack Svelte Query owns finite Skills and quota reads as well as
immutable exact-revision report and Session results; composite report queries
publish one complete revision atomically.

### Runtime ownership and backups

`apps/usage-engine` is the only production usage-SQLite writer. It owns
migrations, checkpoints, collection, enrichment, scheduling, usage-domain
mutations, publication, and retention. Web and CLI query the existing database
directly with read-only/query-only connections. Authenticated HTTP on numeric
loopback carries only commands, status, and bounded SSE events; it never
carries report, Session, focused, or quota data.

If the engine stops after a compatible revision is published, Web and
`--stored` CLI reads continue while fresh/usage-domain mutating actions fail
explicitly; Web-owned Skills remains independent. When no daemon exists, a
fresh CLI command starts one bounded foreground engine and reaps it after
publication. A live protocol mismatch fails closed instead of starting a
competing writer.

For a file-level SQLite backup, stop the usage engine cleanly before copying the
database. Do not copy only the main database while its WAL writer may be active;
ai-usage currently exposes no online-backup command. Config/machine files are
separate backups; after a clean stop, do not copy writer locks, rendezvous,
inbox, logs, WAL, or SHM as backup payload.

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
# Merge a copied snapshot with this machine's local history
bun run cli -- merge ./mac-usage.json --local

# All normal report options work on merged data
bun run cli -- merge ./mac-usage.json --local --since 30d --project exalibur --csv
```

Duplicate sessions (same machine, same harness, same session ID) are deduplicated automatically. The newest snapshot wins.

### 3. Import or export stored usage in the web app

The interactive report includes a file-only transfer workspace at `/sync`. Export this machine's stored usage as a JSON merge bundle, copy the file with a tool you trust, then preview the exact insert/update/delete effects. The web stages bounded uploads and sends only an opaque handoff ID; the usage engine revalidates and executes the transfer. A first preview may initialize an empty current-schema private store without inserting usage rows or advancing semantic generation. Previewing an existing store may run migrations, but never imports the peer bundle. Confirmation requires the separately returned document digest and one bounded, versioned, opaque, stateless `confirmationToken` bound to the canonical bundle and relevant logical store state; the web app transports that token without decoding it. If either the selected document or bound store state changed, confirmation returns `preview-stale` and requires a fresh preview. Imports are explicit and bounded; the application does not open a LAN listener or synchronize in the background.

Usage snapshots and merge bundles serve different workflows: `snapshot` plus
`merge` does not import peer snapshot rows into the local store; `snapshot` and
`merge --local` may first collect and publish local usage through the engine.
By contrast, `/sync` imports a merge bundle into the local usage store for
future reports. Both write portable schema version 3. Version-3 files can carry
bounded, credential-free session source-control facts; their rows remain
portable and cannot authorize local prompt reads or provider lookup. Readers
migrate version-1 and version-2 files with source-control context absent.

### 4. See where sessions come from

Merged reports include a `Machine` column (CLI `--wide`, CSV, and dashboard). CSV also includes `machine_id` for scripting.

Projects with the same name from different machines stay separate by default and are displayed with the machine label.
If those folders are intentionally the same project, create a project group in the dashboard's Projects tab.

### 5. Group project folders across machines

The same project often lives at different paths on different machines. Project groups let you merge those sources under one native project name for analytics, filtering, CSV, sessions, and the Projects tab.

Create `~/.config/ai-usage/config.json`:

```json
{
  "projectGroups": [
    {
      "id": "exalibur",
      "name": "exalibur",
      "sources": [
        { "machineId": "macbook-machine-id", "sourcePath": "/Users/nathan/projects/exalibur" },
        { "machineId": "linux-machine-id", "sourcePath": "/home/nathan/projects/exalibur" },
        { "machineId": "macbook-machine-id", "sourcePath": "/Users/nathan/projects/exalibur2" }
      ]
    }
  ]
}
```

Or use the live dashboard:

```sh
bun run dev
```

Then open the Projects tab. The UI shows detected project sources with machine labels and sends project-group changes to the usage engine, which updates your local config and publishes a successor revision.

Legacy `projectAliases` are still supported as broad report-time groups, but new dashboard edits write `projectGroups`.
Config stays local to your machine and is never read from the repo.

### 6. Discover project sources

See all project folders across machines to decide which ones to alias:

```sh
bun run cli -- projects list --paths ./mac-usage.json --local
```

### 7. Declare which local harness may run a read-only review

The Work view qualifies a read-only review of a session for a local
harness (Claude Code or Codex). History and quota never prove that a harness is
*allowed* to act, so authorization is declared once, by you, in the home config
(`~/.config/ai-usage/config.json`, section `routing`; repository config cannot
declare it). The engine observes the rest on a 15-minute cadence
(`executors.capabilities` on `/sources`): whether the binary is present, its
version, and the sign-in state that `claude auth status` / `codex login status`
report. Quota comes from the existing usage-limit sources. Each field of a
candidate shows where it came from (`declared <date>`, `observed-now`,
`stale <date>`, `unknown`). Qualification starts no review; a separate launch
action uses the declared checkout authorization in section 9.

```json
{
  "routing": {
    "executors": [
      {
        "harness": "claude-code",
        "accountScope": "personal",
        "authorization": "allowed",
        "targets": [{ "kind": "any-local-session" }],
        "subscription": "verified",
        "capabilities": ["read-only-review"],
        "quality": "review-capable",
        "model": "Fable",
        "effort": "high",
        "declaredAt": "2026-10-21T22:00:00+02:00"
      }
    ]
  }
}
```

- `harness`: `claude-code` or `codex`.
- `accountScope`: the account this route bills against. When the stored quota
  key carries an account suffix (`claude:<accountScope>` on `/sources` or in
  `ai-usage quota --stored --json`), use that suffix; when the key is bare
  (`claude`, the usual case today), any stable name you choose binds the
  declaration to that machine's single quota stream for the family.
  Native Codex quota is scoped by the observed account fingerprint: copy that
  exact suffix into `accountScope` and pin the same observed identity below.
  A previous human-readable Codex alias needs explicit requalification.
- `machineId` (optional): defaults to this machine
  (`~/.config/ai-usage/machine.json`). Set it only to declare a route on another
  machine's behalf.
- `authorization`: `allowed` or `forbidden`. A quota never grants it.
- `targets`: `{ "kind": "any-local-session" }` or
  `{ "kind": "project", "projectLabel": "<project as shown in the report>" }`;
  one entry is required.
- `subscription`: `verified` (you confirmed the account is on a subscription)
  or `api` (metered API billing, excluded by the subscription-only policy).
  Nothing verifies billing for you: the observed plan is shown beside your
  declaration, never used to infer it.
- `capabilities` (`read-only-review`), `quality` (`review-capable`): the current
  review qualification values.
- `model`, `effort` (optional): the model and effort the review would run with.
  Declare `model` when the provider reports model-scoped quota windows (ids
  `model:<name>` in the quota feed, for example `model:Fable` on a Claude Max
  plan today); the declared name must equal `<name>` exactly, otherwise those
  windows cannot be attributed and the candidate stays excluded.
  Codex launch requires an explicit model and preserves the selected effort;
  a native model substitution is refused.
- `alternateModels` (optional, requires `model`): further models of the same
  account, in preference order, at most 8 and none repeated (for example
  `["Opus"]` after `"model": "Fable"`). Each becomes its own candidate on the
  same account and the same quota reading, never an extra reserve: a window
  scoped to one model (`model:Fable`) excludes only that model, while an
  exhausted all-models window excludes every model of the account.
- `accountFingerprint`: pins the route to the account the CLI is signed in to
  (ADR 0057/0062). The engine keeps a 16-character domain-separated hash of
  identity reported by the CLI's supported account interface, never the raw
  identifiers, and reads no credential file. Codex uses `account/read` and
  `account/rateLimits/read` on its own app-server connection. While the CLI
  reports an account and the entry pins none, the
  candidate stays conditional and the Work view shows the exact line to add
  (`"accountFingerprint": "<16 hex>"`): pinning is a one-time act per machine.
  A later sign-in to another account then excludes the route until you sign
  back in or re-declare. A Codex launch requires a confirmed pin.
- `declaredAt`: required RFC 3339 date-time; the declaration is a dated
  statement, not a current observation.

An invalid entry is reported on the Work view with its config path and reason
and does not hide the other entries. Declarations are read, never written, by
the app.

### 8. Show Jira replies on explicitly linked tickets (optional)

When the Atlassian CLI (`acli`) is installed and signed in, the engine reads,
every 10 minutes, the Jira tickets your Claude Desktop sessions linked
**explicitly**: a key written as a whole segment of a branch name
(`feat/XLB-2090/slug`, `fix/XLB-2091/nav`, `XLB-2092`) in the session's
written branches, its own branch, or the branch of a pull request it declared.
Keys in titles, prompts or paths never link; `XLB-0` is ignored as the
"no ticket" placeholder. The Work view then shows the ticket's dated status
and, when comments arrived after the latest activity on that key across your
sessions, "N new replies" as a request for you on the session family that was
last active on the key (an older family on the same key is only told which
family carries it), without claiming you have not read them elsewhere. Only
`acli jira workitem view` is ever run; nothing is written to
Jira. The engine never reads or stores a Jira token: `acli`'s own sign-in
answers, and a signed-out CLI is reported as `unauthenticated` with the last
successful read kept beside it.

```json
{
  "jira": {
    "enabled": true,
    "handedOffStatuses": ["To Review (IT)"],
    "site": "example.atlassian.net"
  }
}
```

- `enabled` (optional, default on when `acli` is found): `false` records the
  source as disabled instead of reading.
- `handedOffStatuses` (optional): status names, matched without regard to case,
  in which a ticket is someone else's step once every linked pull request merged
  (a review or QA column). The Work view then shows such a task as waiting
  instead of "Ticket not done". A status in progress that is not listed stays
  your move. Each Jira read records the verdict, so a change applies from the
  next read.
- `site` (optional): the Jira site your keys belong to, kept for your record;
  this version does not pass it to the CLI.

The section lives in the home config only (`~/.config/ai-usage/config.json`);
repository config cannot enable provider communication. The `acli` command
shape is taken from the Atlassian CLI documentation and was not exercised on
the machine this feature was built on (ADR 0054); an unexpected response is
recorded as `invalid`, never as a fact.

Sessions also join tasks through the branch their harness recorded (ADR 0081): Codex records the
repository and branch, Claude Code the branch and the folder whose `origin` remote names the
repository. A followed PR's head branch and recent interactive work on a branch without a task
are enough; the folder alone never is. Two optional `github` keys of the home config tune it:

```json
{
  "github": {
    "hostAliases": { "github-work": "github.com" },
    "sharedBranches": ["release"]
  }
}
```

- `hostAliases` (optional): remote host alias → host, beside the exact `Host` → `HostName` entries
  of `~/.ssh/config`, which are read already.
- `sharedBranches` (optional): branch names that never become a task of their own, beside main,
  master, develop, development, trunk, each clone's `origin/HEAD` and the base of an open PR.

Detaching a session from a task keeps it out of that task, even when its branch still matches.


### 9. Declare which checkouts a launched review may run in

A qualified recommendation for Claude Code or Codex can become one execution
(ADR 0053/0062). The engine uses the selected harness's own subscription sign-in
and records the attempt. Claude uses its existing read-only launcher; Codex
uses an owned app-server turn with verified model, policy and capacity.
It does so only when that checkout is equal to, or below, an entry you
declared under `routing.reviewTargets` in the same home config:

```json
{
  "routing": {
    "executors": [{ "...": "see section 7" }],
    "reviewTargets": [{ "checkoutPath": "/home/you/src/ai-usage", "label": "AI Usage checkout" }]
  }
}
```

- `checkoutPath`: absolute path of a checkout; its worktrees under it are
  admitted too. The checkout a session is reviewed in is the Desktop session's
  worktree, else its cwd, else the served session's path; the Work view names
  it beside the button.
- `label` (optional): how the entry is referred to in the cockpit.

Without a matching entry the button stays absent and the view says exactly
what to add (`add routing.reviewTargets for <path>`). The engine re-reads the
declaration, the executor observation, the quota and the checkout at launch
time; the browser never decides. One attempt is live per target at a time: a
second click, a retry or a reload returns the existing one. An attempt the
engine lost contact with (restart, shutdown) is shown as "contact lost; verify
in the harness" and retains its reservation. The result remains attached to
that attempt after navigation or reload. Owned Codex attempts expose a stop
request separately from native interruption confirmation; neither a timeout
nor turn interruption proves every descendant has stopped.

The review covers one fixed commit and its bounded patch, with binary files,
omissions and dirty working-tree limits stated. Codex checks the same account
again at launch and sends the patch through the protocol. API authentication,
unknown capacity, explicit quota denials and unverified execution policy are
refused. Enabled or unknown credits also refuse generation: the qualified CLI
0.163.0 exposes no per-turn no-credit guarantee. The app does not change credit
settings, activate resets or silently choose another model or account.

### 10. Give a harness session the Work context of its checkout

A Claude Code or Codex session can ask what is waiting, what was decided and
what is linked for the checkout or project it works in, from the same data as
the Work view ([ADR 0058](docs/adr/0058-harness-sessions-read-work-context-through-one-bounded-projection.md)).
Both forms read the usage store read-only, start no engine and never write:

```sh
bun run cli -- work context --checkout "$PWD" --json   # this checkout and paths inside it
bun run cli -- work context --project-label ai-usage   # the project directory's name, exact
bun run cli -- work context --checkout /src/project --checkout /src/known-worktree --since-days 180 --json
```

The local stdio MCP server (`bun run mcp`) exposes the same read as the
read-only tool `work.context`, with exactly one of `checkoutPath` (absolute),
`checkoutPaths` (up to ten explicitly known worktrees) or `projectLabel`.
`sinceDays` accepts 1–3650, default 30. Scope is applied before the bounded
selection, so unrelated projects cannot occupy the requested project's page.
Adding the tool registers nothing: the server is still
registered only by your explicit `bun run mcp:register:codex` (or your own
harness configuration).

The answer (`schemaVersion` 1) has `waiting` (human requests and external
waits with dated declarations or supported native request evidence),
`decisions` (attributable native outcomes, each with its evidence), `linked`
(pull request, checkout and Jira facts), bounded `sessions` references and
`coverage`. A later message or completed child alone never answers a request.
Coverage states per harness what was read: Claude Desktop declarations and
supported Codex structured requests from selected sessions (at most twenty
Codex campaigns, with selected members and omissions counted). An asynchronous
tool acknowledgement is not a human answer; general Codex turn status and
unrecorded requests remain unknown. OpenCode, Cursor and
Claude Code sessions started outside Claude Desktop are not represented, no
transcript is read, and quiet roots older than the window are left out. Lists are bounded (at most
20 waits and 20 decisions) and the whole answer stays under 64 KiB of JSON;
`truncation` says what was left out. A missing or not-yet-upgraded store is an
error (exit 1, or an MCP error such as `store-missing`), never an empty answer.

### 11. Delegate a read-only review from any MCP client

The agent you work with (Claude Code, Codex or any MCP client) can hand a
read-only review of a commit or a `base..head` range to another local harness
through the same stdio MCP server: `delegation.qualify` returns the routes your
rules admit now, the agent chooses one or abstains, `delegation.start` runs it
in the engine, and `delegation.status` reads the job and its result from the
store, so another client can follow it. Rules (professional/personal contexts,
repository, owner, declared GitHub account, Git author, reserves, concurrency,
attempts, identity proof) and the model catalog are edited in **Manage ›
Delegation**, which also simulates a request. Claude Code and Codex run as
workers with their own read-only controls; OpenCode and Cursor are listed as
callers only. Setup, MCP registration for each client, the instruction to give
your agent and the limits are in [`docs/delegation.md`](docs/delegation.md)
([ADR 0077](docs/adr/0077-delegation-independent-of-the-calling-harness.md)).

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

### Interactive report

The web report opens on Overview and lets you:

- switch between **Overview, Sessions, and Analysis**; Analysis keeps the existing breakdown dimensions for Models, Providers, Harnesses, Projects, and Cursor AI;
- open **Campaigns** to explore related agent sessions as a temporal hierarchy, collapse descendants, compare recorded overlap, and open any node in the existing session drawer;
- switch Campaigns to **Project timeline** to compare projects and campaigns on one UTC scale, expand one campaign's sessions, or collapse a project;
- filter by date range with presets or a custom range, and read the activity timeline;
- analyze local Claude, Codex, and OpenCode chronology from the unified session drawer, using each harness's recorded, partial, or unavailable timing semantics;
- inspect source-dependent repository, branch-span, commit, and recorded pull-request facts when the harness owns them;
- show/hide columns (input/output/cache tokens, RTK savings, durations, turns, tools, line deltas, …), sort, and filter by field;

All exploration state (active view, filters, range, sorting, visible columns) is persisted in the URL, so a report link reopens exactly where you left off.
Detailed prompt bodies are read only on demand from the source machine's local history and may be truncated by safety budgets; that separate prompt collection is not added to report revisions, snapshots, sync payloads, or exports. Normal session names can still come from source-provided or prompt-derived titles and are portable report fields. Claude fallback names are technical identifiers rather than prompt bodies. Provider pull-request lookup is also local and on demand: it runs only after an explicit action, and its result remains ephemeral. Claude's session span is never presented as complete active time because recorded turn durations may cover only part of a session. See [session analysis data sources](docs/session-analysis-sources.md) for the exact guarantees and limitations of each harness.

Campaigns are observed root-session groups, including standalone sessions; they
are not durable Work threads. The list is paged, and selecting a campaign loads
its members independently of the list filters. Its Agent Map uses recorded start
and end timestamps in UTC: overlapping session lifetimes do not prove concurrent
active compute. Missing parents, incomplete timing, unloaded members, and partial
token counters are disclosed beside the affected information. Titles reuse
published session labels and existing local campaign names; generic children
inherit parent context without fetching prompts or calling a model. `bun run
demo` includes an isolated example with nested and parallel agents.

The Project timeline reuses the same paged discovery filters. Campaign bounds
cover all recorded members; only the expanded campaign loads individual session
rows. The shared scale fits the loaded campaigns within the selected period, and
clipped intervals are marked. Period filters retain the report's recorded-activity
semantics: they do not search for every session whose lifetime overlaps an
arbitrary historical period. Project bands preserve gaps between campaigns and
do not claim continuous work. `campaignView=timeline` preserves this view in the
URL; a selected campaign outside the loaded page can still open in the Agent Map.

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
- `--json` / `--csv` / `--payload-json`: pick an output format (mutually exclusive)

`merge` accepts one or more snapshot file paths plus the same report options. Add `--local` to include this machine's local history.

Merged CSV/JSON payloads include row provenance (`source.machineLabel`, `source.machineId`, harness key, and source session ID) when available. The terminal table shows `Machine` in `--wide` mode.

## Project layout

- `packages/report-core` (`@ai-usage/report-core`): pure row types, pricing, normalization, analytics, report payloads, and snapshots
- `packages/local-machine` (`@ai-usage/local-machine`): collector-independent hardened local reads, exact Session analysis, machine/config transactions, and test homes
- `packages/local-collectors` (`@ai-usage/local-collectors`): collection-only adapters for Claude, Codex, OpenCode, Cursor, quota, RTK, and commit attribution
- `packages/report-data` (`@ai-usage/report-data`): stored-only and pure report, portable, quota-history, and exact-revision query assembly
- `packages/usage-store` (`@ai-usage/usage-store`): separate read-only/query-only and writer exports over durable SQLite facts and served projections
- `packages/usage-engine-control` (`@ai-usage/usage-engine-control`): strict authenticated loopback commands, status, bounded events, rendezvous, and handoffs
- `packages/usage-engine-runtime` (`@ai-usage/usage-engine-runtime`): the deep write-side scheduler, adapters, mutations, publication, recovery, and retention service
- `apps/usage-engine`: the sole production writer composition root and control server
- `docs/session-analysis-sources.md`: provenance, quality, privacy, and known limitations of per-session analysis for each harness
- `packages/skills` (`@ai-usage/skills`): local skill inventory, validation, projection, and reconciliation workflows
- `packages/design-system` (`@ai-usage/design-system`): Panda/Svelte primitives, report style slots, and generated Panda consumer exports
- `apps/cli`: read-only stored reports plus bounded engine-client/foreground fresh and mutating commands, portable snapshots, and output adapters
- `apps/web`: read-only SvelteKit SSR/UI with an oRPC endpoint, control proxies, `/sources`, local Skills, and file-only `/sync` workspaces

Architecture docs (`docs/README.md` maps them all):

- `docs/architecture.md`: package ownership, data flow, adapter rules, and guardrails
- `docs/adr/README.md`: the architecture decision index — runtime, boundary, and product invariants
- `CONTEXT.md`: the ubiquitous language of the usage-reporting domain
- `docs/future-work.md`: global backlog for known follow-ups
- `docs/public-package-interfaces.md`: public package exports and import rules
- `docs/generated-tooling-ownership.md`: Panda/SvelteKit/Vite/Turbo generated file ownership

## Development

Run the app against deterministic synthetic data without reading local histories:

```sh
bun run demo
```

This isolated runtime binds only to `127.0.0.1`, uses a temporary home, and disables local reads, mutations, source events, and live collector construction. It is intended for development, reproduction, and browser tests.

Typecheck:

```sh
bun run typecheck
```

Lint:

```sh
bun run lint
```

Format:

```sh
bun run fix
```

Run unit/integration tests:

```sh
bun run test
```

Run the deterministic browser suites (after `bun x playwright install chromium` once):

```sh
bun run test:e2e
bun run test:e2e-demo
```

After a production build, exercise the supervised loopback lifecycle and the
direct revision-keyed SQLite query path:

```sh
bun run test:web-production
bun run test:web-dev-build-isolation
bun run test:e2e-production
bun run --cwd apps/web benchmark:session-scroll
```

After the build, verify that server-only capabilities stay out of the emitted
browser closure:

```sh
bun run test:web-client-manifest
```

The ordinary suite includes request-policy coverage, axe accessibility checks,
and four focused visual snapshots. The demo-isolation suite proves the synthetic
runtime cannot reach local data or control capabilities. The production suite
exercises exact-revision oRPC procedures, verifies explicit secret sentinels stay
out of initial SSR HTML, and runs the 5,000-session scroll proof. Useful bounded
report data is intentionally allowed in the initial payload.

Run the report app in development:

```sh
bun run dev
```

This supervises persistent usage-engine and Web tasks with attributable logs.
Web HMR does not restart the engine or trigger collection/publication.
SvelteKit keeps check, development, and production intermediates in separate
`.svelte-kit/{check,dev,build}` trees. The Bun adapter writes production output
to `.output-build/sveltekit`, and concurrent production builds fail through a
narrow lock without deleting active development files.

The dev runtime intentionally reads this machine's configured local data and
refreshes the dashboard through immutable, destination-focused SQLite queries.
Its bounded support bootstrap reports omitted-item counts when summary metadata
does not fit; row-derived destination queries remain independent of those
summary omissions. A failed live bootstrap stays in the route's error/retry
state. Synthetic data is selected only by explicit demo or E2E modes.

After `bun run build`, start the normal supervised production pair with:

```sh
bun run start
```

`bun run start:web-only` is an explicit diagnostic that reads an existing store
and never starts an engine.

## Notes

- **`$API`** is an estimated cost at standard API prices, computed from local token counters and the editable pricing table in `packages/report-core/src/pricing.ts`. A `≥` value is the known subtotal when only some model segments have pricing; wholly unpriced usage remains unknown.
- **`$Actual`** is out-of-pocket spend when a harness reports it. Subscription products bill differently from per-token API rates, so the two columns can diverge.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and synthetic-fixture guidance and [SECURITY.md](SECURITY.md) for private vulnerability reporting. ai-usage is available under the [MIT License](LICENSE).
