# Plan 002 Implementation Log

## Slice Log

### Follow-up: Preview-First Reconcile All (operator request)

- Status: completed
- Goal: "Reconcile all" must not mutate directly; it shows a dry-run plan the user confirms.
- Files touched:
  - `packages/skills/src/index.ts`
  - `packages/skills/src/snapshot.test.ts`
  - `apps/web/src/server/skills.server.ts`
  - `apps/web/src/server/skills.ts`
  - `apps/web/src/skills-page-model.ts`
  - `apps/web/src/skills-page-model.test.ts`
  - `apps/web/src/skills-matrix.tsx`
  - `apps/web/src/routes/skills.tsx`
  - `docs/skills-management.md`
- Decisions:
  - Extracted `planReconcileActions` and added `previewReconcileAllActiveSkills` (plans, never applies). Apply re-plans from a fresh snapshot; per-action workflow guards remain the real mutation protection, so preview/apply drift is safe.
  - New GET facade `previewReconcileAllManagedSkills`; the POST apply facade is unchanged.
  - `describeReconcileActions` in the page model renders the plan as `verb skill @ runtime → path` lines plus skipped reasons.
  - The plan panel renders inside the matrix panel with `Apply N actions` / `Cancel`; any other operation invalidates a pending preview (`runOperation` clears it).
  - Button copy is `Reconcile all…` (ellipsis = review step follows).
- Also fixed while verifying on real data: validation-status semantics were inconsistent — health buckets counted warning skills as countable but `canReconcileAll`, `activeSkillPredicate`, and `planProjection` all required strictly `valid`, so a warning skill with a broken link showed "To repair" with a permanently disabled button. Aligned all three on "only `invalid` is excluded"; warning skills (heavy tokens, unknown frontmatter fields) are projectable.
- Verification: `bun test packages/skills/src` (36 pass, incl. preview-no-mutation and warning-vs-invalid reconcile tests), `bun test apps/web/src` (58 pass), typecheck, lint; Playwright dry-run against real data — preview showed 2 repairs + 5 refusals, Cancel closed the panel, `readlink` confirmed zero filesystem changes.

### Review Pass: Post-Implementation Fixes

- Status: completed
- Goal: verify the implementation against the plan's done criteria on real data and fix the defects found.
- Files touched:
  - `apps/web/src/skills-drawer.tsx`
  - `apps/web/src/skills-matrix.tsx`
  - `apps/web/src/routes/skills.tsx`
  - `plans/002-skills-inventory-ui-log.md`
- Findings fixed:
  - Drawer `Actual:` path never rendered: the keyed `Show` received the boolean of an `&&` chain instead of the path string, and Solid renders booleans as nothing. The `when` now yields the path or `undefined`.
  - Drawer exposure listed disabled runtimes (GitHub Copilot, Cursor) as red `Missing target`; it now filters projections to enabled targets, matching the matrix and health counters.
  - `tableWrap`'s report-tuned `minH: 320px` left a dead band under the short matrix; the matrix wrapper overrides it with `minH: auto`.
  - `/skills` overflowed the 390px viewport by 15px (long title + non-wrapping shared `headerTop`); the route now applies a local `flexWrap: wrap` on `headerTop`.
- Verification (all passed): `bun run test`, `bun run typecheck`, `bun run lint`, plus Playwright checks against the dev server — mobile `scrollWidth` 405→390, desktop page height 9,688→1,062 px, drawer shows the broken symlink's actual path, Reconcile all enabled with 147 unmanaged entries present.

### Slice 1: UI Decisions Docs

- Status: completed
- Goal: record the matrix-first `/skills` UI direction and future-work boundaries.
- Files touched:
  - `docs/skills-management.md`
  - `docs/future-work.md`
  - `plans/README.md`
  - `plans/002-skills-inventory-ui-log.md`
- Decisions:
  - Keep runtime terminology in UI-facing docs.
  - Keep unmanaged adoption, git diff, non-`SKILL.md` editing, and per-target reconcile as future work.
- Problems encountered:
  - None.

Verification:

```bash
bun run lint
```

Result: passed.

### Slice 4: Page Model

- Status: completed
- Goal: replace summary-tile/projection-string helpers with a matrix, health, unmanaged grouping, filtering, and reconcile gate model.
- Files touched:
  - `apps/web/src/skills-page-model.ts`
  - `apps/web/src/skills-page-model.test.ts`
  - `plans/002-skills-inventory-ui-log.md`
- Decisions:
  - Treat token-related scan diagnostics as the existing `SkillFileTooLarge` and `SkillFileLimitExceeded` codes; the package does not currently emit a separate threshold diagnostic.
  - Surface optional origin metadata on matrix rows and hide origin filtering when no origins exist.
