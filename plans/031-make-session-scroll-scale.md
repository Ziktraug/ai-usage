# Plan 031: Make session scrolling trustworthy at 5,000 rows

> **Status: DONE** — bounded paging and windowing now prove all 5,000 sessions reachable on desktop and mobile.
>
> This is one measure-and-implement plan. Do not stop after producing a report
> or create a second decision plan.

## Outcome

With 5,000 deterministic synthetic sessions, every session remains reachable
exactly once on desktop and mobile, the DOM stays bounded, and scrolling/loading
does not regress the initial bundle or existing report budgets.

## Current evidence

- `apps/web/src/session-table.tsx` owns the desktop window, mobile list, paging
  sentinel, and scroll behavior.
- `apps/web/src/session-query-client.ts` owns incremental query generations and
  request coordination.
- Existing server/report contracts already impose bounded rows and serialized
  payload budgets; preserve them rather than inventing a parallel protocol.
- The desktop path is windowed, while the mobile path can accumulate cards.
- No committed 5,000-session fixture proves reachability, duplicate prevention,
  DOM bounds, or the sentinel's actual scroll root.

## Scope

- Add one deterministic 5,000-session fixture derived from existing synthetic
  report builders.
- Measure serialized payload, JS heap delta when supported, maximum session DOM
  nodes, initial render, and one representative filter/sort interaction.
- Choose and implement the simplest architecture using the decision table below.
- Preserve continuous scrolling; do not replace it with a “Load more” product
  interaction.
- Add permanent correctness and DOM-bound regression coverage.
- Record the measured before/after result in a short
  `docs/session-scroll-benchmark.md`.

Out of scope: a generic benchmark framework, schema-versioned measurement
artifacts, server API redesign unrelated to the failing threshold, or changing
session-detail semantics.

## Decision table

Run three local production-mode samples and use medians for diagnostic timings.
Correctness, payload, and DOM bounds are hard gates; timings explain the change
but are not cross-machine CI thresholds.

| Signal at 5,000 sessions | Full client query is allowed only if | Otherwise |
| --- | --- | --- |
| Reachability | all 5,000 stable IDs are visited exactly once | keep bounded paging and fix ownership/order |
| Serialized result | fits the existing report/query byte and row budgets | keep bounded paging |
| DOM | at most 300 session rows/cards on desktop and 600 on mobile | window the failing layout |
| Heap | median delta is at most 100 MiB in supported Chromium runs | keep paging/windowing |
| Interaction | median initial render and filter/sort are each at most 1.5 s locally | keep paging/windowing and remove the measured bottleneck |

If every full-query condition passes, remove unnecessary paging complexity but
keep desktop/mobile windowing where required by the DOM bound. If any condition
fails, retain bounded paging, give one owner to generation/cancellation/order,
ensure the sentinel observes the real scroll container, and window the mobile
cards. The executor implements the selected branch in this plan.

## Implementation

1. Add the fixture and a Playwright measurement scenario without changing
   production behavior. Capture the before numbers in the benchmark document.
2. Assert stable IDs, exact reachability, no duplicates/drops across page
   boundaries, and maximum DOM counts while scrolling from first to last.
3. Apply the decision table and implement the smallest winning branch.
4. Add regression tests for rapid filter/sort changes, stale request completion,
   unmount/cancellation, end-of-list, desktop, and mobile.
5. Capture after numbers with the same fixture/browser/viewport and explain the
   chosen architecture in the benchmark document.
6. Check the initial gzip closure with the existing production/audit tooling;
   it must remain within the existing project budget and no more than 10% above
   the measured baseline.

## Verification

- Focused model tests cover query generation, ordering, cancellation, and page
  boundaries.
- Playwright reaches the first and last stable IDs exactly once on desktop and
  mobile while enforcing DOM bounds.
- Run `bun run test`, `bun run test:e2e`, `bun run test:e2e-production`,
  `bun run test:web-production`, `bun run check`, `bun run lint`,
  `bun run typecheck`, and `bun run build`.

## Done

- [x] The benchmark records comparable before/after facts and the selected row
  of the decision table.
- [x] The selected architecture is implemented in this plan.
- [x] 5,000 sessions are reachable exactly once on desktop and mobile.
- [x] DOM, existing payload, heap, interaction, and bundle conditions pass.
- [x] Rapid query changes cannot publish stale or duplicate rows.

## STOP conditions

Stop only if the existing server contract makes the measured fix impossible
without an API redesign, measurements are unavailable after two scoped attempts,
or correctness cannot be established. Do not stop merely to ask the owner which
branch to choose; the table is the decision authority.

## Maintenance

Keep correctness and DOM bounds in CI. Treat local timing and heap numbers as
diagnostic evidence to refresh when session rendering or payload shape changes.
