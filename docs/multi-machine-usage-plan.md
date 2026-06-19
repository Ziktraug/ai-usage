# Multi-Machine Usage Merge Plan

## Context

`ai-usage` currently reports usage from local history on one machine. Some users work across multiple machines, for example a MacBook and a Linux PC, so their harness usage is split across separate local histories.

The goal is to merge usage rows from multiple machines while preserving the current local-history-only model. Provider APIs should not be called.

## Goals

- Export usage from one machine as a portable snapshot.
- Merge snapshots from multiple machines into one report.
- Keep existing report outputs: terminal table, JSON, CSV, and HTML.
- Deduplicate repeated imports of the same snapshot or newer snapshots from the same machine.
- Show where each session came from, such as `MacBook Pro` or `Linux PC`.
- Let users group multiple local folders under one logical project name.
- Provide an ergonomic setup UI for reviewing sources, project folders, and merge suggestions.

## Non-Goals

- Do not sync raw local history directories between machines in V1.
- Do not read SQLite databases over a network share in V1.
- Do not add a cloud service.
- Do not call provider APIs.
- Do not require a LAN server for the first version.
- Do not commit user-specific machine, folder, or business-domain knowledge into this repo.

## Recommended Direction

Build snapshot import/export first. Add LAN transport later as a convenience layer around the same snapshot format.

```txt
Machine A local history -> usage snapshot
Machine B local history -> usage snapshot
snapshots + optional local rows -> merge -> report
```

This keeps collection local to each machine and avoids platform-specific path issues, SQLite lock issues, and unnecessary exposure of raw local history.

## User Workflows

### Manual Snapshot Flow

On the Mac:

```sh
ai-usage snapshot --out ~/Desktop/macbook-ai-usage.json
```

Copy the file to the PC through AirDrop, SMB, Syncthing, `scp`, or any other file transfer.

On the PC:

```sh
ai-usage merge ~/Downloads/macbook-ai-usage.json --local --html
```

### Snapshot Folder Flow

If snapshots are synced into one folder:

```sh
ai-usage merge ~/.ai-usage/snapshots/*.json --local
```

### Future LAN Flow

On the Mac:

```sh
ai-usage serve --host 0.0.0.0 --port 3847 --token <token>
```

On the PC:

```sh
ai-usage merge --remote http://macbook.local:3847/snapshot --token <token> --local
```

The LAN server should only serve normalized snapshots, not raw local history.

## Snapshot Format

Create a versioned usage snapshot format separate from the existing report payload.

Decision: keep source metadata separate from the core `Row` model, but preserve it through snapshot merge and UI serialization. The existing `Row` remains the usage/reporting model; `SnapshotUsageRow` and UI serialized rows can carry provenance.

```ts
interface UsageSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  generatedAt: string;
  machine: UsageMachine;
  source: UsageSnapshotSource;
  rows: SnapshotUsageRow[];
  facets?: Record<string, unknown>;
}

interface UsageMachine {
  id: string;
  label: string;
}

interface UsageSnapshotSource {
  appVersion: string | null;
  platform: 'macos' | 'linux' | 'windows';
  hostname?: string;
}

interface SnapshotUsageRow extends SerializedRow {
  source: UsageRowSource;
}

interface UsageRowSource {
  machineId: string;
  machineLabel: string;
  harnessKey: 'claude' | 'codex' | 'opencode' | 'cursor';
  sourceSessionId: string | null;
  sourcePath?: string | null;
}
```

The existing `UsageReportPayload` should remain a report format. A snapshot is source data. A merged report can be rendered back into the existing report payload shape.

For UI use, merged report payload rows should expose source metadata in a stable optional field:

```ts
interface SerializedRowSource {
  machineId: string;
  machineLabel: string;
  harnessKey: 'claude' | 'codex' | 'opencode' | 'cursor';
  sourceSessionId: string | null;
}

interface SerializedRowWithOptionalSource extends SerializedRow {
  source?: SerializedRowSource;
}
```

This lets the dashboard display and filter by row source without forcing every core `Row` consumer to know about multi-machine provenance.

## Machine Identity

Each machine needs a stable local ID stored outside the repo.

Suggested file:

```txt
~/.config/ai-usage/machine.json
```

Example:

```json
{
  "id": "macbook-pro-8f3a9c21",
  "label": "MacBook Pro"
}
```

The ID should be generated once and reused. The label should be user-editable.

Potential commands:

