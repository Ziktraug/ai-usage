# Plan 097: Sync, Sources, Projects: Duplication and Jargon

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/sync/machine-fleet.svelte apps/web/src/lib/features/sync/machine-comparison.svelte apps/web/src/lib/features/sync/sync-root.svelte apps/web/src/lib/features/sync/styles.ts apps/web/src/lib/features/sync/sync-render.test.ts apps/web/src/sync-machine-comparison-model.ts apps/web/src/manual-transfer-model.ts apps/web/src/lib/features/sources/model.ts apps/web/src/lib/features/sources/sources-page.svelte apps/web/src/lib/features/sources/source-components.test.ts apps/web/src/lib/features/report/breakdown/projects-panel.svelte apps/web/src/lib/features/report/breakdown/project-summary.svelte apps/web/src/lib/features/report/breakdown/styles.ts apps/web/src/project-presentation.ts apps/web/src/project-presentation.test.ts apps/web/e2e/dashboard.spec.ts apps/web/e2e/dashboard-presentation.spec.ts apps/web/e2e/sources.spec.ts`
> On any mismatch with the "Current state" excerpts, STOP — with one named
> exception: plan 088 (executed earlier in the program) may have relabelled or
> re-sourced the **Sessions** fact in `machine-fleet.svelte` lines 94–96. That
> drift is expected; re-read the file, keep 088's wording, and continue. Any
> other mismatch is a STOP.

## Status

- **Priority**: P1 (U28 is P1; U27 and U30 are P2)
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (sequence after 088 if both are in flight — see Scope)
- **Category**: remediation (presentation, copy)
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U27, U28 (copy part only — plan 095 owns the header
  pill that flips with the report filter), U30

## Why this matters

Three surfaces say true things in a way the reader cannot use.

- `/sync` renders every machine twice: once as a "Machine fleet" card (label,
  rename, Current/Fresh pills, Sessions, Newest session, Last observed,
  collection guidance) and again as a "Machine contributions" table (label,
  Sessions, Fleet share, Newest session, Freshness, Current Yes/No). Plan 059
  added the table deliberately next to the cards; the fresh-eyes audit read it
  as the same data twice. Worse, the table wrapper reserves
  `min-height: 320px`, so with two machines roughly 200 px of empty white
  sits under two rows before the Manual transfer panel.
- `/sources` tells the user "Publication demand is fully acknowledged." and
  "RTK dependency: Caught up", and prints the raw outcome enum
  (`success` / `not-run` / `failed`) and generation counters
  ("1/1 acknowledged"). These are the engine's internal mechanism names
  (CONTEXT.md: "Source publication … Requests advance monotonic demand …").
  The states are right; the words are not what a reader can act on.
- Analysis › Projects lists one repository twice as `<project> — <machine A>`
  and `<project> — <machine B>` (ungrouped project sources are named
  `projectLabelWithMachine`), while a configured project group shows its bare
  name with no machine at all; the Lines column prints
  `+0/-0 · 39/1,514 measured` with no explanation; the "Project" header is
  centred (UA default for `<th>`) over left-aligned cells with a different
  padding; and unlike Models and Harnesses & providers the panel has no
  header, no count, and no "Search this breakdown" box.

All three are pure presentation fixes on top of correct data. Each one gets a
deterministic assertion (render/SSR, computed style, or e2e geometry) so it
cannot be marked done from a diff alone.

## Current state

### Sync (U27)

- `apps/web/src/lib/features/sync/machine-fleet.svelte` — the card view:
  - lines 14–28: props `machines`, `now`, `omittedMachines`, `onRename`,
    `renameAvailable`, `skipped`.
  - lines 32–36: `fleetGrid` — `gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' }`.
  - line 46: `machineFacts` — `gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'` (three facts today: one row of two, one orphan).
  - lines 72–76: `<section aria-labelledby="machine-fleet-title">` with
    `<h2 … id="machine-fleet-title">Machine fleet</h2>` and the `panelSub`
    "Freshness is evaluated against the report's default 30-day window."
  - lines 93–105: the facts block —
    `<span class={machineFactLabel}>Sessions</span><span>{machine.sessionCount.toLocaleString()}</span>`
    (94–96), `Newest session` (97–100),
    `{machine.current ? 'Last observed' : 'Last import'}` (101–104).
  - lines 81–85: `<MachineLabelEditor editable={machine.current && renameAvailable && onRename !== undefined} …>`
    — the rename affordance (already delivered; plan 079's territory — keep).
- `apps/web/src/lib/features/sync/machine-comparison.svelte` — the table:
  - lines 35–39: `<section aria-labelledby="machine-contribution-title">`,
    `<h2 … id="machine-contribution-title">Machine contributions</h2>`,
    `panelSub` "Session share across the loaded fleet."
  - line 41: `<div class={cx(tableWrap, desktopTableSurface)} tabindex="0">`
  - lines 42–67: `<table aria-labelledby="machine-contribution-title" class={table}>` with
    columns Machine · Sessions · Fleet share · Newest session · Freshness · Current.
  - line 69: `<ul aria-label="Machine contribution summaries" class={cx(mobileSummarySurface, projectSummaryList)}>`
    — the mobile duplicate of the duplicate.
- `apps/web/src/lib/features/sync/styles.ts`:
  - lines 52–78: `table` (`minW: '1040px'` at line 75, sticky `th`).
  - lines 79–88: `tableWrap` — line 85
    `maxH: 'var(--ai-usage-table-max-height, calc(100dvh - 240px))'`, line 86
    `minH: 'var(--ai-usage-table-min-height, 320px)'` ← **the reserved
    empty space**.
  - lines 89–90: `desktopTableSurface`, `mobileSummarySurface`;
    lines 91–120: `projectSummaryList`, `projectSummaryCard`,
    `projectSummaryHeader`, `projectSummaryMetrics`, `projectSummaryMetric`;
    lines 14–15: `right`, `numCell`. All of these are imported **only** by
    `machine-comparison.svelte` (verify:
    `grep -rn "tableWrap\|desktopTableSurface\|mobileSummarySurface\|projectSummary\|numCell\|\bright\b" apps/web/src/lib/features/sync/*.svelte`
    → only `machine-comparison.svelte`). `strongCell` (line 13) is also used
    by `manual-transfer.svelte` — keep it.
  - line 129: `pageStack = css({ display: 'grid', gap: '16px' })` — the
    vertical rhythm the e2e geometry assertion below relies on.
- `apps/web/src/lib/features/sync/sync-root.svelte`:
  - line 8: `import { buildSyncFleetComparisonRows } from '../../../sync-machine-comparison-model';`
  - line 10: `import MachineComparison from './machine-comparison.svelte';`
  - lines 25–27: `const comparison = $derived(fleet ? buildSyncFleetComparisonRows(fleet.currentMachine, fleet.machines, data.renderedAt) : []);`
  - lines 78–86: `<MachineFleet … />` immediately followed by
    `<MachineComparison rows={comparison} />`, then (line 96–101) the
    `{#key manualTransferEpoch}<ManualTransfer …/>{/key}` panel.
- `apps/web/src/sync-machine-comparison-model.ts` — pure model, keep:
  - lines 64–88: `buildSyncFleetComparisonRows(currentMachine, machines, now)`
    returns rows with `id`, `sessionShareLabel` (line 84: `` `${sessionSharePercent}%` ``),
    `sessionSharePercent`, plus labels the table used.
  - lines 43–62: `apportionSessionSharePercents` — whole percentages summing
    to 100, not exported. Tested in
    `apps/web/src/manual-transfer-model.test.ts` lines 166–198 ("builds
    stable current-first machine comparison rows…") and 199–224
    ("apportions whole percentages to 100…"). Those tests stay valid.
- `apps/web/src/manual-transfer-model.ts` lines 34–44: `SyncFleetMachineView`
  (`current`, `id`, `label`, `lastSeenAt`, `newestSessionAt`, `sessionCount`,
  `stale`, …); lines 97–123 `buildSyncFleetMachineViews` sorts current-first
  then label and synthesises the current machine (`sessionCount: 0`,
  `stale: true`) when it is not in `machines`.
- Tests/anchors that already touch this surface:
  - `apps/web/src/lib/features/sync/sync-render.test.ts` — SSR render of
    `sync-root.fixture.svelte`; fixture lines 27–42 (one machine `Laptop`,
    7 sessions); assertions lines 88–101 (`toContain('Laptop')`,
    `toContain('7')`, `toContain('Manual transfer')`).
  - `apps/web/e2e/dashboard.spec.ts` lines 826–827:
    `getByRole('heading', { level: 2, name: 'Machine fleet' })` and
    `getByLabel('Machine fleet').getByText('Current machine', { exact: true })`;
    line 828 switches the viewport to 361 px. The e2e fleet comes from
    `apps/web/src/server/e2e/sync-fixture.server.ts` lines 151–157: only
    `E2E current machine`, no peers, so the card shows "Needs collection".
  - `apps/web/e2e/accessibility.spec.ts` lines 130–144: SSR geometry —
    `fleet = heading 'Machine fleet' .locator('..')`,
    `fleetBox.y === noticeBox.y + noticeBox.height + 16`. Unaffected by this
    plan (the header is still the section's first child).

### Sources (U28, copy only)

- `apps/web/src/lib/features/sources/model.ts`:
  - line 5: `type SourcePublicationView` is imported only for
    `publicationStatus`.
  - lines 78–88:
    ```ts
    export const publicationStatus = (publication: SourcePublicationView): string => {
      if (publication.running) { return 'Publishing stored data now.'; }
      if (publication.queued) { return 'Publication is queued.'; }
      return publication.pendingDemand
        ? 'Publication demand is waiting for its dependency.'
        : 'Publication demand is fully acknowledged.';
    };
    ```
  - `publicationStatus` has exactly one consumer: `sources-page.svelte`
    (verify: `grep -rn "publicationStatus" apps/web/src` → model.ts + sources-page.svelte).
  - **Closure note** (plan 077 implementation notes, lines 223–231):
    `apps/web/src/routes/+layout.svelte` → `source-control-summary.svelte` →
    `./model`, so `model.ts` ships on every route. New copy for `/sources`
    only must not be added here — put it in a module only
    `sources-page.svelte` imports.
- `apps/web/src/lib/features/sources/sources-page.svelte`:
  - lines 10–18: `import { compactRevision, conciseSourceStatus, deviationSources, healthySources, orderedSources, publicationStatus, sourcesInGroup } from './model';`
  - line 152: `<h2 class={groupTitle}>Report publication pipeline</h2>`
  - line 153: `<p class={meta}>{publicationStatus(snapshot.publication)}</p>`
  - line 154: `<details data-publication-details>` (e2e anchor — keep).
  - lines 177–180: `<span class={axisLabel}>Last outcome</span><span class={axisValue}>{snapshot.publication.lastOutcome}</span>`
    ← renders the raw enum `'not-run' | 'success' | 'failed'`.
  - lines 181–187: `<span class={axisLabel}>Demand</span> … {snapshot.publication.acknowledgedRequestGeneration}/{snapshot.publication.requestedGeneration} acknowledged`
  - lines 188–193: `<span class={axisLabel}>RTK dependency</span> … {snapshot.publication.rtkCompletedGeneration >= snapshot.publication.rtkRequiredGeneration ? 'Caught up' : \`Waiting for generation ${snapshot.publication.rtkRequiredGeneration}\`}`
  - lines 197–230: the first-run guidance block (`data-first-run-guidance`)
    — plan 077's territory, already present at this commit; do not touch.
  - line 6 already imports `fmtDate` (used at line 149 for
    `snapshot.generatedAt`).
- `packages/report-core/src/source-control.ts` lines 305–320 —
  `SourcePublicationView`: `acknowledgedRequestGeneration`, `dirty`,
  `dirtyGeneration`, `lastDurationMs?`, `lastOutcome: 'not-run' | 'success' | 'failed'`,
  `lastPublishedAt?`, `pendingDemand`, `publishedGeneration`, `queued`,
  `requestedGeneration`, `revision?`, `rtkCompletedGeneration`,
  `rtkRequiredGeneration`, `running`.
- `packages/usage-engine-runtime/src/source-control-state.ts` lines 294–301 —
  what the flags mean:
  `pendingDemand: requestedGeneration > acknowledgedRequestGeneration || dirtyGeneration > publishedGeneration`.
  `rtkCompletedGeneration >= rtkRequiredGeneration` means the `rtk.savings`
  enricher (label "RTK savings", `packages/report-core/src/source-control.ts`
  lines 95–101) has run after the latest session collection; publication
  waits for it (docs/architecture.md line 433: "RTK waits for session
  producers").
- Tests/anchors:
  - `apps/web/src/lib/features/sources/source-components.test.ts` — imports
    `compactRevision, pendingAriaBusyAttributes, revisionDisplayBounds` from
    `./model` (line 2); no test covers `publicationStatus` today.
  - `apps/web/e2e/sources.spec.ts` lines 94–98 open
    `[data-publication-details]` and read `code[title]` (revision); lines
    233–284 ("ignores a partial SSE snapshot…") show the
    `page.route('**/api/source-control', …)` SSE intercept pattern with a full
    `publication` object (lines 249–262) — reuse it for the pending/behind
    state.
  - The live e2e fixture `apps/web/src/server/e2e/source-control-fixture.server.ts`
    lines 38–51 publishes with `lastOutcome: 'success'`, `lastPublishedAt`,
    `pendingDemand: false`, `rtkCompleted === rtkRequired`.
  - No test anywhere pins "Publication demand", "Caught up", "RTK dependency"
    or "Report publication pipeline" (verify with
    `grep -rn "Publication demand\|Caught up\|RTK dependency\|Report publication pipeline" apps/web`
    → only model.ts and sources-page.svelte).

### Projects (U30)

- `apps/web/src/lib/features/report/breakdown/projects-panel.svelte`:
  - lines 11–25: props `disabled`, `generatedAt`, `groups: readonly ProjectGroup[]`,
    `onProjectFilter`, `onSave`, `payload: Pick<WebReportPayloadWithoutRows, 'projectGroupConfigs' | 'projectGroups'>`.
  - line 29: `const sources = $derived((payload.projectGroups ?? []).flatMap(({ sources: groupSources }) => groupSources));`
    — the catalogue is already in scope here.
  - lines 37–40: `createExport` → `projectBreakdownCsv(groups)`.
  - lines 57–64: `<section data-projects-panel>` → `<ReportSharingActions {createExport} />` → `<ProjectSummary …/>` → `<details …><summary>Manage project groups</summary><ProjectGroupEditor …/></details>`.
    No header, no count, no search.
- `apps/web/src/lib/features/report/breakdown/project-summary.svelte`:
  - lines 12–22: local `tableWrap`, `table` (`w: 'full', borderCollapse: 'collapse', fontSize: '12px'` — **no `th` rule**), `projectTable` (`minW: '840px'`), `right` (`textAlign: 'right'`), `numCell` (`p: '8px' … textAlign: 'right'`), `strongCell` (`p: '8px' … fontWeight: 700`).
  - lines 76–87: `<thead><tr><th>Project</th><th class={right}>Sessions</th>…<th class={right}>Lines</th>…`
    — `<th>Project</th>` carries no class, so it is centred (UA default) and
    has 1 px UA padding while its cells have 8 px.
  - lines 57–66: `lineMeasurement(project)` →
    `'—'` when `measuredSessions === 0`, else `` `+${fmtNum(linesAdded)}/-${fmtNum(linesDeleted)}` `` and, when
    `measuredSessions < totalSessions`, `` ` · ${fmtNum(measured)}/${fmtNum(total)} measured` `` appended.
  - lines 92–121: the row; 93–113 the identity cell
    (`<td class={strongCell} title={project.label === '(unknown)' ? … }>` with
    the `groupKeyButton` printing `{project.label}` and the optional
    `data-project-quality-label` pill calling `onManageProjectGroups`);
    line 118 `<td class={numCell}>{lineMeasurement(project)}</td>`.
  - lines 126–182: `<ul aria-label="Project summaries" …>` mobile cards with the
    same label button (139) and `<dt>Lines</dt><dd>{lineMeasurement(project)}</dd>` (168–169).
  - lines 71–72: `{#if groups.length === 0}<div class={empty}>No projects</div>`.
- Where the composite label comes from:
  - `packages/report-core/src/project-group.ts` lines 29–42
    `projectLabelWithMachine(project, machine)` → `` `${projectLabel} — ${machineLabel}` ``
    unless the machine is a redundant suffix.
  - `packages/report-data/src/project-projection.ts` line 449:
    ungrouped sources are named `projectLabelWithMachine(source.project, source.machine)`
    with id `` `source:${source.id}` ``; configured groups (lines 415–419)
    are named `group.name` with id `` `group:${group.id}` `` and
    `grouped: true`; lines 287–329 `createReportProjectGroup` copies
    `sources[].machineLabel: source.machine` and `sources[].project`.
  - `packages/report-core/src/report-data.ts` lines 67–76
    `UsageReportProjectSource { gitRemote, id, machineId, machineLabel, project, sessions, sourcePath, tokens }`,
    lines 78–93 `UsageReportProjectGroup { …, grouped: boolean, id, name, sources, … }`.
  - `packages/report-core/src/session-query.ts` lines 959–963:
    `projectKey = row.projectGroupId ?? row.projectSourceId ?? normalizeProjectIdentity(…)`
    — so the web `ProjectGroup.key` equals the catalogue `id` whenever the
    row carries a group id; `projectLabel = row.project` (the composite name).
  - `apps/web/src/dashboard-analytics.ts` lines 13–23 `ProjectGroup` (`key`,
    `label`, `sessions`, `fresh`, `cache`, `cost`, `priced`, `turns`, `tools`
    + `LineMeasurementAccumulator`: `linesAdded`, `linesDeleted`,
    `lineMeasurement { measuredSessions, totalSessions }`);
    `packages/report-core/src/focused-report-query.ts` lines 346–356
    `FocusedProjectGroup` is the same shape.
  - `apps/web/src/report-data.ts` (synthetic/e2e payload): rows carry
    `project: 'ai-usage'` and `source.machineLabel: 'Fixture Machine'` /
    `'Fixture Machine Secondary'` but no `projectGroupId` and no
    `projectGroups` catalogue — in e2e the identity helper takes its
    fallback path (label only). The split is proven by the SSR render test
    below, not by e2e.
- `apps/web/src/project-presentation.ts` lines 1–24: `projectDataQualityLabel(projectLabel)`
  (`'Filename-like' | 'No detected project' | 'Worktree-like' | null`), with
  `apps/web/src/project-presentation.test.ts` (line 24 pins
  `'agent-a1 — Build Host'` → `null`; keep that behaviour).
- The sibling panels this one must match:
  - `apps/web/src/lib/features/report/breakdown/model-analysis-table.svelte`
    lines 79–100: `<section class={cx(containedInteractive, analysisPanel)} data-breakdown-panel="models">`,
    `<header class={groupHeader}><h2 class={groupTitle}>Models</h2><span class={groupCount} …>{fmtNum(visibleRows.length)} models</span><div class={cx(actionRow, analysisActions)}><input aria-label="Search this breakdown" class={searchInput} placeholder="Search this breakdown" type="search" bind:value={query}> … <ReportSharingActions {createExport} /></div></header>`;
    line 59 `let query = $state('');`; lines 122–125 the empty row
    `<td class={modelEmpty} colspan="6"><span role="status">{emptyMessage}</span></td>`;
    name cell is `<th … scope="row">` with `modelNameButton` (129–138).
  - `apps/web/src/lib/features/report/breakdown/harness-provider-panel.svelte`
    lines 72–98: same header with `groupPanel`.
  - `apps/web/src/lib/features/report/breakdown/styles.ts` lines 161–187:
    `modelTableHeaderCell` (`p: '10px 12px'`, muted, 11 px, bottom rule),
    `modelTableCell` (`p: '12px'`), and the two alignment atoms
    `modelTextCell` (`textAlign: 'left'`) / `modelNumericCell`
    (`textStyle: 'numeric', textAlign: 'right'`) with the comment (177–180):
    "`textAlign` has to live on exactly one of the classes a cell composes …
    the winner is stylesheet order, not call order". Also `modelTable`
    (136–141, `minW: '760px'`), `modelEmpty`, `modelNameButton` (188–204).
  - `apps/web/src/lib/features/report/breakdown/model.ts` lines 232–233:
    `modelAnalysisEmptyMessage = (query) => query.trim() ? 'No breakdown rows match this search' : 'No models'`.
  - `apps/web/src/group-panel-presentation.ts` lines 41–47:
    `export const breakdownLabelMatchesSearch = (label: string, query: string): boolean` (NFKC, trimmed, case-insensitive `includes`).
  - Design-system recipes: `packages/design-system/src/components/panel.ts`
    lines 49–75 `groupPanel`, `groupHeader` (grid `minmax(0,1fr) auto`,
    `p: '14px 16px'`, bottom rule), `groupTitle`, `groupCount`;
    `components/field.ts` line 22 `searchInput`. All exported from
    `@ai-usage/design-system/svelte`.
  - `packages/design-system/src/svelte/compound/tabs.svelte` lines 77–79:
    `lazyMount` + `unmountOnExit` — only the selected Analysis tab is in the
    DOM, so a second "Search this breakdown" searchbox on the Projects tab
    cannot collide with the Models e2e selectors.
- Tests/anchors:
  - `apps/web/e2e/dashboard-presentation.spec.ts` lines 289–318 ("renders
    secondary status only on Overview and puts Projects before closed group
    management"): clicks tab `Projects`, asserts `[data-projects-panel]`
    `getByRole('table')` visible, `details > summary` text
    "Manage project groups", `details` closed, the DOM order
    `table` before `details` inside the panel, and
    `[data-project-quality-label]` count 0.
  - `apps/web/e2e/dashboard.spec.ts` lines 238–241: `columnheader 'Project'`
    visible + "Manage project groups" text; lines 688–690 (361 px):
    `getByRole('list', { name: 'Project summaries' })` visible and
    `getByRole('table')` count 0.
  - `apps/web/src/lib/features/report/breakdown/model-analysis-table.ssr.test.ts`
    — the Vite SSR harness to copy (lines 53–73 create the server and
    `ssrLoadModule` the component + `svelte/server`; assertions count
    `scope="col"` / `scope="row"` and check `aria-label="Search this breakdown"`).
  - The bundle guard `apps/web/bundle/client-bundle.test.ts` (ceiling
    300,000 B gzip, recorded 284,579 B ± 2 %) reads `.svelte-kit/build` —
    needs `bun run --cwd apps/web build` first.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format | `bun x ultracite fix` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Web unit + SSR tests | `bun run --cwd apps/web test` | all pass |
| One test file | `cd apps/web && bun test src/<path>.test.ts` | pass |
| One e2e spec | `bun run --cwd apps/web test:e2e -- e2e/<spec>.spec.ts` | pass |
| Bundle guard | `bun run --cwd apps/web build && bun run --cwd apps/web test:bundle` | pass |
| PII check | the program-wide grep from plan 086 ("Cross-cutting rules"), run on this plan file and on every file you touched | no output |

On NixOS set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome before
e2e (documented workaround; `--channel chrome` does not work here).

## Scope

**In scope** (the only files you should modify / create / delete):
- Sync: `apps/web/src/lib/features/sync/machine-fleet.svelte`,
  `apps/web/src/lib/features/sync/sync-root.svelte`,
  `apps/web/src/lib/features/sync/styles.ts`,
  `apps/web/src/lib/features/sync/sync-render.test.ts`,
  **delete** `apps/web/src/lib/features/sync/machine-comparison.svelte`,
  `apps/web/e2e/dashboard.spec.ts` (the `/sync` test only).
- Sources: `apps/web/src/lib/features/sources/model.ts` (remove
  `publicationStatus` + its now-unused type import),
  **new** `apps/web/src/lib/features/sources/publication-status.ts` and
  `publication-status.test.ts`,
  `apps/web/src/lib/features/sources/sources-page.svelte` (publication panel
  only, lines 151–196), `apps/web/e2e/sources.spec.ts` (one new test).
- Projects: `apps/web/src/lib/features/report/breakdown/projects-panel.svelte`,
  `apps/web/src/lib/features/report/breakdown/project-summary.svelte`,
  `apps/web/src/project-presentation.ts`, `apps/web/src/project-presentation.test.ts`,
  **new** `apps/web/src/lib/features/report/breakdown/projects-panel.ssr.test.ts`,
  `apps/web/e2e/dashboard-presentation.spec.ts` (extend the existing Projects test),
  `apps/web/src/lib/features/report/breakdown/styles.ts` only if a shared
  class is genuinely missing (prefer reuse; see Step 9).
- `plans/README.md` status row.

**Out of scope** (do NOT touch):
- `apps/web/src/sync-machine-comparison-model.ts`,
  `apps/web/src/manual-transfer-model.ts` and their tests — the share
  apportioning stays the tested source of truth; it is reused, not rewritten.
- `apps/web/src/lib/features/sync/manual-transfer.svelte`,
  `manual-transfer-client.ts`, merge preview/confirm, Cursor import, machine
  rename (`machine-label-editor.svelte`) — plans 075 and 079. Keep the
  `MachineLabelEditor` call and its `editable` gate exactly as they are.
- The **count semantics** of the fleet "Sessions" fact (U03) — plan 088
  decides whether it is deduplicated or relabelled; this plan only changes
  representation. If 088 landed first, keep its label.
- `apps/web/src/lib/features/sources/source-control-summary.svelte`,
  `apps/web/src/source-control-presentation.ts`,
  `apps/web/src/lib/features/shell/source-control-summary-context.ts` — the
  header pill (U28b) is plan 095.
- The first-run guidance block in `sources-page.svelte` (plan 077), the
  per-source state labels in `apps/web/src/source-control-presentation-model.ts`
  (already plain: "Ready", "Not detected", …), the page subtitle
  "Policy, availability, lifecycle, and outcomes stay independent…" (not
  flagged; see Maintenance notes).
- `packages/report-core/src/project-group.ts`, `packages/report-data/src/project-projection.ts`,
  `packages/report-core/src/csv.ts` — project naming, grouping and the CSV
  (`projectBreakdownCsv` keeps exporting `group.label`) do not change.
- The Sessions table "Project" column (plan 091 owns session columns).
- `projectDataQualityLabel` behaviour (keep feeding it `project.label`).

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` (base
  `51815b70`). One commit for this plan; message: `Sync, Sources, Projects: duplication and jargon`
  (program rule: commit message = child title).
- Stage by explicit path — peer sessions may be writing to this checkout;
  never `git add -A`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fold "Fleet share" into the fleet cards

In `apps/web/src/lib/features/sync/machine-fleet.svelte`:

- Add an optional prop `shares: ReadonlyMap<string, string>` (machine id →
  `sessionShareLabel`, e.g. `'61%'`), default `new Map()`.
- In the facts block (lines 93–105) add a fourth fact **after** "Sessions":
  ```svelte
  <div class={machineFact} data-machine-fleet-share>
    <span class={machineFactLabel}>Fleet share</span><span>{shares.get(machine.id) ?? '0%'}</span>
  </div>
  ```
  (`'0%'` covers the synthesised current machine that
  `buildSyncFleetComparisonRows` filters out — it has no stored sessions,
  so zero is the honest value.)
- Leave `machineFacts` at two columns: four facts now fill a clean 2×2 grid
  instead of 2 + 1.

**Verify**: `bun run typecheck` → exit 0 (the new prop is optional, so the
SSR fixture still compiles).

### Step 2: Remove the comparison table and wire the shares

In `apps/web/src/lib/features/sync/sync-root.svelte`:

- Delete line 10 (`import MachineComparison …`).
- Replace lines 25–27 with
  ```ts
  const fleetShares = $derived(
    new Map(
      (fleet ? buildSyncFleetComparisonRows(fleet.currentMachine, fleet.machines, data.renderedAt) : []).map(
        (row) => [row.id, row.sessionShareLabel] as const,
      ),
    ),
  );
  ```
- Pass `shares={fleetShares}` to `<MachineFleet …/>` and delete
  `<MachineComparison rows={comparison} />` (line 86).

Delete `apps/web/src/lib/features/sync/machine-comparison.svelte`.

In `apps/web/src/lib/features/sync/styles.ts` delete the exports that lost
their last consumer: `right`, `numCell`, `table`, `tableWrap`,
`desktopTableSurface`, `mobileSummarySurface`, `projectSummaryList`,
`projectSummaryCard`, `projectSummaryHeader`, `projectSummaryMetrics`,
`projectSummaryMetric`. Keep `strongCell`, `actionRow`, `panelHeader`,
`statusPill*`, `ghostButton`, `headerTop`, `pageStack`, `unavailablePanel`,
`unavailableText`.

**Verify**:
`grep -rn "machine-comparison\|MachineComparison\|tableWrap\|Machine contributions" apps/web/src` → no matches;
`bun run typecheck` → exit 0; `bun run lint` → exit 0.

### Step 3: Pin the single fleet representation (SSR + e2e)

In `apps/web/src/lib/features/sync/sync-render.test.ts`, in the first test
(lines 88–101), add:
```ts
expect(body).toContain('Fleet share');
expect(body).toContain('100%');                       // one machine with 7 sessions
expect(body).not.toContain('Machine contributions');
expect(body).not.toContain('Machine contribution summaries');
expect(body).not.toContain('<table');
expect(body.match(/data-machine-fleet-share/g)).toHaveLength(1);
```

In `apps/web/e2e/dashboard.spec.ts`, test "keeps sync limited to explicit
file transfers", right after line 827 (before the 361 px viewport change):
```ts
const fleetSection = page.getByRole('heading', { level: 2, name: 'Machine fleet' }).locator('xpath=ancestor::section[1]');
const transferSection = page.getByRole('heading', { level: 2, name: 'Manual transfer' }).locator('xpath=ancestor::section[1]');
await expect(fleetSection.locator('[data-machine-fleet-share]')).toHaveCount(1);
await expect(page.locator('main[data-route-shell="sync"] table')).toHaveCount(0);
await expect(page.getByRole('list', { name: 'Machine contribution summaries' })).toHaveCount(0);
const fleetBox = await fleetSection.boundingBox();
const transferBox = await transferSection.boundingBox();
expect(fleetBox).not.toBeNull();
expect(transferBox).not.toBeNull();
// Nothing sits between the fleet and the transfer panel but the 16px page-stack gap
// (styles.ts `pageStack`); before this plan a 320px-min-height table lived here.
expect(Math.round(transferBox?.y ?? 0)).toBe(Math.round((fleetBox?.y ?? 0) + (fleetBox?.height ?? 0) + 16));
```
After the viewport switch to 361 px (line 828) add
`await expect(page.getByRole('list', { name: 'Machine contribution summaries' })).toHaveCount(0);`.

**Verify**: `cd apps/web && bun test src/lib/features/sync/sync-render.test.ts` → pass;
`bun run --cwd apps/web test:e2e -- e2e/dashboard.spec.ts e2e/accessibility.spec.ts` → pass
(`accessibility.spec.ts` covers the `/sync` axe run and the SSR geometry).

### Step 4: Move and rewrite the publication copy as pure helpers

Create `apps/web/src/lib/features/sources/publication-status.ts`:
```ts
import type { SourcePublicationView } from '@ai-usage/report-core/source-control';

export interface RtkDependencyStatus {
  readonly behind: boolean;
  readonly label: string;
  readonly title: string;
}

export const rtkDependencyStatus = (publication: SourcePublicationView): RtkDependencyStatus => {
  const behind = publication.rtkCompletedGeneration < publication.rtkRequiredGeneration;
  return {
    behind,
    label: behind ? 'Behind — publishing waits for it' : 'Up to date',
    title: `RTK savings generation ${publication.rtkCompletedGeneration} of ${publication.rtkRequiredGeneration} required`,
  };
};

export const pendingPublishRequests = (publication: SourcePublicationView): number =>
  Math.max(0, publication.requestedGeneration - publication.acknowledgedRequestGeneration);

export const publicationOutcomeLabel = (publication: SourcePublicationView): string => {
  if (publication.lastOutcome === 'success') {
    return 'Succeeded';
  }
  return publication.lastOutcome === 'failed' ? 'Failed' : 'Not published yet';
};

export const publicationStatus = (publication: SourcePublicationView): string => {
  if (publication.running) {
    return 'Publishing stored data now.';
  }
  if (publication.queued) {
    return 'Publishing is queued.';
  }
  if (!publication.pendingDemand) {
    return 'The report is up to date with everything collected.';
  }
  return rtkDependencyStatus(publication).behind
    ? 'New data is waiting to be published once RTK savings enrichment catches up.'
    : 'New data is waiting to be published.';
};
```
(These exact strings are the contract the tests below pin. The four states
of the old function are preserved one-to-one; "RTK savings" is the source's
own label on this page, so it is the one internal name that stays.)

In `apps/web/src/lib/features/sources/model.ts` delete lines 78–88
(`publicationStatus`) and the now-unused `type SourcePublicationView` from
the import at lines 1–6.

Create `apps/web/src/lib/features/sources/publication-status.test.ts`
(bun:test, same header style as `source-components.test.ts`) with a
`publication(overrides)` factory over a base
`{ acknowledgedRequestGeneration: 1, dirty: false, dirtyGeneration: 1, lastOutcome: 'success', pendingDemand: false, publishedGeneration: 1, queued: false, requestedGeneration: 1, rtkCompletedGeneration: 1, rtkRequiredGeneration: 1, running: false }`
and cases:
- running → `'Publishing stored data now.'`; queued → `'Publishing is queued.'`;
- `pendingDemand: true` with `rtkRequiredGeneration: 2` → the "once RTK savings enrichment catches up" sentence;
- `pendingDemand: true` with RTK level → `'New data is waiting to be published.'`;
- default → `'The report is up to date with everything collected.'`;
- `publicationOutcomeLabel`: `success` → `Succeeded`, `failed` → `Failed`, `not-run` → `Not published yet`;
- `pendingPublishRequests`: (requested 3, acknowledged 1) → 2; equal → 0; acknowledged ahead (should not happen) → 0;
- `rtkDependencyStatus`: level → `{ behind: false, label: 'Up to date' }`, behind → `{ behind: true, label: 'Behind — publishing waits for it' }` and the `title` contains both generations;
- a regression guard: none of the returned strings match `/demand|acknowledg|dependency|Caught up/i`.

**Verify**: `cd apps/web && bun test src/lib/features/sources/publication-status.test.ts` → all pass;
`grep -rn "publicationStatus" apps/web/src/lib/features/sources/model.ts` → no match.

### Step 5: Use the plain copy in the publication panel

In `apps/web/src/lib/features/sources/sources-page.svelte`:

- Remove `publicationStatus` from the `./model` import (lines 10–18) and add
  `import { pendingPublishRequests, publicationOutcomeLabel, publicationStatus, rtkDependencyStatus } from './publication-status';`.
- Line 152: `Report publication pipeline` → `Report publishing`.
- Line 153 stays `{publicationStatus(snapshot.publication)}` (now the new
  sentences). Add `data-publication-status` to that `<p>`.
- Lines 177–180 (Last outcome): label `Last publish`; value
  `{publicationOutcomeLabel(snapshot.publication)}{snapshot.publication.lastPublishedAt ? ` · ${fmtDate(snapshot.publication.lastPublishedAt)}` : ''}`
  with `data-publication-outcome={snapshot.publication.lastOutcome}` on the
  value span (the raw enum moves from visible text to an attribute).
- Lines 181–187 (Demand): label `Pending publish requests`; value
  `{fmtNum(pendingPublishRequests(snapshot.publication))}` with
  `data-publication-pending-requests` and
  `title={\`Requested generation ${snapshot.publication.requestedGeneration}, acknowledged ${snapshot.publication.acknowledgedRequestGeneration}\`}`.
- Lines 188–193 (RTK dependency): `{@const rtk = rtkDependencyStatus(snapshot.publication)}`
  above the axis; label `RTK savings enrichment`; value `{rtk.label}` with
  `title={rtk.title}` and `data-publication-rtk={rtk.behind ? 'behind' : 'up-to-date'}`.
- Keep `data-publication-details`, the `Details` summary, the Revision axis
  and the `Copy publication revision` button untouched (e2e anchors).

**Verify**: `grep -rn "Publication demand\|Caught up\|RTK dependency\|Report publication pipeline\|acknowledged</span" apps/web/src` → no matches;
`bun run typecheck` → exit 0.

### Step 6: Pin the copy end to end

In `apps/web/e2e/sources.spec.ts` add one test after "ignores a partial SSE
snapshot after a complete catalogue" (reuse its `sources` array builder and
`page.route('**/api/source-control', …)` shape, lines 233–284):

`test('describes report publishing in plain language in both the waiting and the up-to-date states', …)`:
1. Fulfil one snapshot with
   `publication: { …complete.publication, pendingDemand: true, requestedGeneration: 3, acknowledgedRequestGeneration: 1, rtkRequiredGeneration: 2, rtkCompletedGeneration: 1, lastOutcome: 'failed' }`.
2. `await openHydratedSources(page)`; assert
   `page.getByRole('heading', { level: 2, name: 'Report publishing' })` visible;
   `page.locator('[data-publication-status]')` has text
   `'New data is waiting to be published once RTK savings enrichment catches up.'`;
   open `[data-publication-details] > summary`; assert
   `getByText('Pending publish requests', { exact: true })` visible and
   `[data-publication-pending-requests]` has text `'2'`;
   `[data-publication-rtk="behind"]` has text
   `'Behind — publishing waits for it'`; `[data-publication-outcome="failed"]`
   has text `'Failed'`.
3. Assert the jargon is gone from the whole page:
   `expect(await page.locator('main').innerText()).not.toMatch(/Publication demand|RTK dependency|Caught up|acknowledged|not-run/)`.
4. In the existing first test ("states each source health once…"), after the
   details are opened (line 98), add
   `await expect(page.locator('[data-publication-status]')).toHaveText('The report is up to date with everything collected.');`
   and `await expect(page.locator('[data-publication-rtk="up-to-date"]')).toHaveText('Up to date');`
   and `await expect(page.locator('[data-publication-outcome="success"]')).toContainText('Succeeded · ');`
   (the live fixture sets `lastPublishedAt`).

**Verify**: `bun run --cwd apps/web test:e2e -- e2e/sources.spec.ts` → pass.

### Step 7: Pure project identity, lines, and search helpers

In `apps/web/src/project-presentation.ts` add (keep
`projectDataQualityLabel` unchanged):
```ts
import type { UsageReportProjectGroup } from '@ai-usage/report-core/report-data';
import type { ProjectGroup } from './dashboard-analytics';
import { breakdownLabelMatchesSearch } from './group-panel-presentation';
import { fmtNum } from './lib/foundation/presentation/format';

export interface ProjectIdentityPresentation {
  readonly grouped: boolean;
  readonly machines: readonly string[];
  readonly name: string;
}

export const projectIdentityPresentation = (
  project: Pick<ProjectGroup, 'key' | 'label'>,
  catalogue: readonly UsageReportProjectGroup[] | undefined,
): ProjectIdentityPresentation => {
  const entry = catalogue?.find((group) => group.id === project.key);
  if (!entry) {
    return { grouped: false, machines: [], name: project.label };
  }
  const machines = [...new Set(entry.sources.map((source) => source.machineLabel.trim()).filter(Boolean))];
  if (entry.grouped) {
    return { grouped: true, machines, name: entry.name };
  }
  return { grouped: false, machines, name: entry.sources[0]?.project.trim() || '(unknown)' };
};

export interface ProjectLinesPresentation {
  readonly coverage: string | null;
  readonly label: string;
  readonly status: 'exact' | 'lower-bound' | 'unknown';
  readonly title: string;
}

export const projectLinesPresentation = (
  project: Pick<ProjectGroup, 'lineMeasurement' | 'linesAdded' | 'linesDeleted'>,
): ProjectLinesPresentation => {
  const { measuredSessions, totalSessions } = project.lineMeasurement;
  if (measuredSessions === 0) {
    return { coverage: null, label: '—', status: 'unknown', title: `No session in this project reports line changes (0 of ${fmtNum(totalSessions)} measured)` };
  }
  const delta = `+${fmtNum(project.linesAdded)}/-${fmtNum(project.linesDeleted)}`;
  if (measuredSessions < totalSessions) {
    return {
      coverage: `${fmtNum(measuredSessions)} of ${fmtNum(totalSessions)} sessions measured`,
      label: `≥ ${delta}`,
      status: 'lower-bound',
      title: `Lines added/deleted summed over the ${fmtNum(measuredSessions)} of ${fmtNum(totalSessions)} sessions that report line changes; the rest are not counted`,
    };
  }
  return { coverage: null, label: delta, status: 'exact', title: `Lines added/deleted summed over all ${fmtNum(totalSessions)} sessions` };
};

export const projectSearchRows = <T extends Pick<ProjectGroup, 'key' | 'label'>>(
  groups: readonly T[],
  query: string,
  catalogue: readonly UsageReportProjectGroup[] | undefined,
): T[] =>
  groups.filter((project) => {
    const identity = projectIdentityPresentation(project, catalogue);
    return breakdownLabelMatchesSearch(`${identity.name} ${identity.machines.join(' ')} ${project.label}`, query);
  });

export const projectsEmptyMessage = (query: string): string =>
  query.trim() ? 'No breakdown rows match this search' : 'No projects';
```
(The `+N/-M` shape matches the Sessions table's `lineDeltaLabel` in
`apps/web/src/dashboard-sort.ts` lines 17–22; `≥` is the repo's settled
lower-bound marker, see `apiValuePresentation` in
`apps/web/src/lib/foundation/presentation/report-value.ts` lines 35–47.
Coverage stays visible — per-metric provenance is never hidden.)

In `apps/web/src/project-presentation.test.ts` add cases with **synthetic**
names only (`fixture-app`, `Fixture Machine`, `Fixture Machine Secondary`,
`Shared tooling`):
- identity, ungrouped + catalogue → `{ grouped: false, machines: ['Fixture Machine'], name: 'fixture-app' }` even though `project.label` is `'fixture-app — Fixture Machine'`;
- identity, grouped with two sources on two machines → `{ grouped: true, machines: ['Fixture Machine', 'Fixture Machine Secondary'], name: 'Shared tooling' }` (duplicates collapsed, catalogue order kept);
- identity, ungrouped with empty `project` → name `'(unknown)'`;
- identity, no catalogue / key not found → `{ grouped: false, machines: [], name: project.label }`;
- lines: `measured 0 of 3` → `'—'`/`unknown`/`coverage: null`; `39 of 1514` with `+0/-0` → label `'≥ +0/-0'`, `coverage: '39 of 1,514 sessions measured'`, `lower-bound`; `3 of 3` with `+860/-120` → `'+860/-120'`, `exact`, `coverage: null`;
- search: empty query returns all in order; `'secondary'` matches only the row whose machine is `Fixture Machine Secondary`; `'shared'` matches the group; `'FIXTURE-APP'` matches both ungrouped rows; `'zzz'` → `[]`;
- `projectsEmptyMessage('  ')` → `'No projects'`, `projectsEmptyMessage('x')` → the shared "No breakdown rows match this search" string.

**Verify**: `cd apps/web && bun test src/project-presentation.test.ts` → all pass.

### Step 8: Give the Projects panel the sibling header and search

In `apps/web/src/lib/features/report/breakdown/projects-panel.svelte`:

- Imports: add `cx` from `@ai-usage/design-system/css`; `actionRow, groupCount, groupHeader, groupPanel, groupTitle, searchInput` from `@ai-usage/design-system/svelte`; `projectSearchRows, projectsEmptyMessage` from `../../../../project-presentation`; `fmtNum` from `../../../foundation/presentation/format`; `analysisActions` from `./styles`.
  (`project-summary.svelte` imports `projectIdentityPresentation` and
  `projectLinesPresentation` from the same module in Step 9.)
- State: `let query = $state('');`
  `const visible = $derived(projectSearchRows(groups, query, payload.projectGroups));`
- `createExport` exports `projectBreakdownCsv(visible)` (visible rows, like
  Models exports "only visible sorted model rows").
- Markup:
  ```svelte
  <section data-projects-panel>
    <section class={groupPanel} data-breakdown-panel="projects">
      <header class={groupHeader}>
        <h2 class={groupTitle}>Projects</h2>
        <span class={groupCount} title={`${fmtNum(visible.length)} projects`}>{fmtNum(visible.length)} projects</span>
        <div class={cx(actionRow, analysisActions)}>
          <input aria-label="Search this breakdown" class={searchInput} placeholder="Search this breakdown" type="search" bind:value={query}>
          <ReportSharingActions {createExport} />
        </div>
      </header>
      <ProjectSummary catalogue={payload.projectGroups} emptyMessage={projectsEmptyMessage(query)} groups={visible} onManageProjectGroups={openManagement} {onProjectFilter} />
    </section>
    <details …>  <!-- unchanged: Manage project groups + ProjectGroupEditor -->
  </section>
  ```
  The outer `data-projects-panel` wrapper and the `table → details` DOM
  order are kept (e2e pins them).

**Verify**: `bun run typecheck` → exit 0 (after Step 9 adds the two new
props to `ProjectSummary`).

### Step 9: Rebuild the project table on the shared table classes

In `apps/web/src/lib/features/report/breakdown/project-summary.svelte`:

- New props: `catalogue?: readonly UsageReportProjectGroup[]`,
  `emptyMessage: string`.
- Replace the local desktop-table classes `desktopTableSurface`, `tableWrap`,
  `table`, `right`, `numCell`, `strongCell`, `groupKeyButton` with imports
  from `./styles`: `modelTableViewport` (already `display: { base: 'none', md: 'block' }`
  + `overflowX: 'auto'`), `modelTable`, `modelTableHeaderCell`,
  `modelTableCell`, `modelTextCell`, `modelNumericCell`, `modelNameButton`,
  `modelEmpty`. Keep the `minW: '840px'` intent by composing
  `cx(modelTable, projectTable)` with `projectTable = css({ minW: '840px' })`
  kept local (it carries no alignment, so it cannot conflict). The mobile
  list keeps its local `mobileSummarySurface` / `projectSummary*` classes —
  only swap its label button to `modelNameButton` and drop the `empty` div.
  If a shared class is genuinely missing, add one `css()` in
  `breakdown/styles.ts` next to the model classes rather than inline.
- Header row (every `<th scope="col">`):
  `Project` → `cx(modelTableHeaderCell, modelTextCell)`; `Sessions`, `Fresh`,
  `Cache`, `API value`, `Turns`, `Tools` → `cx(modelTableHeaderCell, modelNumericCell)`;
  `Lines` → **`Lines changed`** with `cx(modelTableHeaderCell, modelNumericCell)`.
  (Alignment lives on exactly one class per cell — `styles.ts` lines 177–180.)
- Identity cell becomes `<th class={cx(modelTableCell, modelTextCell)} scope="row">`:
  ```svelte
  {@const identity = projectIdentityPresentation(project, catalogue)}
  <div class={identityRow}>
    <button aria-label={`Filter sessions by project ${identity.name}`} class={modelNameButton} data-project-name onclick={() => onProjectFilter(project.key)} type="button">{identity.name}</button>
    {#if quality}<button …data-project-quality-label={quality}…>{quality}</button>{/if}
  </div>
  {#if identity.machines.length > 0}
    <span class={projectMachine} data-project-machine>{identity.machines.join(' · ')}</span>
  {/if}
  ```
  with `projectMachine = css({ display: 'block', mt: '2px', color: 'muted', fontSize: '11px', overflowWrap: 'anywhere' })`
  (local, no alignment property). The `(unknown)` tooltip uses `identity.name`.
  `quality` keeps calling `projectDataQualityLabel(project.label)`.
- Numeric cells: `cx(modelTableCell, modelNumericCell)`; Lines cell:
  ```svelte
  {@const lines = projectLinesPresentation(project)}
  <td class={cx(modelTableCell, modelNumericCell)} data-project-lines={lines.status}>
    <span title={lines.title}>{lines.label}</span>
    {#if lines.coverage}<span class={projectMachine} data-project-lines-coverage>{lines.coverage}</span>{/if}
  </td>
  ```
- Empty state: drop the `groups.length === 0` `<div class={empty}>No projects</div>`
  branch; always render the header+table; when `groups.length === 0` render
  `<tr><td class={modelEmpty} colspan="8"><span role="status">{emptyMessage}</span></td></tr>`
  (desktop) and `<li class={modelEmpty} role="status">{emptyMessage}</li>`
  (mobile list), mirroring Models lines 122–125 and the mobile `modelEmpty` item.
- Mobile cards (`aria-label="Project summaries"` — keep): same identity
  block (name button + `data-project-machine` line), `<dt>Lines changed</dt>`
  with the same label + coverage span.

**Verify**: `bun run typecheck` → exit 0; `bun x ultracite fix && bun run lint` → exit 0.

### Step 10: SSR render proof for identity, lines, header, and search

Create `apps/web/src/lib/features/report/breakdown/projects-panel.ssr.test.ts`
by copying the Vite harness from `model-analysis-table.ssr.test.ts` (lines
1–24 and 53–73; load `/apps/web/src/lib/features/report/breakdown/projects-panel.svelte`).
Fixture (synthetic names only):
- `catalogue: UsageReportProjectGroup[]` with
  `{ id: 'source:fixture-a|/home/alex/fixture-app', name: 'fixture-app — Fixture Machine', grouped: false, sources: [{ id: 'fixture-a|/home/alex/fixture-app', machineId: 'fixture-a', machineLabel: 'Fixture Machine', project: 'fixture-app', sourcePath: '/home/alex/fixture-app', gitRemote: '', sessions: 3, tokens: 0 }], … }`,
  the same for `fixture-b` / `Fixture Machine Secondary`, and
  `{ id: 'group:shared', name: 'Shared tooling', grouped: true, sources: [one per machine], … }` (fill the numeric fields with zeros).
- `groups: ProjectGroup[]` with matching `key`/`label` and line data:
  row A `lineMeasurement { measuredSessions: 1, totalSessions: 3 }, linesAdded: 0, linesDeleted: 0`;
  row B `{ 2, 2 }, 860, 120`; group `{ 0, 4 }`.
- props: `disabled: false, generatedAt: '2026-08-09T12:00:00.000Z', groups, onProjectFilter, onSave: () => Promise.resolve(), payload: { projectGroupConfigs: [], projectGroups: catalogue }`.

Assert on `body`:
- `data-breakdown-panel="projects"`, `aria-label="Search this breakdown"`, `>3 projects<`;
- `body.match(/scope="col"/g)` length 8 and `body.match(/scope="row"/g)` length 3;
- `>Lines changed</th>`; no `>Lines</th>`;
- `body.match(/data-project-name/g)` length 6 (3 desktop + 3 mobile);
  the composite label `'fixture-app — Fixture Machine'` (em dash) appears
  **nowhere** in `body` (the name and the machine are now separate nodes),
  while `'fixture-app'`, `'Shared tooling'` and
  `'aria-label="Filter sessions by project fixture-app"'` do;
- `body.match(/data-project-machine/g)` length 6 and the values
  `Fixture Machine`, `Fixture Machine Secondary`,
  `Fixture Machine · Fixture Machine Secondary` each present;
- `data-project-lines="lower-bound"`, `≥ +0/-0` and `1 of 3 sessions measured`
  present; `data-project-lines="exact"` and `+860/-120` present;
  `data-project-lines="unknown"` present; `body.match(/data-project-lines-coverage/g)`
  length 2 (only the lower-bound row carries a coverage line, desktop + mobile);
  the old `· 1/3 measured` shape is absent (`expect(body).not.toMatch(/\d+\/\d+ measured/)`);
- a second render with `groups: []` contains `role="status"` and `No projects`.

**Verify**: `cd apps/web && bun test src/lib/features/report/breakdown/projects-panel.ssr.test.ts` → all pass.

### Step 11: Computed-style proof for the header alignment and the search box

In `apps/web/e2e/dashboard-presentation.spec.ts`, extend the test at lines
289–318 after the existing assertions:
```ts
const projectHeader = projectsPanel.getByRole('columnheader', { name: 'Project' });
const sessionsHeader = projectsPanel.getByRole('columnheader', { name: 'Sessions' });
const firstRowHeader = projectsPanel.getByRole('rowheader').first();
await expect(projectHeader).toHaveCSS('text-align', 'left');       // was 'center' (UA default)
await expect(projectHeader).toHaveCSS('padding-left', '12px');     // was '1px' (UA default)
await expect(firstRowHeader).toHaveCSS('text-align', 'left');
await expect(firstRowHeader).toHaveCSS('padding-left', '12px');
await expect(sessionsHeader).toHaveCSS('text-align', 'right');
await expect(projectsPanel.getByRole('columnheader', { name: 'Lines changed' })).toBeVisible();

const search = projectsPanel.getByRole('searchbox', { name: 'Search this breakdown' });
await expect(search).toBeVisible();
await search.fill('no-such-project');
await expect(projectsPanel.getByRole('table').getByRole('status')).toHaveText('No breakdown rows match this search');
await expect(projectsPanel.locator('[data-project-name]')).toHaveCount(0);
await search.fill('');
await expect(projectsPanel.locator('[data-project-name]').first()).toBeVisible();
```
(Synthetic data has one project, `ai-usage`, with no catalogue, so
`[data-project-machine]` is absent here — that is the honest fallback; the
split is proven in Step 10.)

Also keep `apps/web/e2e/dashboard.spec.ts` lines 238–241 and 688–690 passing
unchanged (`columnheader 'Project'`, "Manage project groups", mobile
"Project summaries" list, no `table` at 361 px).

**Verify**: `bun run --cwd apps/web test:e2e -- e2e/dashboard-presentation.spec.ts e2e/dashboard.spec.ts` → pass.

### Step 12: Gates

`bun x ultracite fix && bun run lint && bun run typecheck && bun run --cwd apps/web test`
then `bun run --cwd apps/web build && bun run --cwd apps/web test:bundle`
then the three e2e specs above plus `e2e/accessibility.spec.ts` and
`e2e/visual-regression.spec.ts` (no snapshot captures the Projects tab,
`/sync`, or `/sources`; if one fails, treat as STOP — do not regenerate).
Finally the PII grep from the commands table → no output.

## Test plan

- SSR: `sync-render.test.ts` (single fleet representation, share fact);
  new `projects-panel.ssr.test.ts` (identity split, lines states, 8
  `scope="col"` with "Lines changed", search input, empty status).
- Unit: new `publication-status.test.ts` (all four publish states, outcome
  labels, pending count, RTK status, jargon regression guard);
  `project-presentation.test.ts` (identity, lines, search, empty message).
- e2e: `dashboard.spec.ts` `/sync` geometry (fleet → transfer adjacency 16 px,
  no table, no mobile contribution list); `sources.spec.ts` new plain-copy
  test + up-to-date assertions; `dashboard-presentation.spec.ts` computed
  `text-align`/`padding-left` on the Project header and row header, numeric
  header right-aligned, searchbox filters to the shared status message.
- Existing: `manual-transfer-model.test.ts` comparison/apportioning tests,
  `accessibility.spec.ts` (`/sync` axe + SSR geometry), `dashboard.spec.ts`
  Projects anchors — all unchanged and passing.

## Done criteria

- [ ] `test -e apps/web/src/lib/features/sync/machine-comparison.svelte` → file absent
- [ ] `grep -rn "Machine contributions\|tableWrap\|desktopTableSurface\|mobileSummarySurface\|projectSummaryList" apps/web/src/lib/features/sync` → no matches
- [ ] `grep -c "data-machine-fleet-share" apps/web/src/lib/features/sync/machine-fleet.svelte` → 1
- [ ] `grep -rn "Publication demand\|Caught up\|RTK dependency\|Report publication pipeline" apps/web/src` → no matches
- [ ] `grep -n "publicationStatus" apps/web/src/lib/features/sources/model.ts` → no matches; `apps/web/src/lib/features/sources/publication-status.ts` exists with `publicationStatus`, `publicationOutcomeLabel`, `pendingPublishRequests`, `rtkDependencyStatus`
- [ ] `grep -n 'data-breakdown-panel="projects"\|aria-label="Search this breakdown"' apps/web/src/lib/features/report/breakdown/projects-panel.svelte` → 2 hits
- [ ] `grep -n "data-project-machine\|data-project-lines\|Lines changed" apps/web/src/lib/features/report/breakdown/project-summary.svelte` → ≥ 4 hits; `grep -n "<th>Project</th>" …/project-summary.svelte` → no match
- [ ] `grep -n "projectIdentityPresentation\|projectLinesPresentation\|projectSearchRows" apps/web/src/project-presentation.ts` → 3 definitions
- [ ] `bun run typecheck` exits 0; `bun run lint` exits 0
- [ ] `bun run --cwd apps/web test` exits 0 including the two new test files
- [ ] `bun run --cwd apps/web test:bundle` exits 0 after a fresh build
- [ ] `bun run --cwd apps/web test:e2e -- e2e/dashboard.spec.ts e2e/dashboard-presentation.spec.ts e2e/sources.spec.ts e2e/accessibility.spec.ts` exits 0
- [ ] PII grep on this plan file → no output
- [ ] `git status` shows only in-scope files; `plans/README.md` row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows changes outside the named 088 exception, or
  `machine-fleet.svelte` no longer contains the `MachineLabelEditor` call /
  `data-stale-machine-guidance` block (another plan restructured the card).
- `payload.projectGroups` entries' `id` do not equal the `ProjectGroup.key`
  values for grouped/ungrouped rows in a live payload (check with the SSR
  fixture first; if the live join never matches, the identity helper would
  always fall back — report the observed keys instead of guessing a join).
- `projectBreakdownCsv` or any test pins the Projects `Lines` header text or
  the `+N/-M · a/b measured` cell format (would mean another surface owns it).
- The bundle guard fails after this change (the 2 % drift tolerance should
  absorb a few hundred bytes; a failure means something imported the report
  page from a root-closure module — report the diff of
  `apps/web/bundle/client-bundle.test.ts` output, do not move the number).
- A visual-regression snapshot fails — none should capture these surfaces;
  do not regenerate PNGs under this plan.
- `publicationStatus` gains a second consumer while you work (plan 095 or 077
  in flight) — coordinate rather than duplicating the move.

## Maintenance notes

- The fleet share percentages still come from `buildSyncFleetComparisonRows`;
  if plan 088 changes what the fleet "Sessions" number counts, the share
  follows automatically (same input). The rest of `SyncFleetComparisonRow`
  (`freshnessLabel`, `newestSessionLabel`, `current`) is now unused by any
  component — slim the model in a later cleanup if it stays unused; its
  tests are the only reason it is left intact here.
- Never reintroduce a `minH` on a sync table wrapper; the 320 px reservation
  is exactly what the audit saw as "empty space under two rows".
- The publication copy strings in `publication-status.ts` are a contract
  (pinned by unit + e2e). Add a new publication state there first, then in
  the tests, then in the page.
- Candidates deliberately left out: the Sources page subtitle
  "Policy, availability, lifecycle, and outcomes stay independent for every
  collector." and the meta line "Server-owned collection" (not flagged by the
  audit; same family — revisit with plan 095's header work); passing
  `identity.name` instead of `project.label` into `projectDataQualityLabel`
  (would badge machine-suffixed worktree sources — decide with its test at
  `project-presentation.test.ts` line 24); a "same project name on N
  machines — group them?" hint next to the machine line, which would give
  "Manage project groups" a reason to exist from the table itself; a
  sort control on the Projects panel (Models/Harnesses share
  `navigation.sort`; Projects stays cost-sorted).
- Reviewer should scrutinize: the `Fleet share` `'0%'` fallback for the
  synthesised current machine; that every `th`/`td` in the project table
  carries exactly one alignment atom (`modelTextCell` xor
  `modelNumericCell`); that the CSV still exports `group.label` (composite
  name) so downstream consumers are unaffected.
