# Project Grouping Architecture Plan

## Problem

Multi-machine reporting currently preserves session provenance, but project reporting is still too close to the raw `project` string. This creates two opposite failure modes:

- projects with the same basename on different machines can be grouped accidentally;
- projects that should be one logical project, such as `exalibur`, `exalibur2`, and `exalibur3`, require an explicit grouping workflow that is not available in the dashboard.

The architecture must distinguish raw facts from report-time grouping decisions.

## Decisions

### Usage rows remain facts

`UsageRow` should represent normalized session facts from local history. It should carry raw project provenance, not report grouping state.

Rows may carry:

- `project`: detected project name or basename;
- `source.machineId`: stable machine identity;
- `source.machineLabel`: human-readable machine name;
- `source.sourcePath`: local project path when known;
- `source.harnessKey` and `source.sourceSessionId`: harness/session identity.

Rows should not carry:

- `projectAlias`;
- `projectGroup`;
- dashboard grouping labels;
- user-local grouping preferences.

### Multi-machine merge remains session merge

`usage-store`, snapshots, and merge bundles own session transport and deduplication. They should not decide which projects are equivalent.

They should preserve:

- row facts;
- machine provenance;
- source path;
- session identity;
- warning metadata.

They should not persist:

- project grouping choices;
- dashboard labels;
- UI expansion state.

### Project grouping is a report projection

Project grouping should be calculated by report orchestration after rows are collected or loaded from the usage store.

`report-data` should apply project grouping config and emit a report payload that includes enough project grouping metadata for the dashboard to render and edit groups.

This keeps grouping deterministic and shared by CLI, HTML export, and the web dashboard without mutating stored usage facts.

After `report-data` applies project grouping, downstream apps should see logical projects as native report projects. `apps/web` should not carry grouping rules or reinterpret raw projects independently. Analytics, filtering, global metric views, the session table, and the Projects tab should all consume the same projected project identity.

### Persistence belongs to user-local config

Project grouping is a local reporting preference. It belongs in `~/.config/ai-usage/config.json`, owned by `@ai-usage/local-collectors` config helpers.

Reasoning:

- the config already owns machine-local identity and report preferences;
- different machines can intentionally use different grouping views;
- grouping should survive refreshes, stored peer imports, and LAN merges;
- grouping should not be embedded in snapshots or merge bundles.

## Target Domain Model

### Project Source

A project source is a detected project location in the merged report input.

```ts
interface ProjectSource {
  id: string;
  project: string;
  machineId: string;
  machineLabel: string;
  sourcePath: string;
  harnessKey: string;
  harness: string;
  gitRemote?: string;
  sessions: number;
  tokens: number;
}
```

`id` must be stable and internal. Use folder identity, not harness identity:

```ts
[machineId, sourcePath || project].join('|')
```

Reasoning: a project group is about a project folder on a machine. Codex, Claude, Cursor, and OpenCode sessions in the same folder should roll up to the same project source instead of producing one source per harness.

### Project Group Config

Project group config is persisted locally.

```ts
interface ProjectGroupConfig {
  id: string;
  name: string;
  sources: ProjectSourceSelector[];
}

interface ProjectSourceSelector {
  machineId?: string;
  sourcePath?: string;
  project?: string;
  gitRemote?: string;
}
```

Recommended selector strength:

1. `machineId + sourcePath`: strongest and preferred.
2. `machineId + project`: acceptable fallback when path is unavailable.
3. `gitRemote`: useful for suggestions, but not always available and not always unique.
4. `project` alone: legacy compatibility only; too broad for multi-machine grouping.

`machineLabel` should not be a selector key because it is mutable. It can be kept in UI metadata or diagnostics only.

### Report Project Group

The report payload should expose computed project groups.

```ts
interface ReportProjectGroup {
  id: string;
  name: string;
  grouped: boolean;
  sources: ProjectSource[];
  sessions: number;
  tokens: number;
  costApprox: number;
  linesAdded: number;
  linesDeleted: number;
  turns: number;
  tools: number;
}
```

Group ids:

- explicit groups use `group:${ProjectGroupConfig.id}`;
- ungrouped project sources use `source:${ProjectSource.id}`;
- legacy aliases use `legacy-alias:${alias.name}` until migrated.

For ungrouped sources, `grouped` is `false` and `sources` contains one project source.