```sh
ai-usage machine
ai-usage machine set-label "MacBook Pro"
```

## Session Provenance Column

Yes, the report should have a column showing where the session came from.

Suggested column name: `Machine`.

Examples:

```txt
MacBook Pro
Linux PC
Workstation
```

For compact terminal output, this could be hidden by default and shown with `--wide` or a future `--columns` option.

For HTML, it should become:

- a session table column;
- a filter/facet;
- an analytics grouping later, for example usage by machine.

The raw row should keep machine metadata even if the table does not display it by default.

Implementation constraint: provenance must reach the UI payload. It is not enough to use machine data only during merge/dedupe; each displayed session row should still know its source machine.

## Logical Project Grouping

Project overlap is expected. The same logical project can appear under multiple local folders across machines or even on the same machine.

Example:

```txt
/Users/nathan/Code/exalibur
/Users/nathan/work/exalibur
/home/nathan/Projects/Github/exalibur
/home/nathan/tmp/exalibur-spike
```

These may need to appear as one logical project: `exalibur`.

### Recommended Model

Keep two separate concepts:

- `project`: the display/grouping name currently used by reports.
- `projectPath`: the original local path, kept as collector metadata or snapshot source metadata.
- `projectAlias`: an optional logical project name applied by user rules.

For reports, the effective project should be:

```txt
projectAlias ?? project
```

The original path should remain available for debugging, but should not be required in the default UI.

### Config File

Add a config file for project aliases.

Suggested path:

```txt
~/.config/ai-usage/config.json
```

This should be user-local only. The project should not support committed project alias config in V1 because this repo should remain open-sourceable and must not encode user-specific business/project knowledge.

Example:

```json
{
  "projectAliases": [
    {
      "name": "exalibur",
      "match": [
        "*/exalibur",
        "*/exalibur-*",
        "/Users/nathan/work/exalibur",
        "/home/nathan/Projects/Github/exalibur"
      ]
    }
  ]
}
```

### Matching Rules

Rules should be ergonomic and predictable:

- Match against normalized absolute `projectPath` when available.
- Also match against the current `project` basename as a fallback.
- Support simple glob patterns.
- First matching alias wins.
- If no rule matches, keep the existing project name.

### CLI Helpers

Manual JSON editing is acceptable for V1, but helper commands would make this much nicer.

Potential commands:

```sh
ai-usage projects list
ai-usage projects aliases
ai-usage projects alias exalibur "*/exalibur" "*/exalibur-*"
```

Useful output for discovery:

```sh
ai-usage projects list --paths
```

Example output:

```txt
Project      Machine      Path
exalibur    MacBook Pro   /Users/nathan/work/exalibur
exalibur    Linux PC      /home/nathan/Projects/Github/exalibur
exalibur    MacBook Pro   /Users/nathan/tmp/exalibur-spike
```

This makes it easy to decide which folders should be grouped.

### Setup UI

The preferred long-term interface for project grouping is a local setup UI rather than manual config editing.

Potential command:

```sh
ai-usage setup
```

or:

```sh
ai-usage setup --web
```

The setup UI should run locally and summarize detected sources:

```txt
Machine      Harness    Project basename    Path                                  Sessions    Tokens
MacBook Pro  Claude     exalibur            /Users/nathan/work/exalibur            18          2.1M
Linux PC     Codex      exalibur            /home/nathan/Projects/Github/exalibur  12          1.4M
MacBook Pro  Cursor     exalibur-spike      /Users/nathan/tmp/exalibur-spike       4           210k
```

The UI should let the user:

- select multiple detected project sources;
- merge them into a logical project name;
- rename a logical project;
- unmerge a source from a logical project;
- review the impact before saving;
- save to the user-local config only.

The setup UI can offer suggestions, but should not silently merge projects without user confirmation.

Suggested suggestions:

- same basename across machines;
- same Git remote URL when detectable;
- same nearest Git repo name;
- paths with common suffixes such as `exalibur`, `exalibur-main`, or `exalibur-spike`.

The saved config can still use `projectAliases`, but users should not need to edit it manually for common workflows.

Git metadata is allowed as a suggestion signal in V1, but should never auto-merge projects without user confirmation. When available, the setup UI should explain the signal used, for example `same basename + same Git remote`.

## Deduplication

Primary dedupe key:

```txt
machineId + harnessKey + sourceSessionId
```

If `sourceSessionId` is missing, fallback to a heuristic key:

```txt
machineId + harness + activeDate + model + effectiveProject + name + tokenTotal
```

