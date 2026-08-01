# Plan 060: Add Local Search to Long Breakdown Lists

> Search only the active rendered list and keep global session query `q`
> untouched. Update plan 060 in `plans/README.md`.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- apps/web/src/group-panel.tsx apps/web/src/group-panel-presentation.ts apps/web/src/dashboard.tsx`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 054
- **Category**: direction
- **Planned at**: commit `f4f9650`, 2026-07-28

## Contract

Add a local, non-URL search input inside `GroupPanel` with placeholder
“Search this breakdown”. Match label case-insensitively with trimmed Unicode
text. Filtering occurs before the plan-054 sort. Empty query shows all rows;
zero matches says “No breakdown rows match this search”. Changing tabs resets
the local query because each mounted panel owns its own state.

## Scope

- `apps/web/src/group-panel.tsx`
- `apps/web/src/group-panel-presentation.ts`
- `apps/web/src/group-panel-presentation.test.ts`
- `apps/web/src/group-panel.render.test.tsx`
- `apps/web/src/css-bundle.test.ts` (exact 334-byte breakdown-search allowance only)

No global `q`, URL, server, Projects, Cursor, fuzzy matching, or pagination.

## Steps

### Step 1: Add pure matching before sorting

Test whitespace, case, Unicode, no matches, and sort composition.

**Verify**: `bun test apps/web/src/group-panel-presentation.test.ts` → all pass.

### Step 2: Render the labelled input and empty state

Use a visible label or `aria-label="Search this breakdown"`; `/` shortcut must
continue to focus global session search, not this input.

**Verify**: `bun test apps/web/src/group-panel.render.test.tsx` → all pass.

### Step 3: Run gates

**Verify**: `bun run typecheck && bun run check && bun run test && git diff --check`
→ all pass.

## STOP conditions

- Search needs server-side filtering or pagination.
- The component cannot keep global and local query semantics distinct.
