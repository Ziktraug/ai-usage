# Plan 005: Skills Tree Curation & Honest Context Panel for `/skills`

> **Executor instructions**: Follow this plan step by step. Run the
> verification commands for each slice before moving on. This plan fixes the
> post-plan-004 UX findings: the scope tree is flooded by uncurated discovered
> paths, warning pills fire on everything, the right panel advertises actions
> it does not have, and project skills hide their main object (the SKILL.md).
> It adds exactly one new server function, and it is read-only.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 661b5ce..HEAD -- apps/web/src packages/skills plans
> ```
>
> If any in-scope file changed since this plan was written, compare this plan's
> "Current state" section against the live code before implementing. Stop if
> the tree model shape, the known-project collection, or the server-function
> envelopes changed.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: MED (tree interaction rework; one new read-only server function;
  no mutation semantics change)
- **Depends on**: Plan 004 (DONE)
- **Category**: UX / data curation
- **Planned at**: commit `661b5ce`, 2026-07-02
- **Log file**: create `plans/005-skills-tree-curation-log.md` on start, one
  slice entry per step.

## Product Direction

Plan 004 shipped the right information architecture (scope tree → skill detail
→ context panel), but the tree is fed by the raw session history: every
directory where an agent session ever ran becomes a fully expanded scope. The
observed result on a real machine:

- the home directory appears as a project scope and re-lists the entire global
  runtime content (~40 entries) as if it were project-owned skills;
- workspace container directories (a `Projects/` folder that merely contains
  repos) appear as scopes;
- a dozen scopes with zero skills each burn 3-4 sidebar lines because full
  absolute paths wrap;
- the machine label is appended to every scope even though the collection is
  already filtered to the local machine;
- nearly every skill row carries an orange pill because "not linked yet"
  counts as attention, so the pills no longer signal anything;
- below the `xl` breakpoint the tree is not sticky/scrollable, so the page can
  reach five figures of pixels in height;
- selecting a project skill produces an "Actions" panel with zero actions and
  a central pane that stops at metadata — no SKILL.md.

The fix has two halves. **Curate the data**: discovery must only surface
directories that plausibly are projects, and never the home directory.
**Spend the pixels honestly**: collapsed-by-default navigation, pills reserved
for actionable issues, a context panel that always offers something, and the
SKILL.md visible for every skill, read-only where writing is unsafe.

## Locked Decisions

1. **Config is sovereign, discovery is curated.** Paths listed explicitly in
   `skillsConfig.projectPaths` are never filtered out. Curation rules apply
   only to paths discovered from session history.
2. **The home directory is never a project scope.** Its runtime dirs are the
   global fan-out targets plus the consolidation backlog, both already
   represented elsewhere on the page.
3. **The tree is navigation, not an inventory dump.** Project scopes are
   collapsed by default; scopes without skills are demoted to a fold.
4. **Warning pills mean actionable issues** (invalid, to-repair, blocked),
   not "not linked yet". Pending links are still counted, but quietly.
5. **The right panel never advertises actions it cannot perform.** No
   disabled placeholder buttons. "Adopt into source" is plan 006; until it
   exists it does not appear.
6. **Project skills remain read-only in this plan.** They gain a SKILL.md
   *viewer*; the editor keeps writing only to the managed source repo.
7. **Selection is URL-addressable.** Refresh, back button, and shared links
   restore the same selection.
8. **Preserve mutation semantics.** Reconcile, toggle, config save, and
   SKILL.md save behavior must remain unchanged (carried over from plan 004).

## Current State

- `apps/web/src/server/skills.server.ts`:
  - `pathEntryLabel` (line ~163) appends `· machineLabel` to every label even
    though `addKnownProjectPath` (line ~166) already drops non-local machines
    via `localMachineId` (line ~177).
  - `knownSkillProjectPathsFromReportPayload` (line ~204) keeps any existing
    directory (`directoryExists`, line ~184) — no project-ness check, no home
    exclusion.
  - `projectSkillScanPathsFrom` (line ~246) unions config `projectPaths` with
    every discovered path; `readKnownSkillProjectPathsForServer` (line ~261)
    wires `localDirectoryExists` + machine id.
- `apps/web/src/skills-page-model.ts`:
  - `isAttentionProjectionState` (line ~189) counts `missing` alongside
    repair/blocked/`disabled-exposed`, which is why pills fire everywhere.
  - `globalSkillAttentionCount` (line ~196), `projectSkillAttentionCount`
    (line ~208), `attentionThenNameSort` (line ~216, used only by
    `buildSkillTree`).
  - `buildSkillTree` (line ~322) unions known projects + inventories into flat
    always-expanded scopes; scope label falls back to last path segment; no
    short-path, no empty/non-empty partition. `selectionKey` (line ~409) is
    already a stable string form.
- `apps/web/src/skills-tree.tsx`: sticky + `maxH` + `overflow: auto` only at
  `xl` (lines ~21-23); scope rows render label + full path inline with
  `overflowWrap: anywhere`; every scope always renders all skill buttons; the
  pill shows `attentionCount` or `!`.
- `apps/web/src/skills-workspace.tsx`: `workspaceGrid` (line ~37) is
  `280px minmax(0,1fr)` from `lg`, third column from `xl`; selection is a
  local `createSignal` (line ~84) with a fallback effect (lines ~90-95);
  nothing is reflected in the URL.
- `apps/web/src/skills-context-panel.tsx`: health metrics + reconcile only
  render for `global-scope` selection (lines ~137-148); `ProjectSkillActions`
  (lines ~357-369) renders two metric rows plus a `Read-only` pill — an
  actions panel with zero actions.
- `apps/web/src/skills-detail.tsx`: `ProjectSkillDetail` (line ~659) shows an
  `Edit mode: Read-only` metadata tile (line ~676), two near-identical paths
  per observation (lines ~691-692), and no SKILL.md content. The global
  `SkillMarkdownEditor` (line ~493) is the only markdown surface. The file
  also keeps a local copy of `projectSkillDirectories` (line ~204) although
  the package exports it.
- `packages/skills/src/index.ts` exports `projectSkillDirectories` (line
  ~266) and `scanProjectSkills` (line ~1045); the web server already imports
  `scanProjectSkills`.
- `apps/web/src/routes/skills.tsx` uses TanStack Solid Router
  (`createFileRoute('/skills')`, line ~49) — search-param validation is
  available but unused.
- Fold precedent: `skills-consolidate.tsx` uses native `<details>/<summary>`.

## Target UX

```text
┌ Skills ──────────────────┐  ┌ Detail ───────────────────────┐  ┌ Context ─────────────┐
│ [filter…]                │  │ exalibur-caching  (valid|Auto)│  │ Source health        │
│ ▾ Global             12 │  │ description…                  │  │  Healthy 58/72       │
│    pr-review          ⚠2 │  │ [metadata grid]               │  │  To repair 3  →      │
│    recent-work-context   │  │ Runtime placement (1 path/row)│  │  Blocked 1    →      │
│ ▸ example-app         8 │  │ SKILL.md (read-only)          │  │  Consolidate 8→      │
│ ▸ example-app-fork    8 │  │  ┌──────────────────────────┐ │  │ ──────────────       │
│ ▸ other-repo          3 │  │  │ # exalibur-caching       │ │  │ Project skill        │
│                          │  │  │ Repository guidance for… │ │  │ [Copy skill path]    │
│ ▸ Projects without       │  │  └──────────────────────────┘ │  │ Read-only — adopt    │
│   skills (14)            │  │ Also present in: example-app… │  │ flow arrives later   │
└──────────────────────────┘  └───────────────────────────────┘  └──────────────────────┘
```

- Tree rows are single-line: name + shortened path (`…/last/two-segments`),
  full path in the `title` tooltip, no machine label on a single machine.
- Orange pills appear only for invalid/repair/blocked; their `title` explains
  the count ("2 to repair · 3 not linked").
- The right panel always shows the global source health block; every selection
  type contributes at least one real affordance.

## Steps

### Step 1 - Curate Discovered Project Paths

- **Files**: `apps/web/src/server/skills.server.ts`,
  `apps/web/src/server/skills.server.test.ts`
- **Change**:
  - Extend `KnownSkillProjectPathOptions` with `homePath?: string` and
    `isProjectRoot?: (projectPath: string) => boolean` (injected like the
    existing `directoryExists`, so tests stay filesystem-free).
  - In `knownSkillProjectPathsFromReportPayload` / `addKnownProjectPath`:
    - drop an entry whose normalized path equals `homePath` — this rule runs
      **before** the marker check, because the home directory does contain
      runtime skill dirs;
    - drop entries where `isProjectRoot` returns false.
  - Default `isProjectRoot` in `readKnownSkillProjectPathsForServer`: the
    directory contains a `.git` entry (directory **or** file, to keep
    worktrees) **or** at least one of the project runtime skill directories
    from `projectSkillDirectories` (import from `@ai-usage/skills`). This
    keeps monorepo roots, drops workspace container folders, and drops any
    session-launch location that is not a project.
  - Source `homePath` from the same storage/home used by
    `loadSnapshotForStorage` (`storage.home`), not a hardcoded value.
  - `pathEntryLabel`: stop appending the machine label — entries are already
    filtered to the local machine. Keep `machineLabel` in the data structure
    for a future multi-machine mode; rendering it becomes the UI's decision
    (and the UI will not render it in this plan).
  - `projectSkillScanPathsFrom` keeps unioning explicit config paths first;
    curation must never remove a configured path.
- **Verify**:
  ```bash
  bun test apps/web/src/server/skills.server.test.ts
  ```
  New cases: home path dropped even with runtime dirs; container dir without
  markers dropped; `.git`-file worktree kept; runtime-dir-only project kept;
  configured path always kept; labels carry no machine suffix.

### Step 2 - Honest Attention Model, Stable Ordering, Short Paths

- **Files**: `apps/web/src/skills-page-model.ts`,
  `apps/web/src/skills-page-model.test.ts`
- **Change**:
  - Split attention into two counters, for global and project skills alike:
    - `issueCount`: invalid validation, repair states, blocked states,
      `disabled-exposed`, diagnostics/placement problems (project side);
    - `pendingLinkCount`: `missing` projections only.
    - Provide a human `attentionSummary` string ("2 to repair · 3 not
      linked") for tooltips. Keep `selectionKey` as-is and add
      `parseSelectionKey(key): SkillSelection | undefined` for step 6.
  - Tree skill nodes sort alphabetically (plain `localeCompare`); delete
    `attentionThenNameSort` once unused. Priority ordering stays the job of
    the "Needs attention" list in `GlobalScopeDetail`.
  - Scope nodes gain `hasSkills`, aggregated `issueCount` /
    `pendingLinkCount`, and `shortPath` (last two path segments, `…/`
    prefix when truncated; full `path` retained).
  - `SkillTreeModel` becomes `{ scopes, emptyScopes }`: project scopes with
    zero skills and zero issues move to `emptyScopes`. Global always stays in
    `scopes`.
  - `defaultSkillSelection`: prefer the first global skill with
    `issueCount > 0`; otherwise first global skill; otherwise first project
    scope (same spirit as today under the new semantics).
- **Verify**:
  ```bash
  bun test apps/web/src/skills-page-model.test.ts
  ```

### Step 3 - Tree UI: Collapse, Single-Line Rows, Sticky From `lg`

- **Files**: `apps/web/src/skills-tree.tsx`, `apps/web/src/skills-workspace.tsx`
- **Change**:
  - Expansion state lives in the workspace: a `Set<string>` of expanded scope
    keys, initialized to `global` plus the scope containing the default
    selection. `select()` auto-expands the scope of any new selection. The
    tree receives `expandedKeys` + `onToggleScope`.
  - Scope row = two controls side by side: a chevron toggle button
    (`aria-expanded`, `aria-controls` on the skill list, accessible label
    "Expand <scope>") and the existing scope-select button. Skill buttons
    render only when expanded; a non-empty filter query force-shows matching
    skills without mutating the persisted expansion set.
  - Row layout: label + `shortPath` on one line (`nowrap` + ellipsis), full
    path in `title`. No machine label. Skill count stays right-aligned.
  - Pills: invalid → red `!` (Panda escaping: use `content: "'!'"`, the
    trailing-`!` form is parsed as `!important` — plan 003 leftover); orange
    pill only when `issueCount > 0`, with `title={attentionSummary}`;
    `pendingLinkCount` appears only inside the tooltip text, never as a pill.
  - Append a "Projects without skills (N)" `<details>` fold after the scope
    list (same pattern as `skills-consolidate.tsx`), one select-button per
    empty scope so they stay reachable.
  - `treePanel`: sticky + `maxH` + internal scroll from `lg` (currently
    `xl`). Below `lg` the collapsed-by-default tree keeps page height
    bounded; no combobox needed in this plan.
- **Verify**:
  ```bash
  bun run --cwd apps/web dev:standalone
  ```
  Inspect at 1440x1200, 1150x900, and 390x844: page height stays near the
  viewport at ≥1024px; keyboard reaches chevron, scope, skills, fold.

### Step 4 - Context Panel: Permanent Health, No Empty "Actions"

- **Files**: `apps/web/src/skills-context-panel.tsx`,
  `apps/web/src/skills-workspace.tsx`
- **Change**:
  - Render a compact **Source health** block for *every* selection type
    (Healthy links, To repair, Blocked, To consolidate). Each row is a
    button: select the global scope and, for repair/blocked, set the matching
    matrix state filter and open the matrix (wire through the existing
    `onOpenMatrix` / `onCellStateFilterChange` props).
  - `global-skill` selection: keep Enable/Disable + Reconcile + issue list
    unchanged.
  - `project-skill` selection: delete the metrics + `Read-only` pill stub.
    Replace with a real affordance set: "Copy skill path" (clipboard write of
    the observation directory, transient "Copied" feedback) and a one-line
    read-only note in plain words ("Read-only — adopt-into-source arrives in
    a later plan"). Observation/diagnostic counts move to the central
    metadata grid (step 5).
  - `project-scope` selection: keep diagnostics; add "Copy project path".
  - Panel subtitle reflects the selection ("Global source", "Project skill —
    read-only") so the panel never reads as a broken promise.
  - **Keep out of scope**: any "Adopt into source" button, even disabled.
    That mutation is plan 006.
- **Verify**:
  ```bash
  bun run typecheck
  ```
  Manual: each selection type shows the health block plus ≥1 action; pending
  states still render on the active control only.

### Step 5 - Project SKILL.md Read-Only Viewer + Metadata Cleanup

- **Files**: `apps/web/src/server/skills.ts`,
  `apps/web/src/server/skills.server.ts`,
  `apps/web/src/server/skills.server.test.ts`,
  `apps/web/src/skills-detail.tsx`
- **Change**:
  - New server function `getProjectSkillMarkdown` (GET) backed by
    `readProjectSkillMarkdownForServer(input: { projectPath, skillName,
    runtimeDirId })`:
    1. validate `runtimeDirId` against `projectSkillDirectories` ids and
       `skillName` via `parseSkillName`;
    2. recompute the allowed set via `projectSkillScanPathsFrom(config,
       knownPaths)` and reject any `projectPath` outside it — the client can
       choose *which* known project, never *which file*;
    3. `scanProjectSkills({ projectPaths: [projectPath], sourceRepoPath })`,
       locate the observation for `(skillName, runtimeDirId)`, and read only
       its server-derived `skillMdPath`. Return `{ content, path }`, capping
       content at a sane size (e.g. 64 KiB with a `truncated` flag).
    - No write counterpart exists or is added.
  - `ProjectSkillDetail`:
    - metadata grid: replace the `Edit mode: Read-only` tile with observed
      runtime + diagnostics counts (moved from the context panel); keep
      project path, tokens;
    - placement rows: one path per observation (the `skillMdPath`), full
      path in `title` — drop the duplicated second line;
    - add a "SKILL.md — read-only" section: `createResource` keyed on the
      selection, rendered with the same preview presentation as the global
      viewer. Extract the preview block from `SkillMarkdownEditor` into a
      shared component rather than duplicating it. When a skill has multiple
      observations, offer a small runtime picker; default to the first.
  - Replace the local `projectSkillDirectories` copy in `skills-detail.tsx`
    with the `@ai-usage/skills` export.
- **Verify**:
  ```bash
  bun test apps/web/src/server/skills.server.test.ts
  bun run typecheck
  ```
  Server tests: foreign `projectPath` rejected; traversal-shaped `skillName`
  rejected; happy path returns content. Manual: project skill shows its
  SKILL.md; the global editor still saves and still reports SHA conflicts.

### Step 6 - URL-Addressable Selection

- **Files**: `apps/web/src/routes/skills.tsx`, `apps/web/src/skills-workspace.tsx`
- **Change**:
  - Add `validateSearch` on the route: `{ sel?: string }` in `selectionKey`
    format. Unknown/invalid values are treated as absent.
  - Workspace: initial selection = `parseSelectionKey(search.sel)` when it
    resolves to an existing tree key, else `defaultSkillSelection`. User
    selections `navigate({ search: { sel }, resetScroll: false })` as history
    pushes; the existing disappeared-selection fallback effect performs a
    `replace` so it never traps the back button.
  - View mode (matrix) stays out of the URL in this plan.
- **Verify**:
  ```bash
  bun run typecheck
  ```
  Manual: reload restores selection; back/forward walk selections; a stale
  `sel` falls back to the default without an error flash.

### Step 7 - Cross-Scope Duplicate Links

- **Files**: `apps/web/src/skills-page-model.ts`,
  `apps/web/src/skills-page-model.test.ts`, `apps/web/src/skills-detail.tsx`
- **Change**:
  - Add `skillScopeMatches(tree, skillName, excludeKey)` returning
    `{ scopeLabel, selection }[]` for every other scope (global or project)
    containing a skill with the same name.
  - Detail hero renders "Also present in:" chips (buttons → `onSelect`) when
    matches exist; nothing otherwise. After steps 1-2 remove the fake
    home-directory duplicates, the remaining matches are genuinely
    informative (real repo clones carrying the same skills).
- **Verify**:
  ```bash
  bun test apps/web/src/skills-page-model.test.ts
  ```
  Manual: chip navigates to the sibling scope's skill.

### Step 8 - Cleanup, Docs, Plan Bookkeeping

- **Files**: `docs/skills-management.md`, `plans/README.md`, touched
  components
- **Change**:
  - Delete now-dead helpers/styles (`attentionThenNameSort` if unused, the
    old pill logic, wrapped-path styles).
  - Document the curation rules in `docs/skills-management.md`: what makes a
    discovered directory a known project (`.git` or runtime skill dirs, never
    the home directory) and how to force-include a path via
    `skillsConfig.projectPaths`.
  - Update the plan 005 row to DONE in `plans/README.md`; note
    "Adopt into source" as the plan 006 candidate.
- **Verify**:
  ```bash
  bun run lint
  bun run typecheck
  bun run build
  ```

## STOP Conditions

- A curation rule would drop a path explicitly listed in
  `skillsConfig.projectPaths`.
- `getProjectSkillMarkdown` would read any path not derived server-side from
  a scan of an allowed project path.
- Any step requires a new mutation (adopt, project-skill write) — that is
  plan 006.
- Reconcile, toggle, config save, or SKILL.md save semantics change, or
  SKILL.md save loses SHA conflict detection.
- Known-path collection failure breaks global skill management (the existing
  error envelope + a global-only tree must keep working).
- Two distinct sibling directories differing only by case would be merged or
  deduplicated.

## Verification Matrix

| Scenario | Expected |
| --- | --- |
| Open `/skills` with many discovered projects | Global expanded, projects collapsed; page height ≈ viewport at ≥1024px wide |
| Sessions ran in the home directory | No home scope in the tree; global runtime content appears only via the consolidate backlog |
| Sessions ran in a workspace container folder (no `.git`, no runtime dirs) | Folder absent from the tree |
| Discovered project with zero skills | Listed under "Projects without skills (N)" fold, still selectable |
| Single-machine data | No machine label rendered in the tree |
| Skill never linked anywhere, otherwise healthy | No orange pill; count visible in tooltip only |
| Skill with repair/blocked/invalid state | Orange or red pill with explanatory `title` |
| Select a project skill | Central pane shows metadata + one path per placement + read-only SKILL.md; right panel shows health block + copy action; no orphan "Read-only" pill |
| `?sel=` deep link | Reload restores the selection; back/forward walk history; stale keys fall back silently |
| Same skill name in two real project clones | "Also present in" chips navigate between them |
| Global SKILL.md editor | Save and SHA-conflict behavior unchanged |
| Matrix view | Still reachable from the context panel; filters and reconcile preview/apply unchanged |
