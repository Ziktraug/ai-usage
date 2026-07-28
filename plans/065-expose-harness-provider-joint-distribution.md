# Plan 065: Expose the Harness–Provider Joint Distribution

> Add the missing joint aggregate before changing navigation. Do not infer
> relationships from separately aggregated totals. Update plan 065 in the index.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- packages/report-core/src/focused-report-query.ts packages/report-core/src/analytics.ts apps/web/src/dashboard.tsx apps/web/src/group-panel.tsx`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: plans 054 and 062
- **Category**: direction
- **Planned at**: commit `f4f9650`, 2026-07-28

## Target contract

Add `groups.harnessProviders`, one row per exact `(harness, provider)` pair,
carrying the same sessions, fresh/cache tokens, price measurement, cost, turns,
and tools semantics as existing analytics groups. Sort harness totals by current
value order and children by session count then provider label. Render one
Breakdown destination “Harnesses & providers”: harness summary rows expand to
their provider children. Preserve URL compatibility by mapping both legacy
`tab=harnesses` and `tab=providers` to the combined destination; do not silently
rewrite copied legacy URLs until the user changes tabs.

## Scope

- `packages/report-core/src/focused-report-query.ts` and tests
- `packages/report-core/src/analytics.ts` and tests if a reusable group helper is needed
- `apps/web/src/dashboard-search.ts` and tests
- `apps/web/src/dashboard.tsx`
- `apps/web/src/group-panel.tsx` and render tests

No provider normalization, collector changes, new provider names, or pricing
semantics.

## Steps

### Step 1: Add and validate joint aggregates

Use a fixture where one harness has two providers and one provider spans two
harnesses. Assert no count or token is lost or duplicated.

**Verify**: `bun test packages/report-core/src/focused-report-query.test.ts` → pass.

### Step 2: Preserve legacy navigation

Test old harness/provider URLs, new selection, and back/forward behavior.

**Verify**: `bun test apps/web/src/dashboard-search.test.ts` → pass.

### Step 3: Render the expandable hierarchy

Use semantic buttons with `aria-expanded`; a child still applies the exact
provider filter and a parent the exact harness filter.

**Verify**: GroupPanel render tests cover totals, expansion, and filter callbacks.

### Step 4: Run gates

**Verify**:
`bun run check && bun run lint && bun run typecheck && bun run test && bun run test:e2e && git diff --check`
→ all pass.

## STOP conditions

- Pair totals cannot reuse existing analytics/provenance semantics.
- Legacy URLs would become ambiguous or select a different filter.
- The hierarchy needs provider-name heuristics.
