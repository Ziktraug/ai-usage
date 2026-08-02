# Plan 057: Make Punchcard Cells Filter the Report

> This plan intentionally extends URL, pure-query, and stored-query contracts.
> Do not fake the filter on the client. Update plan 057 in `plans/README.md`.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- packages/report-core/src/session-query.ts packages/report-core/src/focused-report-query.ts packages/usage-store/src/index.ts apps/web/src/dashboard-search.ts apps/web/src/overview.tsx apps/web/src/dashboard.tsx`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: plan 055
- **Category**: direction
- **Planned at**: commit `f4f9650`, 2026-07-28

## Why this matters

Punchcard is the remaining Overview mark without its intended interaction.
Breakdown rows, Projects, timeline entries, drawer chips, and Session Shape
already work; do not reimplement them.

## Locked contract

Add optional `localTimeCell: { weekday: 0|1|2|3|4|5|6; hour: 0..23 }` to
`SessionQueryFilters`, with Monday-first weekday indexing matching Punchcard.
Rows without `activeTime` do not match an explicit cell. Serialize as
`timeCell=MON-14`; invalid values are discarded. The active pill reads
`Time · Monday 14:00–14:59` and is removable.

## Scope

- `packages/report-core/src/session-query.ts` and tests
- `packages/report-core/src/focused-report-query.ts` and tests
- `packages/usage-store/src/index.ts` and focused query tests
- `packages/report-data/src/session-query-materialization.ts`, `session-query-sqlite.ts`, and parity tests
- `apps/web/src/dashboard-search.ts` and tests
- `apps/web/src/dashboard-filters.tsx`
- `apps/web/src/session-query-client.ts` and tests
- `apps/web/src/overview-model.ts` and tests
- `packages/design-system/src/components/overview.ts`
- `apps/web/src/overview.tsx`
- `apps/web/src/dashboard.tsx`
- `apps/web/src/css-bundle.test.ts`
- `apps/web/e2e/time-range.spec.ts` and `dashboard.spec.ts`

The historical initial-bundle baseline stays frozen. The gate adds only the
measured 625-byte gzip cost of this interaction.

No timezone selector, recurring schedule, campaign, or visualization changes.

## Steps

### Step 1: Define and fingerprint the filter

Test bounds, malformed values, missing timestamps, and Monday/Sunday edges.

**Verify**:
`bun test packages/report-core/src/session-query.test.ts packages/report-core/src/focused-report-query.test.ts`
→ all pass.

### Step 2: Apply pure/stored parity

Use the same local-time conversion as `buildPunchcard`. Test 13:59, 14:00,
14:59, and 15:00 across Sunday/Monday; assert identical row identities.

**Verify**: focused and usage-store test commands pass with parity assertions.

### Step 3: Add URL and active pill

Implement strict parsing, serialization, label, and clearing.

**Verify**: `bun test apps/web/src/dashboard-search.test.ts` → round trips pass.

### Step 4: Make non-empty cells buttons

Use an aria-label such as “Filter report to Monday 14:00–14:59, 12 sessions”.
Empty cells stay non-interactive. Support click and keyboard activation.

**Verify**: E2E asserts URL, pill, narrowed count, keyboard use, and clearing.

### Step 5: Run gates

**Verify**:
`bun run check && bun run lint && bun run typecheck && bun run test && bun run test:e2e && bun run test:e2e-demo && git diff --check`
→ all pass.

## STOP conditions

- Stored parity needs timestamp semantics different from Punchcard.
- Filtering can only occur after aggregation.
- Correct behavior needs a user-selected timezone.