For explicit user groups, `grouped` is `true` and `sources` contains every selected source.

### Projected Usage Row

Report payload rows should expose the report-time project identity while preserving raw provenance for inspection.

```ts
interface ProjectedUsageRow extends SerializedUsageRow {
  project: string;
  rawProject: string;
  projectGroupId: string;
  projectSourceId: string;
}
```

Rules:

- `project` is the logical project name after grouping and is the value used by global analytics, filters, CSV, and session table project display;
- `rawProject` preserves the collector-detected project name;
- `projectGroupId` identifies the logical project group, explicit or ungrouped;
- `projectSourceId` identifies the raw project source matched by this row.

The exact field names can change during implementation, but the payload must carry both logical project identity and raw project provenance.

### Project Group Warnings

Configured project groups can become stale when paths move, machines are renamed/recreated, or historical sources disappear. The report projection should emit warnings when persisted config does not fully match current report sources.

Warning cases:

- group has no matching sources;
- group has some matching selectors and some unmatched selectors;
- selector is too broad and matches multiple project sources when it was expected to match one source;
- legacy alias applies broadly enough that the UI cannot safely edit it as precise source selectors.

Warnings should be part of the report payload and actionable in the UI. The UI should offer at least:

- cleanup unmatched selectors;
- edit the group;
- delete the group.

Placement decision: project grouping warnings should appear in the existing global report warnings panel. They may also be deep-linked to the Projects tab, but the global panel is the canonical alert surface because stale project grouping changes analytics, filtering, CSV, and session table project identity across the whole report.

## Display Rules

### Human Labels

The dashboard should display machine names, not machine ids.

Default ungrouped label:

```txt
Exalibur · MacBook Pro
```

If two machines have the same label, the UI may disambiguate with a short machine id in a tooltip or suffix:

```txt
Exalibur · MacBook Pro · 87df7ab3
```

The full UUID should not be the default visible label.

### Grouped Labels

Explicit groups display only the configured group name:

```txt
exalibur
```

The row should expose source details through expansion, drawer, or tooltip:

- `Exalibur · MacBook Pro`;
- `Exalibur · Desktop`;
- `Exalibur2 · MacBook Pro`;
- `Exalibur3 · MacBook Pro`.

### Filtering

Filtering by project should match:

- group name;
- logical projected project name;
- raw project name;
- machine label;
- source path when available.

This lets a user search `exalibur`, `MacBook`, or a path fragment.

## Ownership

### `@ai-usage/report-core`

Owns pure project grouping types and deterministic matching helpers.

Candidate module:

```txt
packages/report-core/src/project-group.ts
```

Responsibilities:

- `ProjectGroupConfig` types;
- `ProjectSourceSelector` types;
- selector matching logic;
- stable group/source key helpers;
- legacy `projectAliases` compatibility helpers if kept.

Must not read filesystem, SQLite, machine config, or browser state.

### `@ai-usage/local-collectors`

Owns user-local config persistence.

Responsibilities:

- extend `AiUsageConfig` with `projectGroups`;
- validate `projectGroups`;
- read/write config through existing config helpers;
- keep `projectAliases` readable during migration.

Project groups are user-local by default. The first implementation should read and write them only from the home config. Repo config can keep legacy `projectAliases`, but repo-level `projectGroups` should not be introduced until there is an explicit team/shared-config requirement.

### `@ai-usage/report-data`

Owns report-time orchestration.

Responsibilities:

- collect or load rows;
- build `ProjectSource[]`;
- apply `projectGroups`;
- project rows so logical grouped projects behave as native report projects;
- emit `ReportProjectGroup[]` or equivalent payload metadata;
- emit project grouping warnings for stale or partial config;
- keep CLI, HTML export, and web dashboard consistent.

### `@ai-usage/usage-store`

Owns persisted usage facts only.

Responsibilities:

- store rows and row provenance;
- query active report rows;
- import/export merge bundles.

Non-responsibilities:

- project grouping persistence;
- group matching;
- dashboard labels.

### `@ai-usage/usage-merge`

Owns LAN/manual merge workflow only.

Responsibilities:

- authenticate peers;
- fetch/import merge bundles;
- update trusted peer state.

Non-responsibilities:

- project grouping;
- alias config;
- report UI projection.

### `apps/web`

Owns interactive editing and rendering.

Responsibilities:

