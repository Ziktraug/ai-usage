# Plan 054: Add Shareable Breakdown Sorting

> Add one URL-backed sort for Models, Providers, and Harnesses. Do not change
> session sorting or aggregation. Update plan 054 in `plans/README.md`.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- apps/web/src/dashboard-search.ts apps/web/src/dashboard.tsx apps/web/src/group-panel.tsx apps/web/src/group-panel-presentation.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `f4f9650`, 2026-07-28

## Target contract

Add `breakdownSort: 'value' | 'tokens' | 'sessions'` to `DashboardSearch`, URL
key `breakdownSort`, default `value` omitted from URLs. Sorting is stable and
non-mutating:

- value: cost, then fresh tokens, then label;
- tokens: fresh tokens, then cost, then label;
- sessions: session count, then fresh tokens, then label.

All numeric keys descend and label ascends. Projects, Cursor, and session-table
sort are unchanged.

## Scope

- `apps/web/src/dashboard-search.ts`
- `apps/web/src/dashboard-search.test.ts`
- `apps/web/src/dashboard.tsx`
- `apps/web/src/group-panel.tsx`
- `apps/web/src/group-panel-presentation.ts`
- `apps/web/src/group-panel-presentation.test.ts`
- `apps/web/src/group-panel.render.test.tsx`

No server, focused-query, coverage-based, search, or folding changes.

## Steps

### Step 1: Add strict URL parsing

Accept only the three values; invalid input falls back to `value`. Preserve old
URLs and omit the default during serialization.

**Verify**: `bun test apps/web/src/dashboard-search.test.ts` → round trips pass.

### Step 2: Add the shared pure sorter

Test all orders, ties, and input immutability.

**Verify**: `bun test apps/web/src/group-panel-presentation.test.ts` → all pass.

### Step 3: Render one segmented control

Render Value / Tokens / Sessions in `GroupPanel`, with accessible group label
“Sort breakdown”, wired to the common URL state for all three panels.

**Verify**: `bun test apps/web/src/group-panel.render.test.tsx` → active state,
keyboard access, and row order pass.

### Step 4: Run gates

**Verify**:
`bun run typecheck && bun run check && bun run lint && bun run test && git diff --check`
→ all pass.

## Done criteria

- [ ] Three panels share one URL sort.
- [ ] Default links are unchanged.
- [ ] Sorting is stable and non-mutating.
- [ ] Only scoped files and `plans/README.md` change.

## STOP conditions

- Sorting needs a server or focused-query change.
- A group lacks a locked sort key.
