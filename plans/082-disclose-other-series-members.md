# Plan 082: Let the Reader See What the Timeline "Other" Series Contains

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- packages/report-core/src/focused-report-query.ts apps/web/src/lib/features/report/overview/timeline-model.ts apps/web/src/lib/features/report/overview/activity-timeline.svelte`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

When a timeline dimension has more than 12 categories, the tail collapses
into a non-filterable `Other` series. Its member keys are computed and even
shipped on the wire (`memberKeys`), but they never reach the DOM: the legend
entry is a disabled button whose tooltip is just "Other". On a multi-model
or multi-project range, `Other` can be a double-digit share of the chart
with zero affordance to learn what is inside. The maintainer's constraint is
settled and must be preserved: **`Other` never becomes an exact dimension
filter** (`docs/future-work.md`: "do not turn `Other` into an exact
dimension filter"; add disclosure "only if users need to inspect those
members directly" — this plan is that read-only disclosure).

## Current state

- `packages/report-core/src/focused-report-query.ts`:
  - lines 812–876: when `series.length > MAX_TIMELINE_SERIES`, the tail
    (`aggregated = ranked.slice(MAX_TIMELINE_SERIES - 1)`) becomes one
    series `{ key: aggregateKey, label: 'Other', memberKeys, ... }`
    (line 867–875). At this point `labels.get(key)` (line 806/861) and each
    member's totals (`value.cost`, `value.sessions`) are in scope — the
    display labels exist here and are currently dropped.
  - line 819: `const memberKeys = aggregated.map(([key]) => key);` —
    unbounded (as many keys as the tail has).
  - lines 1848–1856 (transport validator): series allow-list is
    `['key','label','priceMeasurement','sessions','tokens','total']` with
    optional `['memberKeys']` via `assertAllowedKeys`.
- `apps/web/src/lib/features/report/overview/timeline-model.ts` lines
  168–176: `timelineSeriesIsFilterable` returns `false` whenever
  `memberKeys` is non-empty (also for campaign/origin dimensions) — the
  deliberate non-filterable guarantee. **Do not change this function.**
- `apps/web/src/lib/features/report/overview/activity-timeline.svelte`
  lines 370–395: the legend `<ul>` renders one `<li>` per series with a
  `legendButton` that is `disabled={!filterable}` and
  `title={filterable ? … : series.label}` — for `Other`, a disabled button
  whose tooltip says "Other". `memberKeys` is otherwise unused in the DOM
  (repo-wide, `timelineSeriesIsFilterable` is its only consumer).
- Presentation gate (plans/README.md): a presentation change needs a
  deterministic DOM assertion that fails on the symptom and passes on the
  fix — plan for one in the e2e/presentation spec that covers the timeline
  legend (grep `total-legend` under `apps/web/e2e/`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| Core tests | `bun test packages/report-core` | all pass |
| Web tests | `bun run --cwd apps/web test` | all pass |
| E2e | `bun run test:e2e` | all pass |

## Scope

**In scope**:
- `packages/report-core/src/focused-report-query.ts` (+ its tests)
- `apps/web/src/lib/features/report/overview/timeline-model.ts` (+ tests) —
  only to *present* members; not `timelineSeriesIsFilterable`
- `apps/web/src/lib/features/report/overview/activity-timeline.svelte`
- `apps/web/src/focused-report-e2e-fixture.ts` — extending it is
  **mandatory**, not a fallback: the current fixture rows yield at most ~5
  distinct categories in any dimension, so no dimension produces an
  `Other` series today (see Step 3 for the isolation constraint)
- The e2e/presentation spec that asserts the legend

**Out of scope** (do NOT touch):
- `timelineSeriesIsFilterable` and `onDimensionFilter` wiring — `Other`
  stays non-filterable and non-clickable as a filter.
- `MAX_TIMELINE_SERIES` and the ranking/aggregation math.
- Chart geometry/readout.

## Git workflow

- Commit style: `feat(report): disclose the Other timeline members`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Ship bounded member summaries from the query

In `focused-report-query.ts`, next to `memberKeys` (line 819), build:

```ts
const OTHER_MEMBER_SUMMARY_LIMIT = 10;
const memberSummaries = aggregated
  .slice(0, OTHER_MEMBER_SUMMARY_LIMIT)
  .map(([key, value]) => ({ label: labels.get(key) ?? key, sessions: value.sessions, total: value.cost }));
