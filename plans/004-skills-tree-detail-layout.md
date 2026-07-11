# Plan 004: Skills Tree + Detail Workspace for `/skills`

> **Executor instructions**: Follow this plan step by step. Run the
> verification commands for each slice before moving on. This plan changes the
> page information architecture: the primary object is now the skill, scoped by
> `Global` or project. Runtime exposure remains important, but it becomes
> supporting detail rather than the page's main structure.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 362f546..HEAD -- apps/web/src packages/design-system packages/skills plans
> ```
>
> If any in-scope file changed since this plan was written, compare this plan's
> "Current state" section against the live code before implementing. Stop if the
> snapshot shape, server-function envelopes, or SKILL.md save semantics changed.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: MED-HIGH (layout rewrite of `/skills`; existing reconcile and
  editor mutations must be preserved)
- **Depends on**: Plan 003 (DONE)
- **Category**: UX / information architecture
- **Planned at**: commit `362f546`, 2026-07-02
- **Log file**: create `plans/004-skills-tree-detail-layout-log.md` on start,
  one slice entry per step.

## Product Direction

The current UI is still matrix-led: it is very good at showing exposure health,
but it makes the user hunt for the actual object they care about. The next
version should make the page read as:

```text
Project / Global -> Skill -> Metadata + runtime exposure + actions
```

The primary screen should use three persistent zones:

```text
┌─────────────────────┬──────────────────────────────────────┬─────────────────────┐
│ Scope tree           │ Skill detail                         │ Actions / health     │
│                     │                                      │                     │
│ Global              │ pr-review                            │ Issues              │
│  ├─ pr-review        │ Review a Git branch...               │ Broken links: 0      │
│  └─ recent-work      │                                      │ Copies: 2            │
│                     │ Metadata                             │                     │
│ Projects            │ Source path, invocation, tokens       │ Quick actions        │
│  └─ ai-usage         │                                      │ Reconcile            │
│     ├─ pr-review     │ Runtime exposure                     │ Enable / Disable     │
│     └─ recent-work   │ Codex linked, Claude copy, ...       │                     │
└─────────────────────┴──────────────────────────────────────┴─────────────────────┘
```

The drawer should stop hiding important information. It can remain for temporary
workflows if needed, but the canonical skill data and SKILL.md editor should
live in the central detail pane.

## Locked Decisions

1. **Skills are the center of the UI.** The skill detail pane is the default
   destination after selecting any tree item.
2. **Projects and Global are peer scopes.** A project is not a secondary tab
   hidden behind `Projects (n)`.
3. **Runtimes are secondary.** Do not put runtimes in the primary tree. Runtime
   exposure appears inside the skill detail pane and the action/diagnostic
   panel.
4. **Keep the matrix as a secondary view.** The existing matrix remains useful
   as `Matrix` or `Exposure matrix`, but it is no longer the default global
   composition.
5. **Preserve mutation semantics.** Reconcile, toggle, config save, and SKILL.md
   save behavior must remain unchanged.
6. **Use "runtime" in UI copy.** Existing `HarnessBadge` component names may
   remain because they belong to the design-system/report vocabulary.

## Current State

- `apps/web/src/routes/skills.tsx` owns page state, tabs, pending operations,
  config persistence, reconcile preview, and selected drawer skill.
- `GlobalTab` renders: operation banner, health tiles, `SkillsMatrix`,
  consolidate fold, disabled fold, and configuration fold.
- `ProjectsTab` renders project inventory cards only after switching to the
  Projects tab.
- `SkillsDrawer` already contains the most important skill information:
  metadata badges, runtime exposure, SKILL.md preview/editor, diagnostics, and
  reconcile/toggle actions.
- `skills-page-model.ts` already exposes enough data for global skills:
  `buildSkillMatrix`, `buildSkillHealthSummary`, `filterMatrixRows`,
  `projectionStateLabel`, `skillInvocation`, unmanaged grouping.
- `ProjectSkillInventory` data is separate from the global snapshot and is
  currently loaded only when the `Projects` tab is active.

## Target UX

### First Screen

- Header stays compact: title, source path, report/sync/theme actions.
- Under the header, render a workspace instead of tabs:
  - left: tree navigation for `Global` and configured projects
  - center: selected skill detail or selected scope overview
  - right: contextual health/actions panel
- Health counters become compact contextual summaries, not the top visual
  priority.

### Selection Rules

- Default selection:
  - if global skills exist, select the first global skill needing attention;
  - otherwise select the first global skill;
  - otherwise select the first project scope;
  - otherwise show a configuration empty state.
- Selecting a scope (`Global`, project path) shows a scope overview in the
  center, including a compact skill list and health summary.
- Selecting a skill shows the skill detail pane.
- Search in the left tree filters scopes and skill names without destroying the
  current selection unless the selected item disappears.

### Central Skill Detail

The center pane should show, in order:

1. skill title, description, validation status, enabled state
2. metadata grid: source path, origin/scope, invocation mode, token count,
   validation status
3. runtime exposure list with state, expected path, actual path when relevant,
   and reconcile affordances
4. SKILL.md viewer/editor
5. diagnostics

### Right Context Panel

The right pane should show:

- current selection health summary
- primary actions: enable/disable, reconcile skill, preview/reconcile all when
  a scope is selected
- blocked/broken runtime details
- consolidate backlog links when relevant
- configuration shortcuts only when no skill is selected or the selected scope
  needs setup

## Steps

### Step 1 - Add a Workspace Model

- **Files**: `apps/web/src/skills-page-model.ts`,
  `apps/web/src/skills-page-model.test.ts`
- **Change**:
  - Add explicit selection types:
    - `SkillSelection = { type: 'global-skill'; skillName: string } |
      { type: 'project-skill'; projectPath: string; skillName: string } |
      { type: 'global-scope' } | { type: 'project-scope'; projectPath: string }`
  - Add a tree model builder:
    - global node from `snapshot.skills`
    - project nodes from `ProjectSkillInventory[]`
    - skill children sorted by attention first, then name
  - Add helpers to derive:
    - selected global `SourceSkill`
    - selected project skill row/observations
    - attention counts per scope
    - runtime exposure rows for one global skill
- **Keep out of scope**: project-owned SKILL.md editing unless the backend
  already exposes safe source-path save support for project skills.
- **Verify**:
  ```bash
  bun test apps/web/src/skills-page-model.test.ts
  ```

### Step 2 - Introduce the Three-Pane Layout Components

- **Files**:
  - `apps/web/src/skills-workspace.tsx` (new)
  - `apps/web/src/skills-tree.tsx` (new)
  - `apps/web/src/skills-detail.tsx` (new)
  - `apps/web/src/skills-context-panel.tsx` (new)
  - `packages/design-system/src/components/panel.ts` only if reusable layout
    primitives are missing
- **Change**:
  - Build a responsive grid:
    - desktop: `280px minmax(0, 1fr) 320px`
    - tablet: left column + center, right panel below center
    - mobile: tree becomes a collapsible top section, then detail, then actions
  - Use stable min widths and overflow rules so long paths and skill names wrap
    instead of forcing horizontal overflow.
  - Do not nest UI cards inside cards. Panes may be bordered panels; repeated
    items inside them can be rows or compact cards.
- **Verify**:
  ```bash
  bun run --cwd apps/web dev:standalone
  ```
  Then visually inspect `/skills` at 1440x1200, 1024x900, and 390x844.

### Step 3 - Replace Tabs With Scope Tree Routing

- **Files**: `apps/web/src/routes/skills.tsx`,
  `apps/web/src/skills-workspace.tsx`
- **Change**:
  - Remove `Tabs` as the primary navigation for `/skills`.
  - Load project inventories for the workspace, not only after opening a
    Projects tab. Keep the existing server envelope and loading/error handling.
  - Move `selectedSkillName` to the new `SkillSelection` state.
  - Initialize the default selection from the workspace model.
  - Preserve `OperationBanner` near the top of the workspace.
- **Compatibility**:
  - Keep `SkillsMatrix` available through a secondary control, for example a
    `Matrix` button in the right panel or a compact `Exposure matrix` fold.
  - Do not delete the old matrix component in this step.
- **Verify**:
  ```bash
  bun test apps/web/src/skills-page-model.test.ts apps/web/src/sync-page-model.test.ts
  bun run typecheck
  ```

### Step 4 - Move Global Skill Detail Out of the Drawer

- **Files**: `apps/web/src/skills-detail.tsx`,
  `apps/web/src/skills-drawer.tsx`, `apps/web/src/routes/skills.tsx`
- **Change**:
  - Extract reusable presentational sections from `SkillsDrawer`:
    - metadata badges
    - exposure list
    - SKILL.md viewer/editor
    - diagnostics list
  - Render those sections in the central detail pane for global skills.
  - Keep the same `getManagedSkillMarkdown` and `saveManagedSkillMarkdown`
    behavior, including SHA conflict handling.
  - Keep the drawer only for temporary flows if still needed. If no caller
    remains, remove `SkillsDrawer`.
- **Verify**:
  ```bash
  bun test apps/web/src/server/skills.server.test.ts apps/web/src/skills-page-model.test.ts
  bun run typecheck
  ```
  Manual check: edit a global `SKILL.md`, cancel, save, and conflict message
  behavior still work.

### Step 5 - Add Scope and Project Detail States

- **Files**: `apps/web/src/skills-detail.tsx`,
  `apps/web/src/skills-context-panel.tsx`, `apps/web/src/skills-projects.tsx`
- **Change**:
  - Selecting `Global` shows:
    - compact global health summary
    - top skills needing attention
    - global source repository path
    - link/control to open the matrix view
  - Selecting a project shows:
    - project path
    - observed project-owned skills
    - global skills exposed into that project
    - project diagnostics
  - Selecting a project skill shows read-only project skill detail using
    `ProjectSkillObservation` data. Do not pretend it is editable unless safe
    save support exists.
- **Verify**:
  ```bash
  bun test apps/web/src/skills-page-model.test.ts
  bun run typecheck
  ```

### Step 6 - Rebuild the Right Context Panel

- **Files**: `apps/web/src/skills-context-panel.tsx`,
  `apps/web/src/routes/skills.tsx`
- **Change**:
  - For global skill selection:
    - show enable/disable
    - show reconcile when any runtime exposure is missing/broken/wrong target
    - list unresolved broken/blocked runtime states
  - For global scope selection:
    - show preview/reconcile all
    - show health counts
    - show consolidate backlog entry point
  - For project selection:
    - show project diagnostics and configured path actions
  - Ensure pending operations use the existing `pendingOperation` strings and
    show local busy state on the active control.
- **Verify**:
  ```bash
  bun run typecheck
  ```
  Manual check: toggle, reconcile one skill, preview reconcile all, and dismiss
  operation notices.

### Step 7 - Keep the Matrix as a Secondary View

- **Files**: `apps/web/src/skills-matrix.tsx`,
  `apps/web/src/skills-workspace.tsx`, `apps/web/src/routes/skills.tsx`
- **Change**:
  - Move `SkillsMatrix` behind an explicit secondary mode:
    - acceptable options: modal-like panel, full-width fold below detail, or
      route-local view toggle `Detail | Matrix`
  - Matrix interactions should update the same central selection instead of
    opening a drawer.
  - Keep filters, health tile interactions, and reconcile preview behavior.
- **Verify**:
  ```bash
  bun test apps/web/src/skills-page-model.test.ts
  bun run typecheck
  ```

### Step 8 - Responsive and Accessibility Pass

- **Files**: all new workspace components, `apps/web/src/index.css` if needed
- **Change**:
  - Tree items are real buttons with `aria-current` or `aria-selected`.
  - Scope groups use semantic headings and expandable controls where
    collapsed.
  - Keyboard flow:
    - tree search
    - tree item buttons
    - central detail actions/editor
    - right-panel actions
  - Long project paths and skill names wrap cleanly on mobile.
  - Empty states are useful:
    - no configured source
    - no project paths
    - selected project has no observed skills
    - selected skill deleted after refresh
- **Verify**:
  ```bash
  bun run --cwd apps/web dev:standalone
  ```
  Inspect desktop and mobile. Keyboard-only navigation should reach all
  selection and mutation controls.

### Step 9 - Remove Dead UI and Update Docs

- **Files**:
  - `apps/web/src/routes/skills.tsx`
  - `apps/web/src/skills-drawer.tsx` if unused
  - `apps/web/src/skills-projects.tsx` if superseded
  - `docs/skills-management.md`
  - `plans/README.md`
- **Change**:
  - Delete components no longer used by the workspace.
  - Update docs to describe the new hierarchy:
    `Global / Project -> Skill -> Runtime exposure`.
  - Add Plan 004 to `plans/README.md` status table.
- **Verify**:
  ```bash
  bun run lint
  bun run typecheck
  bun run build
  ```

## STOP Conditions

- A change would require writing project-owned skill files without an explicit,
  safe server mutation path.
- Project inventory loading becomes required for all global skill operations to
  work. Global skill management must remain usable even if project inventory
  loading fails.
- Any mutation starts writing directly into runtime folders except through the
  existing reconcile actions.
- SKILL.md save loses SHA conflict detection.
- The matrix rewrite changes reconcile semantics or applies previewed actions
  without user confirmation.

## Verification Matrix

| Scenario | Expected |
| --- | --- |
| Open `/skills` with configured source | Left tree, central selected skill, right actions render immediately |
| Open with no project paths | Global skills still usable; project empty state offers configuration |
| Select global skill | Metadata, runtime exposure, SKILL.md editor, diagnostics are visible without drawer |
| Select project | Project path, observed skills, exposed global skills, diagnostics are visible |
| Toggle skill | Only active control shows pending state; operation banner appears once |
| Reconcile skill | Same server behavior as before; central detail refreshes |
| Matrix view | Existing filters and status semantics still work |
| Mobile viewport | Tree, detail, and actions stack without text overlap or horizontal page scroll |
