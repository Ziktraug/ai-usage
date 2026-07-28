# Plan 055: Make Focused Report Pending State Truthful

> Preserve previous data internally during refresh, but never present it as the
> result of newly requested filters. Do not change revision or cancellation
> ownership. Update plan 055 in `plans/README.md`.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- apps/web/src/dashboard-report-lifecycle.ts apps/web/src/dashboard.tsx apps/web/src/focused-report-client.ts apps/web/src/dashboard-metrics.tsx`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f4f9650`, 2026-07-28

## Why this matters

During a focused request the page can assert `0 / N sessions`, `N hidden by
filters`, “No sessions match”, and `$0.00` before the matching result arrives.
Absence may only be stated after the requested destination settles.

## Target state machine

Add `destinationPending(): boolean` to the lifecycle. It becomes true in
`markLoading` for every new destination and false only when that exact operation
succeeds, fails while preserving prior data, or is aborted. A superseded request
must not clear a newer request's pending state.

While pending, retain the old focused snapshot internally, keep requested filter
pills visible, and replace the session counter, hidden count, metric tiles, and
active destination body with one `aria-live="polite"` “Loading report…” surface.
Render no numeric placeholder or empty-result copy.

## Scope

- `apps/web/src/dashboard-report-lifecycle.ts`
- `apps/web/src/dashboard-report-lifecycle.test.ts`
- `apps/web/src/dashboard.tsx`
- `apps/web/src/dashboard-metrics.render.test.tsx`
- `apps/web/e2e/dashboard.spec.ts`
- the synthetic focused-response fixture imported by that spec

No transport retry, fingerprint, store invalidation, or real-history changes.

## Steps

### Step 1: Characterize transitions

Test initial load, filter change with prior data, success, failure preserving
prior data, supersession, and disposal.

**Verify**: `bun test apps/web/src/dashboard-report-lifecycle.test.ts` → the new
tests initially fail only because pending ownership is absent.

### Step 2: Implement request-owned pending state

Tie clearing to the existing served-session operation ownership; do not add an
independent request counter.

**Verify**: `bun test apps/web/src/dashboard-report-lifecycle.test.ts` → all pass.

### Step 3: Gate definitive output

Render the locked pending surface while keeping filter pills. Reuse existing
panel/text recipes and add no spinner dependency.

**Verify**: `bun test apps/web/src/dashboard-metrics.render.test.tsx` → pending
markup contains no `$0.00`, `hidden by filters`, or `No sessions`.

### Step 4: Add deterministic browser coverage

Use a controllable synthetic response gate, not sleeps. Assert every state
between filter commit and response lacks definitive zero/empty claims.

**Verify**: `bun run test:e2e` → all pass.

### Step 5: Run gates

**Verify**:
`bun run check && bun run lint && bun run typecheck && bun run test && bun run test:e2e-demo && git diff --check`
→ all pass.

## Done criteria

- [ ] Pending is operation-owned and supersession-safe.
- [ ] No pending frame asserts zero or absence.
- [ ] Requested filters remain visible.
- [ ] Exact-revision behavior remains green.

## STOP conditions

- The fix weakens exact-revision validation.
- A stale operation can clear current pending state.
- Browser coverage needs real histories or arbitrary sleeps.
