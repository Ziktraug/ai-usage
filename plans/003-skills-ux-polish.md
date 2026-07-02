# Plan 003: Skills UX Polish — Fix the `/skills` Presentation Defects

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. This plan is presentational: it must not change reconcile/mutation
> semantics in `packages/skills`.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat ac3beb2..HEAD -- apps/web/src packages/design-system plans
> ```
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" line references against the live code before proceeding.
> Line numbers cite commit `ac3beb2`.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (mostly presentational; the design-system styles touched
  in Step 1 are shared with the report and sync pages)
- **Depends on**: Plan 002 (DONE)
- **Category**: UX / polish
- **Planned at**: commit `ac3beb2`, 2026-07-02
- **Source**: UI/UX review of the running page (Chrome headless, desktop
  1440×900 + mobile 390×844, dark + light, all interactive states). Annotated
  report with screenshots:
  `https://claude.ai/code/artifact/391aa093-4a62-43ff-8377-ddf85bf4302a`
- **Log file**: create `plans/003-skills-ux-polish-log.md` on start, one slice
  entry per step (same format as `plans/002-skills-inventory-ui-log.md`).

## Why this matters

Plan 002's structure is right (matrix-first, drawer, consolidation backlog,
preview-first reconcile). What remains are surface defects, several visible
within seconds of opening the page, measured on the operator's real data
(2 managed skills, 147 unmanaged entries, 4 enabled + 2 disabled runtimes):

- The panel's primary button **"Reconcile all…" renders in the middle of the
  panel** (computed `display: grid` won over the intended flex header;
  measured button rect x≈258 instead of top-right).
- The **skill name is ellipsized** ("recent-work-…" at 1440 px, "re…" at
  390 px) while each of the 4 runtime columns spends ~254 px on a 15 px dot.
- The health tile row **doesn't add up for the reader**: "To repair **2** —
  0 to link · 5 blocked" mixes three buckets; the 1+0+2+5=8 decomposition is
  visible nowhere; "blocked" appears only here and is never explained.
- "**To consolidate (147)**" is a dead end: no way to see which skills, no
  copies-vs-symlinks split (it is 8 copies + 139 symlinks — very different
  urgencies), and the promised adoption has no affordance.
- Operation feedback is a raw action dump (`Enabled pr-review:\nlink:
  pr-review → codex.`), rendered in two places, with no tone and no expiry,
  while every button on the page freezes with no local pending indicator.
- Assorted: "1 copies", three different runtime-count phrasings (4 vs 6),
  linked/broken dots distinguishable only by red-green hue, clickable `<tr>`
  without button semantics, config "Add" that persists nothing until an
  unrelated "Save" is clicked.

Operator direction (see `.claude` memories `ai-usage-dashboard-presentation`,
`skills-feature-usecase`): hierarchize rather than drown, and treat unmanaged
entries as a consolidation backlog — the 147 must become inspectable, not
scarier.

## Locked decisions (do not re-litigate)

1. Matrix-first layout, drawer, folds, and preview-first reconcile stay as
   shipped by plan 002.
2. The **"Adopt into source" action is out of scope** for this plan — it is a
   mutation feature (move + symlink) deserving its own plan (004 candidate)
   with the same preview-first pattern as reconcile. This plan only makes the
   backlog inspectable.
3. No global "data quality" rollup: each tile keeps its own provenance and
   becomes a navigation entry into the matrix.
4. `panelHeader` in the design system is used by the report and sync pages —
   Step 1 adds a new export instead of changing its `display`.

## Steps

### Step 1 — Fix the panel-header display conflict (finding 1)

- **Files**: `packages/design-system/src/components/panel.ts`,
  `apps/web/src/skills-matrix.tsx`
- **Current state**: `skills-matrix.tsx:353` applies
  `cx(panelHeader, headerRow)`; `panelHeader` sets `display: grid`
  (`panel.ts:15`), the local `headerRow` (`skills-matrix.tsx:40`) sets
  `display: flex`. Two Panda atomic classes fighting over one property —
  stylesheet order wins, not `cx` order. Verified computed value: `grid`.