Conflict rule:

- If duplicate rows are identical, drop duplicates silently.
- If duplicate rows differ, keep the row from the newest snapshot.
- Emit a merge warning for differing duplicate rows.

This handles the common case where a session was still active during the first snapshot and has more complete usage in a later snapshot.

## Collector Changes Needed

Collectors currently know source IDs but do not expose them in public rows. Add source metadata before stripping collector metadata.

Expected source IDs:

| Harness | Source session ID |
| --- | --- |
| Claude | JSONL filename or `history.sessionId` |
| Codex | `payload.id` |
| OpenCode | `session.id` |
| Cursor | `composerId` |

The public report can hide these IDs, but snapshots need them.

## Report Changes Needed

### Terminal

Add `Machine` to wide output first.

Later options:

```sh
ai-usage merge snapshots/*.json --columns machine,session,project,tokens,cost
```

### CSV

Include machine columns because CSV is for analysis.

Suggested columns:

```txt
machine,machineId,harness,provider,project,session,model,...
```

### JSON

Keep source metadata in JSON output unless explicitly stripped.

### HTML

Add `Machine` as:

- a table column;
- a search field;
- a filter facet;
- later, a dashboard grouping.

HTML rows should read `row.source?.machineLabel` for display. If source metadata is missing, the UI should show `This machine` or `Unknown machine` rather than breaking older payloads.

## Proposed Implementation Phases

### Phase 1: Source Metadata

- Add row source metadata type.
- Preserve source session IDs from collectors.
- Keep existing report behavior unchanged.
- Add tests for each harness source ID.

### Phase 2: Machine Config and Snapshot Export

- Add machine config creation/loading.
- Add `snapshot` command.
- Write versioned snapshot JSON.
- Validate snapshot structure in tests.

### Phase 3: Snapshot Merge

- Add snapshot parser.
- Add merge/dedupe logic.
- Add `merge` command.
- Support existing report filters over merged rows.
- Support `--local` to include current machine rows.

### Phase 4: Project Aliases

- Add config file with `projectAliases`.
- Apply aliases before filtering, grouping, and analytics.
- Add `projects list --paths` for discovery.
- Add docs with examples.

### Phase 5: Machine Column

- Add machine data to serialized rows.
- Show `Machine` in CSV and JSON.
- Add terminal `--wide` machine column.
- Add HTML machine column and filter.

### Phase 6: LAN Transport

- Add `serve` command.
- Serve snapshots only.
- Require token for non-localhost bind.
- Add `--remote` merge input.

## Implementation Tickets

These tickets are intentionally vertical slices. Each ticket should leave the app in a useful, testable state and should avoid building isolated infrastructure that is not exercised by a user-facing path.

### Ticket 1: Add Source Metadata to Local Report JSON

Goal: expose provenance for locally collected rows without changing the default terminal report.

User-visible outcome:

```sh
ai-usage --json
```

can include optional source metadata for each row, enough for future snapshot and UI work.

Scope:

- Add an internal sourced row type that pairs a `Row` with source metadata.
- Preserve source session IDs from collectors.
- Serialize optional source metadata for JSON/payload output.
- Keep existing terminal table behavior unchanged.

Likely files:

- `packages/report-core/src/types.ts`
- `packages/report-core/src/report-data.ts`
- `packages/local-collectors/src/collectors/claude.ts`
- `packages/local-collectors/src/collectors/codex.ts`
- `packages/local-collectors/src/collectors/opencode.ts`
- `packages/local-collectors/src/collectors/cursor.ts`
- `packages/local-collectors/src/collectors/index.ts`
- `apps/cli/src/report.test.ts`
- collector tests under `packages/local-collectors/src/*.test.ts`

Acceptance criteria:

- Claude rows expose a source session ID based on the JSONL filename or history fallback session ID.
- Codex rows expose `payload.id` as source session ID.
- OpenCode rows expose `session.id` as source session ID.
- Cursor rows expose `composerId` as source session ID.
- Existing table output remains unchanged.
- Existing tests pass.

Notes:

- Do not add machine identity in this ticket unless needed for the chosen type shape.
- Do not implement merge in this ticket.

### Ticket 2: Snapshot Export With Machine Identity

Goal: create a portable usage snapshot from the current machine.

User-visible outcome:

```sh
ai-usage snapshot --out ./my-machine-ai-usage.json
```

Scope:

- Add user-local machine config loading/creation.
- Add `snapshot` CLI command.
- Export `UsageSnapshot` with `schemaVersion`, `snapshotId`, `generatedAt`, `machine`, `source`, `rows`, and optional `facets`.
- Include source metadata on every snapshot row.
- Document the command in `README.md`.

Likely files:

- `apps/cli/src/cli.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/runtime.ts`
- `packages/report-core/src/snapshot.ts`
- `packages/local-collectors/src/local-history.ts` or a new config module
- `README.md`
- `apps/cli/src/cli.test.ts`
- `apps/cli/src/report.test.ts` or new snapshot tests

Acceptance criteria:

- First snapshot run creates a stable local machine config if none exists.
- Repeated snapshot runs reuse the same machine ID.
- Snapshot JSON validates against the expected shape.
- Snapshot rows include machine and source session metadata.
- Snapshot export supports existing report filters where reasonable, or explicitly exports all rows and documents that behavior.
- Snapshot command does not call provider APIs.

Open implementation decision:

- Prefer exporting all rows by default. Filtering should happen during report/merge, not during snapshot creation.

### Ticket 3: Merge Snapshot Files Into a Report

Goal: allow a user to generate a normal report from one or more snapshot files.

User-visible outcome:

```sh
ai-usage merge ./snapshots/*.json --html
ai-usage merge ./snapshots/*.json --json
```

Scope:

- Add snapshot parser and validation.
- Add merge command.
- Deduplicate rows by `machineId + harnessKey + sourceSessionId`.
- Reuse existing report filters and renderers.
- Emit clear warnings for invalid snapshots and conflicting duplicate rows.

Likely files:

- `apps/cli/src/cli.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/report.ts`
- `packages/report-core/src/snapshot.ts`
- `packages/report-core/src/report-data.ts`
- `apps/cli/src/cli.test.ts`
- new merge tests under `apps/cli/src/`

Acceptance criteria:

- Merging one snapshot produces the same rows as the snapshot contains.
- Merging the same snapshot twice does not duplicate sessions.
- Merging an older and newer snapshot from the same machine keeps the newer duplicate row.
- Existing filters such as `--since`, `--project`, `--harness`, `--limit`, `--sort`, and `--min-tokens` work with merged rows.
- `--html`, `--json`, and `--csv` work with merged rows.

Notes:

- `--local` is intentionally deferred to Ticket 4 to keep this ticket focused.

### Ticket 4: Merge Snapshots Plus Current Local History

Goal: make the common Mac-to-PC workflow ergonomic by merging imported snapshots with current machine usage.

User-visible outcome:

```sh
ai-usage merge ./snapshots/macbook.json --local --html
```

Scope:

- Add `--local` to the merge command.
- Collect current machine rows and convert them to snapshot-compatible sourced rows in memory.
- Merge local rows with file snapshots through the same dedupe path.
- Ensure local rows have the current machine ID/label.

Likely files:

- `apps/cli/src/cli.ts`
- `apps/cli/src/main.ts`
- `packages/report-core/src/snapshot.ts`
- local collector source metadata code from Ticket 1
- merge tests under `apps/cli/src/`

Acceptance criteria:

- `merge snapshot.json --local` includes both snapshot and current local rows.
- Local rows dedupe correctly if the same machine snapshot is also provided.
- Machine source metadata is present for both local and imported rows.
- Existing report filters work across local and imported rows together.

### Ticket 5: Machine Column in CSV, JSON, and HTML Payload

Goal: make the origin of each session visible to users.

User-visible outcome:

- CSV includes machine columns.
- JSON/payload rows include `source.machineLabel`.
- HTML can display/filter machine provenance.

Scope:

- Extend serialized report rows with optional source metadata.
- Add machine fields to CSV output.
- Add `Machine` to the HTML dashboard session table.
- Include machine metadata in dashboard search text.
- Add a machine filter/facet if it fits the existing dashboard architecture.

Likely files:

- `packages/report-core/src/report-data.ts`
- `apps/cli/src/render/csv.ts`
- `apps/web/src/shared.tsx`
- `apps/web/src/Dashboard.tsx`
- dashboard tests under `apps/web/src/`

Acceptance criteria:

- A merged HTML report shows the source machine for each session row.
- CSV output has `machine` and `machineId` columns when source metadata is present.
- Older payloads without source metadata still render.
- Dashboard search can find rows by machine label.

### Ticket 6: Project Source Discovery

Goal: help users see duplicate/overlapping project folders before configuring aliases.

