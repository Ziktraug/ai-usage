# Plan 002: Skills Inventory UI — Multi-Axis Redesign of `/skills`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise around filesystem mutation safety.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 0b9a428..HEAD -- apps/web/src packages/skills packages/design-system packages/local-collectors docs plans
> ```
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch that changes the snapshot shape, the server function envelope, or
> the reconcile workflow semantics, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (one behavioral change in the reconcile workflow; everything
  else is additive or presentational)
- **Depends on**: Plan 001 (DONE)
- **Category**: UX / direction
- **Planned at**: commit `0b9a428`, 2026-07-02
- **Log file**: create `plans/002-skills-inventory-ui-log.md` on start, one
  slice entry per step (same format as `plans/001-integrate-skill-management-log.md`).

## Why this matters

Plan 001 shipped a functionally complete `/skills` control plane, but the UI
fails on a real machine. Measured on the operator's environment
(2 managed skills, ~159 unmanaged entries across runtimes):

- Rendered page height: **9,688 px** on desktop (1440×900), **11,637 px** on
  mobile (390×844). Cause: `UnmanagedTable` renders every unmanaged entry as an
  unbounded flat list (`apps/web/src/routes/skills.tsx:834`).
- The "Needs attention" tile sums `unhealthyProjectionCount +
  unmanagedEntryCount` (`apps/web/src/skills-page-model.ts:22-24`), producing a
  meaningless "159" that drowns the actionable signal (1–2 broken managed
  links).
- **Reconcile all is permanently disabled on any real machine**:
  `canReconcileAllActiveSkills` requires `unmanagedEntries.length === 0`
  (`skills-page-model.ts:72-74`), and the workflow itself is all-or-nothing —
  one refused action aborts every safe action (`packages/skills/src/index.ts:1409-1411`).
- Skill **descriptions are never displayed**, severity is never color-coded,
  the per-target projection column concatenates labels into unreadable strings,
  and the config form dominates the above-the-fold area.

### Validated product intent (operator decisions, 2026-07-01/02)

The page is a **complete multi-axis inventory of Agent Skills on this
machine**, not just managed-symlink status:

| Axis | Values | UI consequence |
| --- | --- | --- |
| Scope | global vs project-owned | Top-level `Global` / `Projects` tabs |
| Invocation | auto-invocable vs manual | Badge + filter per skill |
| Origin | personal vs installed (GitHub, skills.sh) | Optional badge (additive metadata, Step 9) |
| State | enabled vs disabled-without-deleting | Row toggle + collapsed "Disabled" shelf |
| Exposure | linked / copy / missing / broken, per runtime | Skills × runtimes matrix with status dots |

A mockup was iterated and approved (Artifact
`https://claude.ai/code/artifact/dd324df4-d7bb-450a-abdb-69dfe7368b1d`,
version `v3-fiche-et-descriptions`). Its locked decisions:

1. **Matrix-first**: rows = skills (name + one-line description + badges),
   columns = enabled runtimes, cells = status dots. Dots are only legible
   inside a matrix — never render status dots outside a column structure.
2. Row click opens a **detail drawer**: full description, exposure spelled out
   in words with real paths and per-state actions, and (final slice) an inline
   `SKILL.md` editor that writes only to the source repo.
3. Unmanaged entries are a **"To consolidate" backlog** (collapsed, grouped by
   runtime with copy/symlink counts), not noise and not a flat list.
4. Disabled skills stay listed (toggle off, struck-through name, collapsed
   shelf) — disabling must never require moving files by hand.
5. The Projects tab reuses the **same matrix language**, one card per
   configured project.
6. Health strip = four separately meaningful numbers (healthy links X/Y, to
   repair, to consolidate, disabled) — never a single merged "needs attention"
   count.

Target layout (Global tab):

```text
┌────────────────────────────────────────────────────────────┐
│ Skill management                    [Global|Projects] [◐]  │
├────────────────────────────────────────────────────────────┤
│ Healthy links 16/20 │ To repair 2 │ To consolidate 159 │ Disabled 1 │
├────────────────────────────────────────────────────────────┤
│ Managed skills — exposure per runtime   [Preview][Reconcile all] │
│ [All 7][Auto 6][Manual 1] | [search…]                      │
│  Skill (toggle+name+desc+badges) │Claude│Codex│Agents│OpenCode│
│  pr-review  "Review a Git…"      │  ●   │  ●  │  ●   │  ●   │
│  …                                                         │
│ Legend: ● linked ○ not linked ⊘ broken/wrong — disabled    │
├────────────────────────────────────────────────────────────┤
│ ▸ To consolidate (159) — grouped per runtime, collapsed    │
│ ▸ Disabled (1)            ▸ Configuration & runtimes       │
└────────────────────────────────────────────────────────────┘
```

## Current state

### Route and page model

- `apps/web/src/routes/skills.tsx` (901 lines) renders, in order: `ConfigPanel`
  (first!), 5 summary tiles, `SkillsTable` (7 columns, no descriptions),
  `UnmanagedTable` (flat, unbounded), `ActionsPanel`, `TargetsTable`,
  `DiagnosticsPanel`, `NativeRulesPanel` (placeholder that ignores
  `snapshot.nativeRuleFindings`).
