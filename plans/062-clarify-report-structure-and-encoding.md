# Plan 062: Clarify Report Structure and Visual Encoding

> Implement only the locked choices below. DOM and computed-geometry assertions
> are authoritative; update existing Playwright snapshots only after they pass.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- apps/web/src/dashboard.tsx apps/web/src/overview.tsx apps/web/src/project-group-editor.tsx apps/web/src/time-range-control.tsx packages/design-system/src/components/overview.ts`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MEDIUM
- **Depends on**: plans 053, 054, and 061
- **Category**: tech-debt
- **Planned at**: commit `f4f9650`, 2026-07-28

## Locked choices

- `HIER-3`: render More report metrics and Provider status on Overview only.
  Replace three adjacent money tiles with one “Value bases” panel containing
  API-equivalent value, actual recorded cost, and subscription value as three
  labelled rows with their existing definitions.
- `BRK-3`: render Projects first; place `ProjectGroupEditor` in a closed
  `<details>` labelled “Manage project groups”.
- `VIZ-1`: remove `SegmentBar`; token anatomy becomes a four-row definition list
  with swatch, label, exact value, and percentage. This avoids sub-pixel segments.
- `VIZ-2`: Punchcard uses fixed-size cells and one channel—fill intensity—for
  session count, plus a low/high key. Session Shape keeps x=duration, y=API value,
  color=harness, fixed point size; replace “density mark” with “campaign”.
- `VIZ-3`: boundary dates get their own row below ticks; suppress any tick whose
  measured label box intersects a boundary label box.
- `VIZ-4`: owned by plan 061; do not touch it again.

Harness↔provider hierarchy (`BRK-2`) is intentionally excluded: current groups
do not carry the joint distribution. It needs a separate data-contract plan,
not UI inference.

## Scope

- `apps/web/src/dashboard.tsx`
- `apps/web/src/dashboard-metrics.tsx` and render tests
- `apps/web/src/overview.tsx`
- `apps/web/src/overview-model.ts` and tests
- `apps/web/src/project-group-editor.tsx`
- `apps/web/src/time-range-control.tsx` and tests
- `packages/design-system/src/components/overview.ts`
- `packages/design-system/src/report.ts`
- `apps/web/e2e/dashboard-presentation.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts` and affected snapshots

No report-core aggregation, range-card, metric semantics, or row removal.

## Steps

### Step 1: Add failing structural and geometry assertions

Assert Overview-only status regions, Projects-before-editor DOM order, closed
group-management disclosure, four anatomy rows/no segmented bar, one Punchcard
intensity channel plus key, fixed Session Shape point size plus harness key, and
non-intersecting timeline label boxes at 1440px and 900px.

**Verify**: focused tests fail on current markup/geometry only.

### Step 2: Restrict status content and disclose group management

Add render tests for Overview-only status and Projects-first order.

**Verify**: focused dashboard render tests pass.

### Step 3: Replace ambiguous encodings

Implement the locked anatomy, Punchcard, and Session Shape contracts with keys.

**Verify**: Overview model/render tests assert one channel per metric and the
word “campaign”, not “density mark”.

### Step 4: Separate timeline labels

Test 1440px and 900px label-box collision decisions in pure presentation logic.

**Verify**: time-range tests contain no intersecting retained boxes.

### Step 5: Update snapshots and run gates

**Verify**: run
`bun run --cwd apps/web test:e2e -- e2e/visual-regression.spec.ts --update-snapshots`,
then
`bun run check && bun run lint && bun run typecheck && bun run test && bun run test:e2e && bun run test:e2e-demo && git diff --check`
all pass.

## STOP conditions

- A locked visual needs new aggregation data.
- A change alters number meaning or range-card controls.