- Problems encountered:
  - Typecheck temporarily failed while the old route still imported the removed model functions; this was resolved by the route rewrite.

Verification:

```bash
bun test apps/web/src/skills-page-model.test.ts
bun run typecheck
```

Result: passed after the route slice replaced old imports.

### Slice 5: Global Matrix UI And Drawer

- Status: completed
- Goal: restructure `/skills` around health counters, a skills-by-runtimes matrix, grouped consolidation backlog, disabled/configuration folds, and a detail drawer.
- Files touched:
  - `apps/web/src/routes/skills.tsx`
  - `apps/web/src/skills-health.tsx`
  - `apps/web/src/skills-matrix.tsx`
  - `apps/web/src/skills-consolidate.tsx`
  - `apps/web/src/skills-drawer.tsx`
  - `apps/web/src/server/skills.ts`
  - `apps/web/src/server/skills.server.ts`
  - `apps/web/src/server/skills.server.test.ts`
- Decisions:
  - Keep status dots only in matrix columns.
  - Render unmanaged entries only as grouped runtime counts.
  - Show reconcile skipped actions as `skipped: <reason>` lines in the operation message.
  - Include the SKILL.md-only editor in the drawer using the restricted server functions.
- Problems encountered:
  - Exact optional property types required building filter/server inputs by conditionally adding optional keys.
  - Ultracite required replacing nested ternaries and adding explicit roles to labeled status-dot spans.

Verification:

```bash
bun test apps/web/src/skills-page-model.test.ts apps/web/src/server/skills.server.test.ts
bun test packages/skills/src apps/web/src
bun run typecheck
```

Result: passed.

### Slice 6: Project Inventory, Markdown IO, And Origin Metadata

- Status: completed
- Goal: add read-only project skill scans, SKILL.md read/write safety, and display-only origin state metadata.
- Files touched:
  - `packages/skills/src/index.ts`
  - `packages/skills/src/project-scan.test.ts`
  - `packages/skills/src/skill-markdown-io.test.ts`
  - `packages/skills/src/source-state.test.ts`
  - `apps/web/src/skills-projects.tsx`
  - `apps/web/src/server/skills.ts`
  - `apps/web/src/server/skills.server.ts`
  - `apps/web/src/server/skills.server.test.ts`
- Decisions:
  - Project scans only inspect explicitly configured `skills.projectPaths`.
  - `writeSkillMarkdown` returns conflict, too-large, and not-found reasons without accepting client-supplied paths.
  - Origin metadata remains optional in source state and invalid entries are dropped with warnings.
- Problems encountered:
  - Source-state origin diagnostics needed to omit optional fields entirely when values were undefined.

Verification:

```bash
bun test packages/skills/src
bun test packages/skills/src apps/web/src
bun run typecheck
```

Result: passed.

### Slice 7: Final Verification

- Status: completed
- Goal: run the full plan verification set and update bookkeeping.
- Files touched:
  - `plans/README.md`
  - `plans/002-skills-inventory-ui-log.md`
- Decisions:
  - Leave the pre-existing `apps/web/package.json` dev-script change untouched.
- Problems encountered:
  - None.

Verification:

```bash
bun run fix
bun run test
bun run typecheck
bun run lint
bun run build
```

Result: passed. Build emitted the existing Vite large-chunk warning only.

### Slice 3: Mixed Reconcile Workflow

- Status: completed
- Goal: apply safe planned reconcile actions even when other actions are refused.
- Files touched:
  - `packages/skills/src/index.ts`
  - `packages/skills/src/snapshot.test.ts`
  - `plans/002-skills-inventory-ui-log.md`
- Decisions:
  - Keep refused actions in the returned action list for UI reporting.
  - Keep `planProjection` and `applyProjectionAction` safety rules unchanged.
- Problems encountered:
  - Initial test fixtures used missing target directories; the final fixtures create the runtime directory and leave only the skill entry missing.

Verification:

```bash
bun test packages/skills/src
bun run typecheck
```

Result: passed.

### Slice 2: Status Tokens

- Status: completed
- Goal: add shared severity colors and reusable status dot/pill classes.
- Files touched:
  - `packages/design-system/src/preset.ts`
  - `packages/design-system/src/components/status.ts`
  - `packages/design-system/src/report.ts`
  - `plans/002-skills-inventory-ui-log.md`
- Decisions:
  - Keep informational status styling on existing muted surface tokens.
  - Keep all severity colors inside `status.*` semantic tokens.
- Problems encountered:
  - None.

Verification:

```bash
bun run --cwd packages/design-system build
bun run typecheck
bun run lint
```

Result: passed.