- `apps/web/src/skills-page-model.ts` exports `buildSkillSummaryTiles`,
  `projectionStateLabel`, `skillProjectionSummary`, `canReconcileAllActiveSkills`,
  `canReconcileSkill`.

```ts
apps/web/src/skills-page-model.ts:72
export const canReconcileAllActiveSkills = (snapshot: SkillManagementSnapshot): boolean =>
  snapshot.unmanagedEntries.length === 0 &&
  !snapshot.projections.some((projection) => unsafeReconcileStates.has(projection.state));
```

### Workflow semantics (the one behavioral bug)

```ts
packages/skills/src/index.ts:1409
  if (actions.some((action) => action.type === 'refuse-unmanaged-mutation')) {
    return { actions, snapshot };
  }
  for (const action of actions) {
    await applyProjectionAction(action);
  }
```

One refused action prevents applying all safe actions, for both
`reconcileSkill` and `reconcileAllActiveSkills`.

### Data already available (no backend needed for Steps 4–6)

`SkillManagementSnapshot` already carries everything the matrix and the
read-only drawer need:

- `skills: SourceSkill[]` — `name`, **`description`**, `enabled`,
  `validationStatus`, `tokenCount`, `manifest.fields` (includes the
  `disable-model-invocation` known extension → invocation axis), `diagnostics`.
- `projections: Projection[]` — one row per skill×target with `state`,
  `expectedPath`, `actualPath`, `targetId`.
- `targets: SkillTarget[]` — `id`, `label`, `enabled`, `missing`, `path`,
  `scope: 'system' | 'project'`.
- `unmanagedEntries: Projection[]` — with `targetId` + `state`
  (`unmanaged-copy` | `unmanaged-symlink`), groupable client-side.

### Server functions (envelope pattern to preserve)

`apps/web/src/server/skills.ts` exposes thin facades (validators from
`@ai-usage/skills`, implementation in `skills.server.ts`, results wrapped as
`{ ok: true, data } | { ok: false, error: { message, tag } }`):
`getSkillManagementSnapshot`, `getKnownSkillProjectPaths`,
`saveSkillManagementConfig`, `toggleManagedSkill`, `reconcileManagedSkill`,
`reconcileAllManagedSkills`, `createManagedSkillTargetDirectory`.

### Design system

- `packages/design-system/src/preset.ts` has **no semantic status colors** —
  only the copper accent, `chart.c1..c6`, and `harness.*` badge pairs.
- `packages/design-system/src/report.ts` re-exports component modules the
  current skills route does not use yet:
  - `metric-tile.tsx`: `MetricTile`, `metricGrid`, `metricTile`, `metricLabel`, `metricValue`
  - `tabs.tsx`: `Tabs`, `TabItem`, `tabsRoot`, `tabsList`, `tabTrigger`
  - `drawer.tsx`: `drawer`, `drawerTop`, `drawerBody`, `drawerTitle`, `drawerPosition` (+ `drawerClose` in `button.ts`)
  - `badge.tsx`: `HarnessBadge`, `badgeToneFor`, `harnessFamily`
  - `segment-bar.tsx`: `SegmentBar`, `BarSegment`
  - `field.ts`: `searchInput`; `button.ts`: `activeFilterButton`, `filterTextButton`
  - `empty-state.ts`: `empty`, `emptyPanel`
- `styled-system/` is gitignored; regenerate with
  `bun run --cwd packages/design-system build` (panda codegen + cssgen + ship + tsc).

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `bun install` | exit 0 |
| Regenerate design tokens | `bun run --cwd packages/design-system build` | exit 0 |
| Package tests | `bun test packages/skills/src` | exit 0 |
| Web model/server tests | `bun test apps/web/src/skills-page-model.test.ts apps/web/src/server/skills.server.test.ts` | exit 0 |
| All web tests (no concurrent build) | `bun test apps/web/src` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Format | `bun run fix` | exit 0 |
| Full build | `bun run build` | exit 0 |
| Visual check | `bun run dev` then open `http://127.0.0.1:3000/skills` | page renders |

Note (from plan 001 log): do not run `bun test apps/web/src` concurrently with
`bun run build` — they race on `.output`.

## Vocabulary rule (repo-wide, from plan 001)

In UI copy, docs, and identifiers: skill consumers are **"runtimes"** (or
"agent runtimes"), never "harnesses" — "Harness" is reserved for usage-report
collectors (`CONTEXT.md`). The design-system component `HarnessBadge` keeps its
name (it belongs to the report side); reusing it for runtime chips is fine.

## UI copy (English, exact strings)