- **Change**: export a `panelHeaderRow` from the design system (flex,
  `justify-content: space-between`, wrap, gap, aligned baseline) and use it in
  the matrix header; delete the local `headerRow`. Then audit the page's other
  stacked-`css()` pairs for same-property conflicts (`cx(panel, fold)` and
  `cx(headerTop, headerWrap)` are safe today — `fold`/`headerWrap` only touch
  properties their base doesn't — but note the audit result in the log).
- **Verify**:
  ```bash
  bun run --cwd apps/web dev:standalone & sleep 8
  google-chrome-stable --headless=new --screenshot=/tmp/skills-step1.png \
    --window-size=1440,1200 --virtual-time-budget=15000 http://127.0.0.1:3000/skills
  ```
  "Reconcile all…" sits top-right of the matrix panel header, on the same row
  as the title. Report (`/`) and sync (`/sync`) pages render unchanged.

### Step 2 — Skill name legibility, pluralization, count wording (findings 2, 4, 14)

- **Files**: `apps/web/src/skills-matrix.tsx`, `apps/web/src/skills-consolidate.tsx`,
  `apps/web/src/routes/skills.tsx`, (new) small `count(n, singular, plural?)`
  helper in `apps/web/src/skills-page-model.ts`
- **Current state**: `skillName` is `nowrap` + ellipsis
  (`skills-matrix.tsx:130-134`); "1 copies · 29 symlinks" hardcoded plural
  (`skills-consolidate.tsx:68`); runtime counts appear as "4 enabled runtimes"
  (`skills-matrix.tsx:356`), "6 runtimes" (`skills.tsx:784`), "6 configured
  runtime targets" (`skills.tsx:958`).
- **Change**: let the name wrap to 2 lines (`-webkit-line-clamp: 2` pattern),
  keep single-line ellipsis for the description only; route every displayed
  count through the plural helper; unify runtime copy to one phrasing —
  "4 enabled / 6 configured" — in all three spots.
- **Verify**: `bun test apps/web/src` passes; screenshot shows
  "recent-work-context" fully readable at 1440 px; the consolidate fold shows
  "1 copy · 29 symlinks".

### Step 3 — Make the health tiles add up (findings 3, and 5's counting half)

- **Files**: `apps/web/src/skills-health.tsx`,
  `apps/web/src/skills-page-model.ts` (`buildSkillHealthSummary`,
  `groupUnmanagedEntries` already expose everything needed)
- **Current state**: "To repair" tile value is `toRepairCount` but its
  sublabel concatenates the *other* buckets (`skills-health.tsx:31-34,43-48`);
  "To consolidate" shows the undifferentiated 147.
- **Change**: render the 8-link decomposition explicitly — a compact segmented
  bar (design system `segment-bar.tsx` exists) or four self-consistent tiles:
  value and sublabel must describe the same bucket. "Blocked" gets a plain
  sublabel ("copies in place of links"). "To consolidate" becomes
  "8 copies · 139 symlinks" (sum stays available as the tile value or title).
- **Verify**: with the current machine data the tiles read: linked 1, to link
  0, broken 2, blocked 5, consolidate 8 copies · 139 symlinks, disabled 0 —
  and every number matches what the matrix + consolidate fold show.

### Step 4 — Tiles navigate, matrix filters by state (finding 6)

- **Files**: `apps/web/src/skills-page-model.ts` (`SkillRowFilter`,
  `filterMatrixRows`), `apps/web/src/skills-matrix.tsx`,
  `apps/web/src/skills-health.tsx`, `apps/web/src/routes/skills.tsx`
- **Current state**: filter bar filters invocation/origin/query only
  (`skills-matrix.tsx:401-424`); tiles are static `div`s.
- **Change**: add a cell-state filter (`broken | blocked | not-linked`) that
  keeps rows having ≥1 matching cell; add the corresponding filter buttons;
  make each non-zero tile a button that applies its filter (state lifts to the
  route component so tiles can reach it). Zero tiles stay inert.
- **Verify**: unit tests for `filterMatrixRows` state predicate; clicking
  "To repair" shows only `recent-work-context`; clicking the active filter
  again clears it.

### Step 5 — Consolidate drill-down (finding 5, presentation half)

- **Files**: `apps/web/src/skills-consolidate.tsx`,
  `apps/web/src/skills-page-model.ts` (`groupUnmanagedEntries` gains the
  per-entry list: name + state per group)
- **Current state**: groups render one summary line per runtime
  (`skills-consolidate.tsx:63-71`); `snapshot.unmanagedEntries` already
  carries `skillName`/name + state per entry (`skills-page-model.ts:185-201`
  aggregates it away).
- **Change**: each runtime group becomes expandable (nested `<details>`)
  listing entry names with a copy/symlink badge, copies first. Keep the
  reassurance copy. No actions yet (locked decision 2).
- **Verify**: expanding Claude Code lists its 39 entries with 2 marked
  `copy`; total badge still equals the sum of groups; page height with all
  folds closed is unchanged.

### Step 6 — One operation-feedback channel with tone (finding 7)

- **Files**: `apps/web/src/routes/skills.tsx` (owner of
  `operationMessage`), `apps/web/src/skills-matrix.tsx:535` and
  `skills.tsx:920` (current duplicate renderings), design system (new small
  `banner` recipe or reuse `statusPill` tones)
- **Current state**: same `operationMessage` string rendered in the matrix
  panel and in every `ConfigPanel` instance; success and failure look
  identical; wording is the raw `actionSummary` dump; `pendingOperation`
  disables every button with no local indicator.
- **Change**: single dismissible banner directly under the tabs with
  ok/error tone (derive from the result), human phrasing ("pr-review linked to
  Codex", "Nothing to change"); keep the detailed action list only inside the
  reconcile plan panel where it belongs. Add `aria-busy` + a subtle spinner on
  the control whose operation is pending (the `pendingOperation` string
  already encodes it: `toggle:<name>`, `reconcile:<name>`, …); other controls
  stay disabled as today.
- **Verify**: toggling a skill shows one green banner (and none inside the
  config fold); a failed server call shows the error tone; the toggled switch
  shows the pending state while in flight.

### Step 7 — Interaction semantics & a11y (findings 8, 10, 15)

- **Files**: `packages/design-system/src/components/status.ts`,
  `apps/web/src/skills-matrix.tsx`
- **Current state**: `statusDotLinked`/`statusDotBroken` are both filled
  circles differing only by hue (`status.ts:50-60`) — indistinguishable with
  red-green color blindness; rows are `<tr tabIndex=0>` with click + Enter
  only (`skills-matrix.tsx:442-451`), no role, no Space; zero-count filter
  buttons are clickable into an empty table whose "No skills match" message
  renders *below* the legend (`skills-matrix.tsx:536-538`).
- **Change**: give the two filled dots a glyph (✓ / !) or distinct shape so
  state survives grayscale — update the legend accordingly; make the skill
  *name* the opening control (a real `<button>` styled as today's strong
  cell), drop the row `tabIndex`/handlers, keep whole-row hover as a visual
  affordance only; disable zero-count filter buttons; move the empty-state
  message into the table body (`<td colspan>`), above the legend.
- **Verify**: keyboard-only pass — Tab reaches toggle then name button, Space
  and Enter both open the drawer, focus returns to the name button on close
  (the drawer's `finalFocusEl` already supports this); grayscale screenshot
  (`--force-color-profile=generic-rgb` or desaturate) keeps linked vs broken
  distinguishable.

### Step 8 — Config persistence honesty + Projects empty state (findings 9, 13)

- **Files**: `apps/web/src/routes/skills.tsx` (`ConfigPanel`, `ProjectsTab`,
  `addProjectPath` at `skills.tsx:330`)
- **Current state**: "Add" mutates local state only; persistence happens via
  the "Save" button visually attached to the Source repository field
  (`skills.tsx:849-856`); leaving the tab silently drops edits. The Projects
  tab's "Add a project" fold embeds the whole `ConfigPanel` including Source
  repository (`skills.tsx:701-721`); the empty tab is a bare "No configured
  projects." line.
- **Change**: persist on add/remove (each calls the existing
  `saveSkillManagementConfig` through `runOperation`; drop the local-draft
  divergence entirely) — Save remains only for the source-repo field, labeled
  "Save source"; the Projects fold gets a project-picker-only variant of the
  panel (select + manual path + add), no Source repository; the empty state
  explains the value in one line ("Track skills owned by each project —
  `.claude/skills` and `.agents/skills` — alongside the global inventory")
  with the picker open by default when zero projects are configured.
- **Verify**: add a path → reload the page → the path is still there without
  ever clicking Save; the Projects tab never shows the Source repository
  field; `bun test apps/web/src` passes.

### Step 9 — Drawer refinements (finding 12)

- **Files**: `apps/web/src/skills-drawer.tsx`
- **Current state**: close button content is the letter "x"
  (`skills-drawer.tsx:261`); "Disable" is a grid-stretched full-width button
  right under the description (`:279-286`); "Actual:" renders whenever
  `actualPath !== expectedPath` (`:302-304`), which is *always* true for a
  healthy symlink, so the linked state carries a redundant path line
  (plan 002's log fixed `Actual:` rendering — this narrows *when*, not
  *whether*); unmanaged-copy rows offer no action and no explanation.
- **Change**: use a proper × glyph/SVG with the existing aria-label; make
  Enable/Disable content-width, aligned with the badge row; show "Actual:"
  only for divergent states (`wrong-target`, `unmanaged-symlink`,
  `unmanaged-copy` when resolvable); add one muted line under blocked
  exposures: "Unmanaged copy — reconcile will never overwrite it. Adopt or
  remove it manually." (adoption itself stays plan 004).
- **Verify**: drawer for `pr-review` — Codex/Linked shows a single path,
  the three Unmanaged copy rows each show the explanation line; Escape and ×
  both close with focus returned.

### Step 10 (deferrable) — Small-screen matrix cards, light-mode contrast, tile-row balance (findings 11, 17, 18)

- **Files**: `apps/web/src/skills-matrix.tsx`, design-system button/pill
  tokens, `packages/design-system/src/components/metric-tile.tsx`
- **Current state**: `matrixTable` `minW: 860px` + `stickyCol` `minW: 320px`
  (`skills-matrix.tsx:62,72`) leave ~150 px of runtime columns visible at
  390 px; light mode renders nav chips and "Reconcile all…" as mid-grey
  chips that read as disabled; the four tiles leave a ~600 px hole at
  1440 px.
- **Change**: cap runtime columns (~120-140 px) so the skill column absorbs
  the width at desktop; below ~640 px render per-skill cards (name,
  description, toggle, four labeled dots) instead of the table; run a WCAG AA
  contrast pass on light-mode buttons/pills; widen the tile `minmax` so four
  tiles fill the row.
- **Verify**: 390 px screenshot shows full skill names and all four runtime
  states without horizontal scroll; axe or manual contrast check on light
  mode passes AA for button text.

## Findings → steps mapping

Review findings (artifact numbering) → plan steps: 1→S1, 2→S2, 3→S3, 4→S2,
5→S3+S5 (adopt action deferred to plan 004), 6→S4, 7→S6, 8→S7, 9→S8, 10→S7,
11→S10, 12→S9, 13→S8, 14→S2, 15→S7, 16→ dropped (cosmetic path shortening —
revisit only if paths keep causing wraps after S9), 17→S10, 18→S10.

## STOP conditions

- Any step requires changing mutation behavior in `packages/skills`
  (projection planning, reconcile guards, adoption) — that is plan 004
  territory.
- Step 1's design-system change visibly alters the report (`/`) or sync
  (`/sync`) pages.
- Snapshot/server-function envelope shapes need to change to feed the UI
  (everything this plan displays is already in `SkillManagementSnapshot`).
- A verification screenshot contradicts the expected result and the cause
  isn't obvious within the step's files.

## Done criteria

- All Step 1-9 verifications pass (`bun test apps/web/src`,
  `bun run typecheck`, `bun run lint`, plus the listed visual checks).
- Desktop 1440 px: no truncated skill names, button in the header row, tiles
  arithmetically consistent with the matrix, single feedback banner.
- The 147 unmanaged entries are enumerable by name from the UI.
- Keyboard-only drawer round-trip works; linked vs broken survives grayscale.
- `plans/README.md` row 003 updated; log file complete with one entry per
  step, including the Step 1 conflict-audit note.