```

Attach `memberSummaries` to the `Other` series object (line 867–875) beside
`memberKeys`. Extend the transport validator (line ~1850) to allow the
optional `memberSummaries` key: an array of ≤ 10 records with exactly
`{ label: string, sessions: non-negative safe integer, total: finite number }`,
using the existing `requireString`/`requireNonNegativeSafeInteger`/
`requireFiniteNumber` helpers. Also cap `memberKeys` transport-side while
you are in the validator **only if** a bound already exists elsewhere for
similar arrays — otherwise leave `memberKeys` as-is (changing its contract
is not this plan's job).

Extend the focused-report-query tests: a fixture with > 12 categories
asserts `Other` carries at most 10 summaries, ordered by rank, with correct
totals; a fixture with ≤ 12 categories has no `Other` and no summaries.

**Verify**: `bun test packages/report-core` → all pass with the new cases.

### Step 2: Present the members in the legend

In `timeline-model.ts`, add a pure presenter:

```ts
export const timelineOtherDisclosure = (
  series: Pick<FocusedTimelineSeries, 'memberKeys' | 'memberSummaries'>,
): { label: string; items: readonly string[] } | null
```

returning `null` when there are no member keys; otherwise items like
`"claude-opus-4 · 12 sessions"` (reuse the number formatting used elsewhere
in this file) and a label `"${memberKeys.length} grouped"` plus
`"and N more"` appended to items when `memberKeys.length > memberSummaries.length`.
Unit-test it beside the existing timeline-model tests.

In `activity-timeline.svelte`, inside the legend `<li>` for a series where
`timelineOtherDisclosure(series)` is non-null, render after the (still
disabled) legend button:

```svelte
<details data-timeline-other-members>
  <summary>{disclosure.label}</summary>
  <ul>
    {#each disclosure.items as item}<li>{item}</li>{/each}
  </ul>
</details>
```

Style with existing legend classes/tokens in this file; keep it visually
subordinate (muted, small). No `onclick` filter wiring anywhere in the
disclosure.

**Verify**: `bun run --cwd apps/web test` → all pass; `bun run typecheck` → exit 0.

### Step 3: Deterministic DOM assertion

The current fixture cannot produce an `Other` series (≤ ~5 categories per
dimension), so extend `apps/web/src/focused-report-e2e-fixture.ts` with an
**isolated** addition rather than mutating the shared rows: add > 12
distinct categories in exactly one dimension that the settled visual
snapshots do not render by default (the snapshots capture the default
dimension — verify which one before choosing), leaving every existing
total and series untouched in the default view. Then, in the e2e spec that
covers the timeline legend (grep
`data-report-range-part="total-legend"` under `apps/web/e2e/`), switch the
timeline to that dimension and assert `[data-timeline-other-members]`
exists, its summary names the member count, and it contains no `button`.
If isolation is impossible — any change to the fixture shifts totals
asserted by the presentation/visual specs in the default view — STOP and
report the blast radius instead of updating snapshots wholesale.

**Verify**: the spec passes; `bun run test:e2e` → all pass.

### Step 4: Gates

**Verify**: `bun x ultracite fix && bun run check && bun run typecheck && bun run test && bun run test:e2e` → all pass.

## Test plan

- Core: member summaries bounded/ordered/absent-when-no-Other.
- Model: `timelineOtherDisclosure` null-cases, "and N more" arithmetic.
- DOM: disclosure present, non-interactive (no button), count label correct.

## Done criteria

- [ ] `grep -n "memberSummaries" packages/report-core/src/focused-report-query.ts` → construction + validator
- [ ] `grep -n "data-timeline-other-members" apps/web/src/lib/features/report/overview/activity-timeline.svelte` → present
- [ ] `timelineSeriesIsFilterable` unmodified (`git diff` on timeline-model.ts shows only additions)
- [ ] `bun run test` and `bun run test:e2e` exit 0
- [ ] `plans/README.md` status row updated

## STOP conditions

- Adding `memberSummaries` breaks the transport size budget (check
  `report-budgets.ts` if the overview payload has a bound the new array
  could cross on a pathological store) — report the measured delta.
- The e2e fixture cannot produce an `Other` series without touching
  snapshot-covered dimensions.
- Anything requires making the disclosure clickable-as-filter to be useful —
  that contradicts the settled decision; report the tension instead.

## Maintenance notes

- If a reader ever needs the *full* member list, the right shape is a
  drill-down into the Breakdown view for that dimension (which lists all
  keys and already filters) — link, don't grow the disclosure.
- Reviewer should scrutinize: the validator's bounds and that the
  disclosure adds no interactive filter surface.