| Element | Copy |
| --- | --- |
| Health tiles | `Healthy links` (value `16/20`), `To repair`, `To consolidate`, `Disabled` |
| Matrix panel title | `Managed skills — exposure per runtime` |
| Matrix legend | `Linked` · `Not linked` · `Broken / wrong target` · `Copy (not a link)` · `Disabled` |
| Filters | `All` · `Auto` · `Manual` · search placeholder `Filter skills…` |
| Buttons | `Reconcile all`, `Reconcile`, `Enable`, `Disable`, `Create directory`, `Save` |
| Folds | `To consolidate`, `Disabled`, `Configuration & runtimes`, `Add a project` |
| Consolidate intro | `These skills live directly in runtime folders, outside your source repository. Adopting them means moving them into the source repo and symlinking back. Nothing is ever deleted automatically.` |
| Drawer sections | `Exposure`, `SKILL.MD`, `Diagnostics` |
| Drawer states | `Linked`, `Not linked`, `Wrong target`, `Broken link`, `Disabled` |
| Editor note | `Writes to the source repository only — never into runtime folders.` |
| Tabs | `Global`, `Projects` |

## Health bucket definitions (exact)

Let `countableSkills = skills.filter(s => s.enabled && s.validationStatus !== 'invalid')`
and `activeTargets = targets.filter(t => t.enabled)`. A **countable pair** is
(countable skill × active target). Then:

| Bucket | Definition |
| --- | --- |
| `expectedLinkCount` | `countableSkills.length × activeTargets.length` |
| `healthyLinkCount` | countable pairs with projection state `linked` |
| `toLinkCount` | countable pairs with state `missing` |
| `toRepairCount` | countable pairs with state in `{broken-link, wrong-target, missing-target}` |
| `blockedCount` | countable pairs with state in `{unmanaged-copy, unmanaged-symlink, duplicate-name-conflict, duplicate-same-content}` (expected path occupied by unmanaged content — shown as blocked, excluded from reconcile) |
| `attentionCount` | `toRepairCount + toLinkCount + blockedCount +` count of `disabled-exposed` projections (any skill) |
| `consolidateCount` | `snapshot.unmanagedEntries.length` |
| `disabledCount` | `skills.filter(s => !s.enabled).length` |

`To repair` tile shows `toRepairCount`; if `blockedCount > 0`, its sublabel
appends `· N blocked`. Invalid skills stay visible in the matrix (error pill,
excluded from the denominator).

## Scope

**In scope**:

- `packages/design-system/src/preset.ts` (status tokens)
- `packages/design-system/src/components/status.ts` (new) + `report.ts` re-export
- `packages/skills/src/index.ts` (reconcile semantics; project scan; markdown
  read/write; origin metadata) + focused tests beside it
- `apps/web/src/skills-page-model.ts` + test (rewrite)
- `apps/web/src/routes/skills.tsx` (restructure)
- `apps/web/src/skills-matrix.tsx`, `apps/web/src/skills-drawer.tsx`,
  `apps/web/src/skills-health.tsx`, `apps/web/src/skills-consolidate.tsx` (new)
- `apps/web/src/server/skills.ts`, `apps/web/src/server/skills.server.ts`
  (+ test) — new GET/POST facades in Steps 7–8 only
- `docs/skills-management.md`, `docs/future-work.md`
- `plans/README.md`, `plans/002-skills-inventory-ui-log.md`

**Out of scope**:

- The adoption/import flow itself ("Examine" screens that move unmanaged
  skills into the source repo). This plan only groups and counts them.
- Git diff view for the editor (stays in `docs/future-work.md`).
- Editing files other than `SKILL.md` (reference files, scripts).
- Per-target reconcile granularity (row actions call skill-level reconcile).
- Origin auto-detection or registry sync; origin editing UI.
- CLI rendering, LAN/multi-machine anything, usage-report code.
- New Panda recipes beyond the status tokens + one status-pill/dot module.

## Git workflow

- Branch: continue on `skills` (this plan is the UI half of the same feature).
- Commit style: concise imperative subject (`Add status tokens`, `Rework
  skills matrix`). Commit by slice. Run `bun run fix` before committing.
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Record the UI decisions in docs

Append a `## UI design` section to `docs/skills-management.md` stating:

- `/skills` is a multi-axis inventory (the five axes table from "Why this
  matters", condensed).
- Matrix-first presentation; status dots only ever appear inside the matrix.
- Unmanaged entries render as a grouped, collapsed consolidation backlog —
  never as a flat list; adoption flow is future work.
- Disabling a skill is a first-class toggle and never requires manual file
  moves.
- Health is reported as separate counters (healthy/to repair/to consolidate/
  disabled); no merged "needs attention" number.
- UI copy says "runtime(s)" for skill consumers.

Add to `docs/future-work.md`: adoption/import flow for unmanaged entries;
editor git-diff; non-SKILL.md file editing; per-target reconcile.

**Verify**:

```bash
bun run lint
```

Expected: exit 0.

### Step 2: Add semantic status tokens + status primitives to the design system

**Files**: `packages/design-system/src/preset.ts`,
`packages/design-system/src/components/status.ts` (new),
`packages/design-system/src/report.ts`.

In `preset.ts` `semanticTokens.colors`, add a `status` group using the
established `dual(light, dark)` helper (values validated in the mockup on both
schemes):

```ts
status: {
  ok: dual('#2E7D5B', '#5BA97E'),
  okSoft: dual('#E4F0EA', '#14302A'),
  warn: dual('#9A6B10', '#D9AC5A'),
  warnSoft: dual('#F6ECD5', '#35290F'),
  danger: dual('#B3261E', '#E08A80'),
  dangerSoft: dual('#F6E1DD', '#3A1E1B'),
},
```

(`info` reuses existing `muted`/`surfaceMuted` — do not add an info pair.)

Create `components/status.ts` exporting exactly:

- `statusPill` — base pill (inline-flex, h 22px, radius `full`, fontSize 11px,
  fontWeight 650) + tone classes `statusPillOk`, `statusPillWarn`,
  `statusPillDanger`, `statusPillInfo` (color/bg/border from the tokens above;
  info = `muted` on `surfaceMuted` with `line` border).
- `statusDot` — 15px circle + variants `statusDotLinked` (bg `status.ok`),
  `statusDotMissing` (transparent bg, 2px solid `status.warn` border),
  `statusDotBroken` (bg `status.danger`), `statusDotCopy` (2px dotted border,
  `muted`), `statusDotNone` (12×2px bar, bg `faint`).

Re-export from `report.ts` (`export * from './components/status';`).

**Verify**:

```bash
bun run --cwd packages/design-system build
bun run typecheck
bun run lint
```

Expected: all exit 0; `token(colors.status.ok)` resolves in app code.

### Step 3: Fix reconcile semantics — apply safe actions, report refused ones

**Files**: `packages/skills/src/index.ts`,
`packages/skills/src/projection.test.ts` (or `snapshot.test.ts`, wherever
`applyPlannedActions` behavior is covered), `apps/web/src/skills-page-model.ts`
(gate only, full rewrite comes in Step 4).

1. In `applyPlannedActions` (`index.ts:1392`), remove the early return at
   `:1409`. Apply every action whose type is `create-symlink`,
   `repair-symlink`, or `unlink-managed-symlink`; keep `noop` and
   `refuse-unmanaged-mutation` unapplied but **still returned** in `actions`
   so the UI can show what was skipped and why (`reason` field).
2. Do not change `planProjection` or `applyProjectionAction` — per-action
   safety rules stay exactly as they are.
3. Tests to add (fixture: one enabled valid skill missing on target A, another
   skill's expected path occupied by an unmanaged copy on target B):
   - reconcile-all applies the safe `create-symlink` on A **and** returns the
     `refuse-unmanaged-mutation` for B without touching B's content;
   - `reconcileSkill` on a skill with one safe and one refused target applies
     the safe one;
   - existing per-action refusal tests still pass unchanged.

**STOP** if you find a test or doc asserting the all-or-nothing behavior is
intentional — report instead of changing it.

**Verify**:

```bash
bun test packages/skills/src
bun run typecheck
```

Expected: tests pass (including the new mixed-outcome tests).

### Step 4: Rewrite the page model (pure functions + tests)

**Files**: `apps/web/src/skills-page-model.ts`,
`apps/web/src/skills-page-model.test.ts` (both rewritten).

Export exactly:

```ts
export type SkillInvocation = 'auto' | 'manual';
export type MatrixCellState = ProjectionState | 'not-applicable';

export interface SkillMatrixCell {
  targetId: string;
  state: MatrixCellState;   // 'not-applicable' when the skill is disabled
  label: string;            // reuse projectionStateLabel wording
}
export interface SkillMatrixRow {
  name: string;
  description: string;      // '' allowed; UI renders 'No description' fallback
  enabled: boolean;
  invocation: SkillInvocation;
  validationStatus: SkillValidationStatus;
  tokenTotal: number | null;
  tokenFlag: boolean;       // true when the scan emitted a token-threshold diagnostic
  cells: readonly SkillMatrixCell[];  // one per active target, same order as targets
}
export interface SkillMatrix {
  targets: readonly SkillTarget[];    // enabled targets only, stable order
  rows: readonly SkillMatrixRow[];    // enabled skills first, then disabled
}
export const buildSkillMatrix: (snapshot: SkillManagementSnapshot) => SkillMatrix;

export interface SkillHealthSummary {
  expectedLinkCount: number; healthyLinkCount: number;
  toLinkCount: number; toRepairCount: number; blockedCount: number;
  consolidateCount: number; disabledCount: number;
}
export const buildSkillHealthSummary: (snapshot: SkillManagementSnapshot) => SkillHealthSummary;
// exact bucket definitions: see "Health bucket definitions" table above

export const skillInvocation: (skill: SourceSkill) => SkillInvocation;
// 'manual' iff manifest.fields contains key 'disable-model-invocation' with value === true

export interface UnmanagedGroup {
  targetId: string; targetLabel: string; targetPath: string;
  total: number; copies: number; symlinks: number;
}
export const groupUnmanagedEntries: (snapshot: SkillManagementSnapshot) => readonly UnmanagedGroup[];
// group snapshot.unmanagedEntries by targetId; copies = state 'unmanaged-copy',
// symlinks = state 'unmanaged-symlink'; resolve label/path from snapshot.targets

export interface SkillRowFilter { invocation?: SkillInvocation; query?: string }
export const filterMatrixRows: (rows: readonly SkillMatrixRow[], filter: SkillRowFilter) => readonly SkillMatrixRow[];
// query matches name OR description, case-insensitive substring

export const canReconcileAll: (snapshot: SkillManagementSnapshot) => boolean;
// true iff ≥1 countable pair is in {missing, broken-link, wrong-target}
// (replaces canReconcileAllActiveSkills — unmanaged entries no longer gate this)

export const projectionStateLabel: (state: ProjectionState) => string; // keep as-is
```

Notes:

- `tokenFlag`: derive from the skill's existing scan diagnostics — find the
  exact diagnostic code with `rg -n "Token" packages/skills/src/index.ts` and
  match on it. Do **not** re-implement threshold math in the web layer.
- Delete `buildSkillSummaryTiles`, `skillProjectionSummary`,
  `canReconcileAllActiveSkills`, `canReconcileSkill` and their tests once
  Step 5 no longer imports them (`canReconcileSkill`'s per-skill blocked rule
  moves into the drawer action logic via cell states).
- Tests: matrix ordering (enabled before disabled), invocation derivation,
  every health bucket against a hand-built snapshot fixture, grouping counts,
  filter behavior (invocation, query on description), `canReconcileAll` true
  with unmanaged entries present + false when everything is linked.

**Verify**:

```bash
bun test apps/web/src/skills-page-model.test.ts
bun run typecheck
```

Expected: exit 0.

### Step 5: Restructure the route — Global view

**Files**: `apps/web/src/routes/skills.tsx` (rewrite),
`apps/web/src/skills-health.tsx`, `apps/web/src/skills-matrix.tsx`,
`apps/web/src/skills-consolidate.tsx` (new).

Page order (configured state): health strip → matrix panel → folds
(`To consolidate`, then a two-column grid with `Disabled` and
`Configuration & runtimes`). The config form moves **inside** the last fold,
collapsed by default; the unconfigured state keeps rendering the existing
`UnconfiguredPanel` + config form expanded (unchanged behavior).

1. **`skills-health.tsx`**: render `SkillHealthSummary` with `metricGrid` +
   `MetricTile` (or `metricTile` classes directly). Tile 1 value
   `` `${healthy}/${expected}` ``, sublabel `N active skills · M runtimes`.
   Value colors: `To repair` → `status.danger` when > 0, `To consolidate` →
   `status.warn` when > 0, else `ink`.
2. **`skills-matrix.tsx`**: table using existing `table` + `tableWrap` classes
   plus a local sticky-first-column class:
   ```ts
   const stickyCol = css({
     position: 'sticky', left: 0, zIndex: 1, bg: 'surface',
     borderRight: '1px solid token(colors.line)',
     minW: '320px', textAlign: 'left',
   });
   ```
   - Column headers: `HarnessBadge` per target label (verify
     `harnessFamily('Claude Code')` maps to the claude tone; if a label does
     not map, pass `target.id` instead — neutral fallback is built in).
   - Row head: enable/disable switch (reuse the checkbox/switch component if
     `components/checkbox` provides one — check its exports first; otherwise a
     small local `role="switch"` button), name (`strongCell`), validation pill
     (`statusPill*` — only when not `valid`), one-line description
     (`color: muted, fontSize 12px, whiteSpace nowrap, overflow hidden,
     textOverflow ellipsis, maxW 400px`, full text in `title`), badge row
     (`Auto`/`Manual`, `N tok` with `status.danger` color when `tokenFlag`).
   - Cells: `statusDot*` mapped from `MatrixCellState`
     (`linked→Linked`, `missing→Missing`, `broken-link|wrong-target|missing-target|duplicate-name-conflict|disabled-exposed→Broken`,
     `unmanaged-*|duplicate-same-content→Copy`, `not-applicable→None`), with
     `title={cell.label}`.
   - Disabled rows: `opacity .5` on cells, line-through on the name, sorted
     last (already handled by the model).
   - Row interactivity: `tabindex=0`, click/Enter calls `props.onOpenSkill(name)`
     (drawer lands in Step 6 — until then the prop can be a no-op); the switch
     stops propagation and calls the existing `toggleSkill`.
   - Filter bar above the table: `activeFilterButton`/`filterTextButton` for
     All/Auto/Manual (+ counts), `searchInput` bound to a signal; both feed
     `filterMatrixRows`.
   - Panel header actions: `Reconcile all` (`commandButton`, disabled by
     `!canReconcileAll(snapshot) || pendingOperation`). After the call, render
     the returned actions summary in the existing operation-message area,
     including refused ones as `skipped: <reason>` lines.
3. **`skills-consolidate.tsx`**: `<details>` fold (collapsed by default)
   styled with `panel`; summary shows `To consolidate` + `statusPillWarn`
   count; body = intro copy (see UI copy table) + one row per
   `UnmanagedGroup`: `HarnessBadge`, `mono` path, `N copies · M symlinks`.
   No per-entry rows, no buttons (adoption is out of scope).
4. **Folds row**: `Disabled` fold lists disabled skills (name, description,
   `Enable` ghost button wired to `toggleSkill(name, true)`);
   `Configuration & runtimes` fold contains the existing `ConfigPanel` plus
   the existing targets list (`TargetsTable` content: label, enabled/observed/
   missing state, `Create directory` button) — both moved, not rewritten.
5. Delete `SkillsTable`, `UnmanagedTable`, `ActionsPanel`, `DiagnosticsPanel`,
   `NativeRulesPanel` from the route. Per-skill diagnostics move into the
   drawer (Step 6); snapshot-level diagnostics (no `skillName`) render as a
   compact list at the bottom of the `Configuration & runtimes` fold.
6. Mobile (base breakpoint): health strip 2×2 (`gridTemplateColumns` base
   `1fr 1fr`), matrix scrolls inside `tableWrap` with the sticky first column,
   search input full-width.

**Verify**:

```bash
bun test apps/web/src
bun run typecheck
bun run lint
bun run build
```

Then visual check on `http://127.0.0.1:3000/skills` (light + dark, 1440px +
390px): page height must stay under ~2,500 px with the operator's real data;
`Reconcile all` must be enabled while unmanaged entries exist.

### Step 6: Skill detail drawer (read-only — no new server functions)

**Files**: `apps/web/src/skills-drawer.tsx` (new),
`apps/web/src/routes/skills.tsx` (wire `onOpenSkill`).

Reuse the design-system drawer primitives (`drawer`, `drawerTop`, `drawerBody`,
`drawerTitle`, `drawerPosition`, `drawerClose`); mirror the existing drawer
usage in the report app (`rg -n "drawerTop" apps/web/src` and copy its
open/close/overlay/Escape pattern rather than inventing one).

Content, top to bottom, all sourced from the already-loaded snapshot:

1. Header: skill name + validation pill; `mono` path
   `<sourceRepoPath>/skills/<name>` (build from `snapshot.config.sourceRepoPath`).
2. Full description paragraph (fallback `No description`).
3. Badge row: `Auto|Manual`, `N tok` (flagged color when `tokenFlag`),
   `Global` scope badge.
4. `Exposure` section: one row per projection of this skill —
   `HarnessBadge(target.label)` + state word colored by bucket
   (`Linked`→`status.ok`, `Not linked`→`status.warn`, `Wrong target`/`Broken
   link`→`status.danger`, else `muted`) + `mono` `expectedPath` (and
   `actualPath` on `wrong-target`) + a `Reconcile` ghost button when the state
   is `missing`, `broken-link`, or `wrong-target` (calls the existing
   skill-level `reconcileManagedSkill`; disable while `pendingOperation`).
5. Enable/disable toggle mirroring the row switch.
6. `Diagnostics` section: this skill's `diagnostics` (severity pill + code +
   message); hidden when empty.

Keyboard: Escape closes; focus moves to the close button on open and returns
to the originating row on close.

**Verify**:

```bash
bun test apps/web/src
bun run typecheck
bun run build
```

Visual check: open a skill with mixed states; every exposure row shows the
state in words + the real path; reconcile from the drawer refreshes both the
drawer and the matrix.

### Step 7: Projects tab (read-only observation)

**Files**: `packages/skills/src/index.ts` + new
`packages/skills/src/project-scan.test.ts`; `apps/web/src/server/skills.ts`,
`apps/web/src/server/skills.server.ts` + `skills.server.test.ts`;
`apps/web/src/routes/skills.tsx` (tabs) + `apps/web/src/skills-projects.tsx` (new).

**Domain** (in `@ai-usage/skills`):

```ts
export const projectSkillDirectories = [
  { id: 'claude-project', label: 'Claude Code', relativePath: '.claude/skills' },
  { id: 'agents-project', label: 'Standard Agents', relativePath: '.agents/skills' },
] as const;

export type ProjectSkillPlacement = 'owned-directory' | 'symlink-to-source' | 'external-symlink';

export interface ProjectSkillObservation {
  name: string; description: string;
  invocation: 'auto' | 'manual';
  validationStatus: SkillValidationStatus;
  placement: ProjectSkillPlacement;
  runtimeDirId: (typeof projectSkillDirectories)[number]['id'];
  path: string; skillMdPath: string;
  tokenCount?: SourceSkill['tokenCount'];
  diagnostics: readonly SkillDiagnostic[];
}

export interface ProjectSkillInventory {
  projectPath: string;
  observations: readonly ProjectSkillObservation[];
  diagnostics: readonly SkillDiagnostic[];
}

export const scanProjectSkills: (input: {
  projectPaths: readonly string[];
  sourceRepoPath?: string;
  options?: SourceSkillScanOptions;
}) => Promise<readonly ProjectSkillInventory[]>;
```

Rules: reuse the existing SKILL.md parser, token counting, ignored-directory
and file/byte limits (do not duplicate them); `placement` =
`symlink-to-source` when the entry is a symlink whose resolved path is inside
`<sourceRepoPath>/skills/`, `external-symlink` for any other symlink,
`owned-directory` otherwise; unreadable projects produce a diagnostic, never a
throw; **read-only** — this function must not import or call any mutation
helper.

Tests (tmp-dir fixtures): owned dir with valid SKILL.md; symlink into the
source repo classified as `symlink-to-source`; foreign symlink; missing
`.claude/skills` dir → empty observations, no diagnostic; invalid SKILL.md →
`validationStatus: 'invalid'` with diagnostics.

**Server**: `getSkillProjectInventories` GET facade →
`readSkillProjectInventoriesForServer()` in `skills.server.ts`: read config,
use `config.skills.projectPaths ?? []`, call `scanProjectSkills`, wrap in the
standard `{ ok, data|error }` envelope. Test: unconfigured → `ok: true` with
`[]`.

**UI**: replace the single view with design-system `Tabs`
(`Global` / `Projects (N)`, N = configured project count). The Projects tab
lazy-loads via `createResource` on first activation. Per project: a `panel`
card (project name = last path segment, `mono` full path) containing the same
matrix table component fed by a small adapter (columns =
`projectSkillDirectories` present in that project; cells from `placement` +
`validationStatus`: `owned-directory`→Linked dot, `symlink-to-source`→Linked
dot with `title="Global skill exposed here"`, `external-symlink`→Copy dot);
a card footer line `+ N global skills exposed here: a, b` (count of
`symlink-to-source` observations). Read-only: no toggles, no action buttons.
`Add a project` fold reuses the existing project-path picker from
`ConfigPanel` (same component, moved — the picker already exists with
`getKnownSkillProjectPaths`).

**Verify**:

```bash
bun test packages/skills/src apps/web/src
bun run typecheck
bun run lint
bun run build
```

Expected: all exit 0; Projects tab renders configured projects; Global tab
unchanged.

### Step 8: SKILL.md preview + editor (final functional slice — deferrable)

This supersedes plan 001's step 10 deferral, **restricted to SKILL.md only**.
If anything here conflicts with the safety rules, defer again and record it in
the log — Steps 1–7 must not depend on this step.

**Files**: `packages/skills/src/index.ts` + `packages/skills/src/skill-markdown-io.test.ts`
(new); `apps/web/src/server/skills.ts`, `skills.server.ts` +
`skills.server.test.ts`; `apps/web/src/skills-drawer.tsx`.

**Domain**:

```ts
export const maxSkillMarkdownBytes = 262_144; // 256 KiB

export interface SkillMarkdownDocument {
  skillName: string; path: string; content: string; sha256: string;
}
export const readSkillMarkdown: (input: { sourceRepoPath: string; skillName: string })
  => Promise<SkillMarkdownDocument>;
export const writeSkillMarkdown: (input: {
  sourceRepoPath: string; skillName: string; content: string; baseSha256: string;
}) => Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'too-large' | 'not-found' }>;
export const parseSkillMarkdownWriteInput: (input: unknown) => SkillMarkdownWriteInput;
```

Safety rules (all mandatory, all tested):

- The path is **always** `join(sourceRepoPath, 'skills', parseSkillName(skillName), 'SKILL.md')`
  — the client never sends a file path.
- After `realpath`, the resolved file must still be inside
  `join(realpath(sourceRepoPath), 'skills')`; otherwise return `not-found`.
- Read: files larger than `maxSkillMarkdownBytes` → `not-found`-style error
  diagnostic (no partial content).
- Write: recompute the current file's sha256 first; mismatch with `baseSha256`
  → `{ ok: false, reason: 'conflict' }` and **no write**. Content larger than
  the cap → `too-large`, no write.
- `parseSkillMarkdownWriteInput` validates: `skillName` via `parseSkillName`,
  `content` is a string within the byte cap, `baseSha256` is a 64-char hex
  string.

**Server**: `getManagedSkillMarkdown` (POST, validator `parseSkillName`) and
`saveManagedSkillMarkdown` (POST, validator `parseSkillMarkdownWriteInput`);
the save handler re-runs the snapshot load after a successful write and
returns `{ document, snapshot }` so the UI refreshes validation/token state in
one round trip. Server tests: invalid name rejected; conflict propagated;
oversized content rejected before any filesystem write.

**UI (drawer `SKILL.MD` section)**: lazy-fetch on drawer open; `mono` `<pre>`
block (maxH ~360px, overflow auto); `Edit` button swaps to a textarea
(`mono`, minH 280px) + save bar (`Save` commandButton, `Cancel` ghostButton,
note copy from the UI copy table). On `conflict`: keep the textarea content,
show `File changed on disk — reload the skill and reapply your edit.` No git
diff button (future work).

**Verify**:

```bash
bun test packages/skills/src apps/web/src
bun run typecheck
bun run lint
bun run build
rg -n "loadSkillDetail|readSkillFile|writeSkillFile" apps packages
```

Expected: tests pass; the `rg` finds no generic file-path editor symbols
(only the SKILL.md-restricted ones above).

### Step 9: Origin metadata (additive, display-only — deferrable)

**Files**: `packages/skills/src/index.ts`,
`packages/skills/src/source-state.test.ts`, `apps/web/src/skills-page-model.ts`
(+ test), `apps/web/src/skills-matrix.tsx`, `apps/web/src/skills-drawer.tsx`.

- Extend `SkillSourceState` with `skillOriginByName?: Record<string, string>`
  (keep `version: 1`; the field is optional and additive). Parser: accept only
  string values, drop non-string entries with a `warning` diagnostic; writer
  preserves the field verbatim; `toggleSkillEnabled` round-trips it untouched.
- Surface as `origin: string | null` on `SkillMatrixRow` (and the drawer badge
  row). Recognized values `personal`, `github`, `skills.sh` get the styled
  badge tones from the mockup (`personal`→neutral, `github`→ink,
  `skills.sh`→opencode-blue); any other string renders in the neutral badge.
- Add an origin filter group to the matrix filter bar **only when at least one
  skill has an origin** (hidden otherwise).
- No editing UI — values are hand-edited in
  `<sourceRepoPath>/.skill-tracker/state.json` for now (document this in
  `docs/skills-management.md`).

**Verify**:

```bash
bun test packages/skills/src apps/web/src/skills-page-model.test.ts
bun run typecheck
```

Expected: state round-trip preserves origins; invalid entries dropped with a
diagnostic.

### Step 10: Final verification and bookkeeping

```bash
bun run fix
bun run test
bun run typecheck
bun run lint
bun run build
git status --short
```

Expected: all exit 0; only in-scope files changed. Update the plan 002 row in
`plans/README.md` to DONE and finish `plans/002-skills-inventory-ui-log.md`.
Visual sign-off checklist (operator's real data, light + dark, 1440px + 390px):

- [x] Page height < ~2,500 px on desktop; actions reachable on mobile.
- [x] Every skill row shows name **and** description.
- [x] Matrix dots match the legend; disabled skills struck through, last.
- [x] `Reconcile all` enabled with 159 unmanaged entries present; result
      message lists applied and skipped actions.
- [x] `To consolidate` fold shows grouped per-runtime counts, collapsed by
      default.
- [x] Drawer: full description, worded exposure with paths, working toggle and
      reconcile; SKILL.md editor saves and surfaces conflicts (if Step 8 ran).
- [x] Projects tab renders configured projects with the same matrix language.

## Test plan (summary)

- `packages/skills/src`: mixed-outcome reconcile (Step 3), project scan
  classification + limits (Step 7), markdown IO safety — containment, cap,
  sha conflict (Step 8), origin state round-trip (Step 9).
- `apps/web/src/skills-page-model.test.ts`: matrix building/ordering,
  invocation, every health bucket, unmanaged grouping, filters,
  `canReconcileAll` (Step 4, extended in Step 9).
- `apps/web/src/server/skills.server.test.ts`: existing validator tests stay
  green; new facades reject invalid input before workflow calls (Steps 7–8).
- No component snapshot tests (repo has none for TSX); UI verified via build +
  the visual checklist.

## Done criteria

All must hold:

- [x] Status tokens exist in the design system; severity is color-coded via
      `statusPill*`/`statusDot*` only (no ad-hoc hex in app code).
- [x] `reconcileSkill`/`reconcileAllActiveSkills` apply safe actions and
      report refused ones; UI gate no longer requires zero unmanaged entries.
- [x] `/skills` Global tab = health strip → skills×runtimes matrix (with
      descriptions) → collapsed folds; no flat unmanaged list anywhere.
- [x] Row click opens the detail drawer with worded per-runtime exposure.
- [x] Projects tab observes configured projects read-only with the same
      matrix language.
- [x] If Step 8 ran: SKILL.md editing is confined to
      `<sourceRepoPath>/skills/<name>/SKILL.md` with sha-conflict protection.
- [x] `bun run test` / `typecheck` / `lint` / `build` all exit 0.
- [x] `plans/README.md` row updated; log file complete.

## STOP conditions

Stop and report back if:

- The drift check shows the snapshot shape, server envelope, or reconcile
  workflow changed since `0b9a428`.
- Any evidence appears that the all-or-nothing reconcile behavior was an
  intentional, documented safety decision (Step 3).
- Making the matrix or drawer work seems to require new mutation semantics
  beyond Step 3 (e.g. per-target reconcile) — defer the feature instead.
- Step 8 would require accepting a client-supplied file path, editing outside
  `<sourceRepoPath>/skills/<name>/SKILL.md`, or editing through a symlinked
  SKILL.md that resolves outside the source repo.
- Project scanning starts inferring project paths from anything other than
  explicit `skills.projectPaths` config (no `~/Projects` defaults, no synced
  machine data — plan 001 rules stay in force).
- Existing report dashboard, sync, usage-store, or snapshot tests fail for
  reasons unrelated to this plan.

## Maintenance notes

- Status dots must never appear outside a matrix column structure (operator
  feedback 2026-07-02: unlabeled pictogram clusters are illegible).
- Keep "runtime(s)" in all skill-consumer copy; "harness" stays reserved for
  usage collectors.
- The `status.*` tokens are the only sanctioned severity colors; extend them
  in the design system, never inline in app code.
- The consolidation backlog is expected to be large on real machines — any
  future "Examine/adopt" flow must paginate or group, never flat-list.
- Revisit `projectSkillDirectories` when a runtime adds/changes its
  project-level skill folder convention.
