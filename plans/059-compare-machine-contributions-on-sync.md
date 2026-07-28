# Plan 059: Compare Machine Contributions on Sync

> Build comparison only from the existing `UsageMachineFleetItem[]` already
> loaded by `/sync`. Do not add collection or synchronization behavior.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- apps/web/src/routes/sync.tsx apps/web/src/manual-transfer-model.ts packages/report-core/src/focused-report-query.ts`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `f4f9650`, 2026-07-28

## Target surface

Keep existing fleet cards and add a comparison table with one row per machine:
machine label, session count, share of fleet sessions, newest session, freshness,
and whether the machine is current. Order current first, then session count, then
label. Stale rows retain their counts but are marked `Stale · <age>`; unavailable
freshness renders `Freshness unavailable`, never `Fresh`.

## Scope

- `apps/web/src/manual-transfer-model.ts` and tests
- `apps/web/src/routes/sync.tsx`
- a new/existing sync render test

No store schema, import/export protocol, collectors, machine identity, or report
filter round-trip changes.

## Steps

### Step 1: Derive a pure comparison model

Test duplicate labels, current/stale/unavailable states, zero fleet total, stable
ordering, and percentage totals.

**Verify**: `bun test apps/web/src/manual-transfer-model.test.ts` → all pass.

### Step 2: Render semantic comparison

Use a table on desktop and the established responsive summary pattern on mobile.
Reuse freshness wording from fleet cards.

**Verify**: sync render test covers all states and accessible headers.

### Step 3: Run gates

**Verify**:
`bun run check && bun run lint && bun run typecheck && bun run test && bun run test:e2e-demo && git diff --check`
→ all pass.

## STOP conditions

- Per-machine counts are absent from the immutable input.
- The existing `UsageMachineFleetItem` contract no longer contains
  `sessionCount`, `newestSessionAt`, and freshness timestamps.