- show grouped and ungrouped project rows;
- let users select sources and create/update/delete groups;
- call server functions to persist config;
- render machine labels, not raw ids;
- show source details for grouped rows.
- display project grouping warnings and offer cleanup/edit actions.

### `apps/cli`

Owns terminal commands and setup adapters.

Responsibilities:

- keep `projects list` useful for source discovery;
- optionally expose project group CRUD commands;
- keep legacy setup UI working until superseded.

## Persistence Flow

1. User opens dashboard.
2. Server creates report payload from local/stored/merged rows.
3. `report-data` reads `AiUsageConfig.projectGroups`.
4. `report-data` builds project sources and report project groups.
5. Dashboard renders project groups.
6. User selects multiple project sources and clicks `Group`.
7. Web server function reads current config, writes updated `projectGroups`, and returns success.
8. Dashboard refreshes payload; grouping is now applied consistently.

The persisted config stores selectors, not row ids from a single report payload. Row ids are useful for UI selection during one session, but config must survive refreshed collection.

Config writes must be patch-style:

- read the current `AiUsageConfig`;
- replace only `projectGroups`;
- preserve `cursor`, `sync`, and legacy `projectAliases`;
- write through the existing local config helper.

If persisted config partially or fully fails to match current sources, the config should not be silently rewritten during report creation. Reporting emits warnings; cleanup or edits happen only through explicit user action.

## Legacy Alias Migration

Existing `projectAliases` should remain supported temporarily.

Compatibility behavior:

- treat each alias as a broad legacy group;
- convert each glob match into selector-style matching at report time;
- mark it as legacy internally so the UI can show it as editable but broad.

Long-term migration:

1. Add `projectGroups` while keeping `projectAliases`.
2. Dashboard writes new groups only to `projectGroups`.
3. CLI/setup can offer to convert aliases to groups once sources are known.
4. After enough time, deprecate `projectAliases` documentation.

## UI Plan

### Project Tab

The project tab should become source-aware.

Suggested columns:

- Project / Group;
- Machine;
- Sources;
- Sessions;
- Fresh;
- Cache;
- `$API`;
- Lines;
- Turns;
- Tools.

Ungrouped rows show one source and its machine label.

Grouped rows show the group name, source count, and can expand to show included sources.

### Grouping Interaction

Minimum viable interaction:

1. Add checkboxes to project source rows.
2. Add `Group` action.
3. Prompt or inline input for group name.
4. Persist `ProjectGroupConfig`.
5. Refresh report payload.

Required follow-up interactions:

- add source to existing group;
- remove source from group;
- rename group;
- delete group;
- cleanup unmatched selectors from a warning;
- suggested groups by git remote or basename.

Grouping is global to the report payload. The Projects tab is where groups are edited, but all dashboard views should consume the same logical project identity produced by `report-data`.

## Implementation Plan

This section is intended to be picked up by implementation agents. Each phase should be completed with tests before moving to the next phase. Do not combine phases unless explicitly requested.

### Phase 1: Revert Leaky Row-Level Alias State

- Remove `projectAlias` from `UsageRow`.
- Remove snapshot and merge-bundle preservation of `projectAlias`.
- Restore row facts as the only persisted/transported usage data.
- Keep tests that assert snapshots and merge bundles preserve provenance only.

Acceptance criteria:

- no `projectAlias` field exists in `packages/report-core/src/types.ts`;
- snapshots and merge bundles do not serialize project grouping state;
- `bun --filter @ai-usage/report-core test` passes.

### Phase 2: Add Project Group Domain Types

- Create `packages/report-core/src/project-group.ts`.
- Add `ProjectSourceSelector`, `ProjectGroupConfig`, and matching helpers.
- Export the module from `@ai-usage/report-core`.
- Add unit tests for selector precedence and matching.

Required helper behavior:

- `projectSourceId(source)` returns `[machineId, sourcePath || project].join('|')`;
- selector match prefers `machineId + sourcePath`;
- `machineId + project` works when path is unavailable;
- `project` alone is only for legacy alias compatibility;
- machine label is never used for matching.

Acceptance criteria:

- `packages/report-core/package.json` exports `./project-group`;
- `docs/public-package-interfaces.md` documents `./project-group`;
- focused tests cover same project basename on two machine ids and same path on two machine ids.

### Phase 3: Extend Config Persistence

