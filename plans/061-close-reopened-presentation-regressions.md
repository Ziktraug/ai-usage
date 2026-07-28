# Plan 061: Close the Four Reopened Presentation Regressions

> DOM, computed-geometry, and unit assertions are the authority. Update the
> existing Playwright snapshots after those assertions pass; snapshots are review
> artefacts, not a human approval gate. Update plans 046 and 061 in
> `plans/README.md` only after all automated gates pass.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- packages/design-system/src/components/overview.ts packages/design-system/src/components/skills.ts apps/web/src/overview.tsx apps/web/src/group-panel-presentation.ts apps/web/src/time-range-control.tsx`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 046 implementation already landed
- **Category**: bug
- **Planned at**: commit `f4f9650`, 2026-07-28

## Locked fixes

| ID | Fix |
| --- | --- |
| 046-4 | Remove the minimum-width value-bar floor. Positive widths remain proportional; exact zero has an empty track plus `$0.00`; unavailable has no track and `—`. |
| 046-11 | Remove `ml: 'auto'` from anatomy legend values so value remains adjacent to label. |
| 046-13 | Map `SkillMarkdownTokenWarning` to “Skill document token warning”; never display the raw type identifier. |
| 046-24 | Remove Rhythm's redundant native date input; heatmap selection remains the sole activity-day control. |

## Scope

- `apps/web/src/group-panel-presentation.ts` and tests
- `packages/design-system/src/components/overview.ts`
- `packages/design-system/src/components/skills.ts`
- `apps/web/src/skills-context-panel.tsx`
- `apps/web/src/skills-page-model.test.ts`
- `apps/web/e2e/skills.spec.ts`
- `apps/web/src/overview.tsx`
- `apps/web/src/time-range-control.tsx` and tests
- `apps/web/e2e/time-range.spec.ts`
- `apps/web/e2e/dashboard-presentation.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts` and affected snapshots

No number meanings, range card, collector data, or unrelated layout changes.

## Steps

### Step 1: Add failing machine-checkable regressions

Assert all four outcomes without screenshots:

- price-bar width equals the pure proportional result; zero is `0`, unavailable
  has no fill;
- computed label-to-value gap is smaller than value-to-next-item gap;
- raw `SkillMarkdownTokenWarning` is absent and the human label is present;
- `input[type=date]` is absent from Rhythm while clickable heatmap cells remain.

**Verify**: focused unit/render/Playwright tests fail on the current symptoms only.

### Step 2: Apply the four locked fixes with focused tests

Add proportional/zero/unavailable bar tests, legend adjacency render assertion,
human diagnostic label assertion, and absence of the native Rhythm date input.

**Verify**:
`bun test apps/web/src/group-panel-presentation.test.ts apps/web/src/time-range-control.test.ts apps/web/src/skills-page-model.test.ts`
→ all pass.

### Step 3: Update deterministic snapshots

Run Playwright's existing settled fixture in UTC and update only snapshots whose
DOM invariant changed:

`bun run --cwd apps/web test:e2e -- e2e/visual-regression.spec.ts --update-snapshots`

**Verify**:
`bun run --cwd apps/web test:e2e -- e2e/dashboard-presentation.spec.ts e2e/visual-regression.spec.ts`
→ all pass with no unexpected snapshot.

### Step 4: Run gates

**Verify**:
`bun run check && bun run lint && bun run typecheck && bun run test && bun run test:e2e-demo && git diff --check`
→ all pass.

## STOP conditions

- A fix changes metric meaning or removes a report row/category.
- Closing a row requires collector or report-core changes.