User-visible outcome:

```sh
ai-usage projects list --paths
```

Scope:

- Add a command that summarizes detected project sources from local rows and/or snapshots.
- Include machine label, harness, project basename, source path when available, session count, and token total.
- Use source metadata and collector project path metadata where available.
- Do not write config in this ticket.

Likely files:

- `apps/cli/src/cli.ts`
- `apps/cli/src/main.ts`
- `packages/report-core/src/snapshot.ts`
- `packages/report-core/src/usage-row.ts`
- `apps/cli/src/render/` for a small table renderer if needed

Acceptance criteria:

- Command lists project sources for current local history.
- Command can optionally read snapshot files if that fits the CLI shape.
- Output is useful for spotting `exalibur` across Mac and PC.
- No project aliases are applied yet unless existing config already supports them.

### Ticket 7: User-Local Project Alias Config

Goal: allow multiple project folders to be grouped under one logical project name.

User-visible outcome:

```json
{
  "projectAliases": [
    {
      "name": "exalibur",
      "match": ["*/exalibur", "*/exalibur-*"]
    }
  ]
}
```

Scope:

- Load user-local config from `~/.config/ai-usage/config.json`.
- Apply project aliases before filtering, grouping, analytics, and rendering.
- Match against normalized source path when available.
- Fallback to matching current project basename.
- Add tests for first-match-wins behavior.

Likely files:

- new config module under `packages/report-core/src/` or `packages/local-collectors/src/`
- `packages/report-core/src/report-data.ts`
- `apps/cli/src/main.ts`
- `apps/web/src/` only if needed after serialization
- tests under `packages/report-core/src/`

Acceptance criteria:

- Rows from different folders can appear under one effective project name.
- `--project exalibur` matches aliased rows.
- Analytics project grouping uses the alias.
- Config remains user-local only and is not committed.
- Missing config is not an error.

### Ticket 8: Project Merge Setup UI Prototype

Goal: provide an ergonomic local UI for configuring project aliases without manual JSON editing.

User-visible outcome:

```sh
ai-usage setup --web
```

Scope:

- Build a local setup view that lists project sources.
- Let the user select sources and merge them into a logical project name.
- Save the result to user-local config.
- Show suggestions based on basename and Git metadata when available.
- Require explicit confirmation before saving merges.

Likely files:

- `apps/web` if reusing the Solid app shell
- `apps/cli/src/` for command and local server/bootstrap
- project discovery code from Ticket 6
- user-local config code from Ticket 7

Acceptance criteria:

- UI shows machine, harness, project basename, path, sessions, and tokens.
- UI can create an alias grouping multiple sources.
- Saved config affects the next report run.
- Suggestions explain their reason, such as `same basename + same Git remote`.
- No alias is saved without user confirmation.

Notes:

- This can start as a prototype after Ticket 6 and Ticket 7 exist.
- It should not introduce committed user-specific project knowledge.

### Ticket 9: LAN Snapshot Transport

Goal: avoid manual file copy once snapshot merge is stable.

User-visible outcome:

```sh
ai-usage serve --host 0.0.0.0 --port 3847 --token <token>
ai-usage merge --remote http://macbook.local:3847/snapshot --token <token> --local
```

Scope:

- Add a local HTTP server that serves the current machine snapshot.
- Add remote snapshot fetching to merge.
- Bind to localhost by default.
- Require token when binding outside localhost.
- Serve normalized snapshots only, never raw local history.

Likely files:

- `apps/cli/src/cli.ts`
- `apps/cli/src/main.ts`
- `packages/report-core/src/snapshot.ts`
- possibly new server module under `apps/cli/src/`

Acceptance criteria:

- Localhost server can serve a valid snapshot.
- LAN binding without token is rejected.
- Merge can fetch and include a remote snapshot.
- Network errors produce clear messages.
- No raw local history file paths are served beyond intended source metadata.

## Open Questions

- Should `Machine` be shown in the default terminal table, or only in `--wide`?
- Should alias matching use only paths, or also allow matching by machine label plus path?
- Should `merge --local` be default, or explicit?
- Should LAN remotes be configured in JSON, CLI flags, or both?

## Initial Recommendation

- Make snapshots the core abstraction.
- Make machine provenance first-class metadata.
- Add `Machine` as a column/facet.
- Add user-local project alias rules based on setup UI selections, with `projectAlias ?? project` as the effective report project.
- Add LAN only after snapshot merge works well manually.