- Add `projectGroups?: ProjectGroupConfig[]` to `AiUsageConfig`.
- Validate the new shape in `machine-config.ts`.
- Preserve existing merge semantics between home config and repo config.
- Read/write project groups from home config only in the first implementation.
- Preserve existing repo-config support for legacy `projectAliases`.

Acceptance criteria:

- invalid `projectGroups` entries are rejected by config parsing;
- writing project groups preserves unrelated config fields;
- no config write touches repo config.

### Phase 4: Report Projection

- Move project source construction into a reusable `report-data` function.
- Build `ReportProjectGroup[]` from rows plus config.
- Include project group metadata in `UsageReportPayload`.
- Project report rows so `project` is the logical grouped project used globally.
- Preserve raw project provenance separately.
- Emit warnings for unmatched, partially matched, or broad legacy grouping config.

Required projection behavior:

- project sources collapse across harnesses for the same `machineId + sourcePath`;
- ungrouped same-name projects on different machines produce distinct project groups;
- configured groups combine selected sources under one group name;
- unmatched configured selectors remain in config and produce warnings;
- partially matched groups produce warnings listing unmatched selectors;
- legacy aliases are applied as report-time groups, not by mutating usage rows.
- analytics, filtering, session table project display, CSV, and Projects tab all see the logical projected project.

Acceptance criteria:

- `report-data` tests cover `Exalibur` on two machines as two ungrouped groups;
- `report-data` tests cover `Exalibur`, `Exalibur2`, and `Exalibur3` grouped into `exalibur`;
- payload rows expose logical project values and raw project provenance;
- payload warnings cover fully unmatched and partially unmatched persisted groups.

### Phase 5: Dashboard Rendering

- Update the project tab to render report project groups instead of grouping by `row.projectKey`.
- Use machine labels in visible text.
- Keep machine ids internal for keys and selectors.
- Add expand/details for grouped project rows.

Required rendering behavior:

- ungrouped same-name projects show machine labels, not UUIDs;
- grouped rows show only the configured group name as the primary label;
- source details are available for grouped rows;
- selection keys use project source ids or group ids, not labels.
- global filters and analytics already reflect grouped logical projects because they consume projected payload rows.

Acceptance criteria:

- dashboard model tests cover visible machine labels;
- dashboard model tests cover grouped rows with source counts;
- no visible table cell displays a full machine UUID by default.
- dashboard tests cover project filtering by group name and raw project/source text.

### Phase 6: Dashboard Editing

- Add server functions for project group config writes.
- Add checkbox selection and `Group` flow in the project tab.
- Persist selectors using `machineId + sourcePath` where possible.
- Refresh payload after writes.

Required write behavior:

- create group from selected project sources;
- rename group;
- delete group;
- remove a source from a group;
- cleanup unmatched selectors from a project grouping warning;
- preserve unrelated config fields.

Acceptance criteria:

- server-function tests or model tests cover config patching;
- selecting `Exalibur`, `Exalibur2`, and `Exalibur3` can persist one `exalibur` group;
- after refresh, the Projects tab shows one `exalibur` group.
- stale config warnings show cleanup/edit affordances.

### Phase 7: CLI and Docs

- Update `README.md`.
- Update `docs/architecture.md` ownership notes.
- Update `docs/public-package-interfaces.md`.
- Consider `projects group` CLI commands after the dashboard path works.

Acceptance criteria:

- README explains default separation by machine label and explicit grouping;
- architecture docs state that project grouping is report projection, not usage-store state;
- public package exports docs include any new exports.

## Open Questions

- What is the exact UI affordance for editing a partially matched group: drawer, modal, or inline expanded row?

## Agent Readiness Checklist

Before handing this to implementation agents, make sure the current working tree either has the earlier row-level `projectAlias` experiment reverted or assigns Phase 1 to the first agent.

Each agent should receive:

- the phase number;
- this document;
- the relevant package ownership docs;
- the exact test command expected for the phase;
- instructions not to change snapshots, merge bundles, or usage-store semantics unless that phase explicitly says so.

Recommended phase-to-agent split:

1. Phase 1 only: cleanup/revert row-level alias state.
2. Phases 2-3: pure domain model plus config persistence.
3. Phase 4: global report projection, payload, and grouping warnings.
4. Phase 5: dashboard read-only rendering.
5. Phase 6: dashboard editing and config writes.
6. Phase 7: docs and optional CLI cleanup.

