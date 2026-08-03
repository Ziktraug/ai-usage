# P8 Breakdown/actions integration request

P8 does not edit the P1 report root or coordinator-owned routes. Integrate the
two accepted implementation commits in order:

1. `4dd9b93` — action/filter/breakdown foundations.
2. `12939b48df4bb362634287e8956996a781cbd1ca` — complete four-destination
   breakdown, responsive projects, quota history, isolation and evidence tests.

## Report composition

- Create one `BreakdownNavigation` with `createBreakdownNavigation` from the
  existing R0 search intent. Pass its current URL-backed `DashboardSearch`
  into `FilterBar` and `ActiveFilters`; do not introduce local filter state.
- Mount `DashboardBreakdown` for Breakdown primary tabs. Supply the accepted
  report payload groups, cursor attribution, project-group payload and the same
  canonical search-backed tab/sort/filter callbacks.
- Keep Overview/range ownership in P2 and Sessions ownership in P3/P4. P8 owns
  only Breakdown, filters and report actions.
- Replace the legacy campaign editor, project-group editor, sharing actions and
  quota-history panel with the P8 Svelte owners. Preserve campaign keys and
  project report revision identity when display labels/configuration change.

## Frozen query and runtime seams

- `QuotaHistoryOwner` creates its browser client lazily, enables Q1 quota
  options only after mount while open, and never queries in demo mode. Pass the
  current report generation to its Q1 option seam.
- The filter bar's source-control summary remains a coordinator-supplied
  snippet so P8 never imports P6/Sources ownership.
- Pass raw machine IDs as URL/filter values and a presentation-only
  `presentMachineLabel`; never serialize display labels.
- P8 imports only `@ai-usage/design-system/svelte` and the CSS entrypoint in
  its client graph. It deliberately does not import the Solid `/report`
  compatibility barrel.

## Behavioral evidence

- Models, Harnesses & providers, Projects and Cursor AI are four controlled
  tabs. Harness/provider disclosure uses stable encoded IDs, search expands
  matching children, and CSV contains exactly visible sorted rows.
- Measured, partial, zero and unavailable API-value states are distinct.
  Unavailable rows retain explicit hints; partial rows retain coverage.
- Copy link uses the exact current URL. CSV download errors and clipboard
  failures remain announced without disabling the independent sibling action.
- Origin filtering uses the frozen Svelte Popover/Checkbox controls with
  Default and All actions. Active-filter pills match the legacy visible set.
- Project summaries retain desktop table and mobile card projections. Data
  quality controls focus the existing management disclosure.
- Quota history is browser-on-demand, focus-restoring, range/filter controlled,
  responsive, reset/gap segmented, and includes accessible observation tables.

## Exact local gates

```sh
bun test apps/web/src/lib/features/report/breakdown/*.test.ts apps/web/src/lib/features/report/actions/*.test.ts
bun apps/web/src/lib/features/report/breakdown/p8.browser.ts
bun run --cwd apps/web check:svelte
bun x ultracite check apps/web/src/lib/features/report/breakdown apps/web/src/lib/features/report/actions
bun tools/check-package-boundaries.ts
bun tools/check-web-migration-parity.ts
```

The focused gate is 32 pass, 0 fail, 79 expectations. The synthetic Chrome
gate covers the 11 retired TSX contracts with rendered interaction and Axe
evidence. Svelte reports zero errors/warnings and Ultracite checks 32 owned
files.
