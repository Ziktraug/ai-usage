# Plan 056: Explain the Full-Range Comparison Boundary

> Do not invent a synthetic previous all-time period. Make absence explicit and
> keep bounded comparison arithmetic unchanged. Update plan 056 in the index.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- packages/report-core/src/focused-report-query.ts apps/web/src/dashboard-metrics.tsx apps/web/src/dashboard.tsx`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f4f9650`, 2026-07-28

## Locked decision

For `range.mode === 'all'`, keep `previousSummary` null and render exactly:

> No previous period exists before the full recorded range.

For a bounded range with no prior rows, render:

> No sessions exist in the previous period.

Do not derive a same-length interval before the first stored row; it is empty by
construction and would manufacture a meaningless change.

## Scope

- `packages/report-core/src/focused-report-query.ts`
- `packages/report-core/src/focused-report-query.test.ts`
- `apps/web/src/dashboard-metrics.tsx`
- `apps/web/src/dashboard-metrics.test.ts`
- `apps/web/src/dashboard-metrics.render.test.tsx`
- `apps/web/src/dashboard.tsx`

No bounded arithmetic, date control, metric-value, or delta-format changes.

## Steps

### Step 1: Derive an explicit display state

At the web model boundary derive `available`, `full-range`, or `no-prior-data`
from range plus `previousSummary`. Keep the focused payload compatible.

**Verify**:
`bun test apps/web/src/dashboard-metrics.test.ts packages/report-core/src/focused-report-query.test.ts`
→ all three states pass.

### Step 2: Render the locked explanation once

Place it in the metric-grid context; do not repeat it in every tile.

**Verify**: `bun test apps/web/src/dashboard-metrics.render.test.tsx` → the three
states are distinct and existing deltas are unchanged.

### Step 3: Run gates

**Verify**: `bun run typecheck && bun run check && bun run test && git diff --check`
→ all pass.

## Done criteria

- [ ] Full-range and bounded-no-data states have different copy.
- [ ] Existing bounded deltas remain unchanged in tests.
- [ ] No comparison interval is fabricated.

## STOP conditions

- The display cannot know range mode without expanding the focused contract.
- Implementation would change previous-period arithmetic.