## First Implementation Slice

This is the recommended first agent handoff. It intentionally avoids UI writes and project grouping editing. Its goal is to clean up the row model and introduce the pure domain/config foundation for the later global projection.

### Objective

Revert the row-level `projectAlias` experiment and introduce the pure `projectGroups` config/domain model without changing report behavior yet.

### Scope

In scope:

- remove `projectAlias` from usage row types and row serializers/deserializers;
- add pure project grouping types/helpers in `@ai-usage/report-core`;
- add `projectGroups` validation to user config;
- document the new public export.

Out of scope:

- changing report payload rows;
- changing analytics/filtering behavior;
- changing `apps/web` rendering;
- writing dashboard server functions;
- changing usage-store, snapshots, or merge-bundle semantics beyond removing accidental `projectAlias` transport.

### Required Edits

1. Remove row-level grouping state:

   - delete `projectAlias` from `packages/report-core/src/types.ts`;
   - remove `projectAlias` handling from `packages/report-core/src/snapshot.ts`;
   - remove `projectAlias` handling from `packages/report-core/src/merge-bundle.ts`;
   - remove tests that assert `projectAlias` exists on rows.

2. Add `packages/report-core/src/project-group.ts`:

   ```ts
   export interface ProjectSourceSelector {
     gitRemote?: string;
     machineId?: string;
     project?: string;
     sourcePath?: string;
   }

   export interface ProjectGroupConfig {
     id: string;
     name: string;
     sources: ProjectSourceSelector[];
   }

   export interface ProjectSourceIdentityInput {
     machineId: string;
     project: string;
     sourcePath?: string;
   }
   ```

   Required helpers:

   - `projectSourceId(input): string`
   - `matchesProjectSourceSelector(source, selector): boolean`
   - `isProjectGroupConfig(value): value is ProjectGroupConfig`

   Matching rules:

   - `machineId` must match when provided;
   - `sourcePath` must match exactly when provided;
   - `project` must match case-insensitively when provided;
   - `gitRemote` must match exactly when provided;
   - selector fields are conjunctive: every provided field must match;
   - empty selectors are invalid.

3. Export the new module:

   - add `./project-group` to `packages/report-core/package.json`;
   - export from `packages/report-core/src/index.ts` if the package barrel currently exports domain modules;
   - add it to `docs/public-package-interfaces.md`.

4. Extend config shape:

   - add `projectGroups?: ProjectGroupConfig[]` to `AiUsageConfig` in `packages/report-core/src/project-alias.ts` or move config types to a better named module only if this slice stays small;
   - validate `projectGroups` in `packages/local-collectors/src/machine-config.ts`;
   - config writes must preserve `cursor`, `sync`, and legacy `projectAliases`.

### Tests

Add `packages/report-core/src/project-group.test.ts` covering:

- same `project` on two `machineId`s produces different `projectSourceId`s;
- same `sourcePath` on two `machineId`s produces different `projectSourceId`s;
- selector with `machineId + sourcePath` matches only that source;
- selector with only `project` matches case-insensitively;
- empty selector is invalid;
- `machineLabel` is not part of matching.

Add or update `packages/local-collectors/src/machine-config.test.ts` covering:

- valid `projectGroups` config parses;
- invalid empty selectors reject config;
- invalid group without `id`, `name`, or non-empty `sources` rejects config.

### Verification Commands

Run:

```sh
bun --filter @ai-usage/report-core test
bun --filter @ai-usage/local-collectors test
bun --filter @ai-usage/report-core check
bun x ultracite check packages/report-core/src/project-group.ts packages/report-core/src/project-group.test.ts packages/report-core/src/project-alias.ts packages/local-collectors/src/machine-config.ts packages/local-collectors/src/machine-config.test.ts docs/public-package-interfaces.md
```

### Done Criteria

- `UsageRow` carries raw project facts only.
- Snapshots and merge bundles do not contain project grouping state.
- `ProjectGroupConfig` and selector matching exist as pure domain helpers.
- `AiUsageConfig.projectGroups` is validated but not yet applied to reports.
- No dashboard behavior changes in this slice.

## Current Recommendation

Use `machineId + sourcePath` as the default project source identity. Persist group selectors in user-local config as `projectGroups`. Apply groups in `report-data` as a global report projection so apps receive logical projects as native report data. Render machine labels in the dashboard and keep machine ids internal.
