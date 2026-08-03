# P2 Overview integration request

P2 intentionally does not edit P1's report root or the coordinator-owned route.
At X0, replace `ReportBootstrapOverview` in
`features/report/core/report-root.svelte` with the focused Overview destination
below. The candidate P2 implementation commit is
`0f252cafffbdaf863da5a235c848143154231e07`.

## Compose one focused destination owner

- Create the `ServedReportSession` in the browser and consume it only through
  `ReportLifecycleOwner`. Do not serialize it through page data and do not add a
  second Query provider.
- The adapter must acquire the current descriptor once, load the exact Overview
  with `reportOverviewQueryOptions`, and commit only the matching revision and
  request fingerprint. Reuse P1's expiry/supersession/abort owner. Do not import
  `dashboard-served-report-session.ts`; that legacy adapter imports Solid.
- The Overview destination is `{ includeAdvanced: true, query, timeline }`.
  Keep one destination snapshot for range, filters, timeline dimension and
  granularity. A destination refresh retains the last complete
  `FocusedOverviewResult` while pending or failed.
- Render `overview/overview-page.svelte` only from the accepted focused result.
  Pass `snapshot.pending` and `snapshot.refreshError` back to the existing
  `ReportWorkspace` status seam; never replace complete output with global
  loading UI.

## Navigation and support inputs

- Build one `SearchNavigationIntent<DashboardSearch>` with R0's
  `createDashboardSearchNavigation`. Pass it to `OverviewPage`; range commits
  use R0's edit-run replace/push policy. Day selection navigates to Sessions
  with the selected custom day range. Punchcard selection serializes the
  `LocalTimeCell` into canonical `timeCell` and navigates to Sessions.
- Pass the current `DashboardDateRangeSearch` as `range`. Feed dimension,
  granularity and value changes back into the same focused destination; changing
  chart granularity must not change the report range.
- Pass `bootstrap.machineFreshness` to `freshness`. Build provider views from
  the bootstrap provider-status dataset at its captured `generatedAt`; do not
  reacquire or infer them from real local histories in the client.

## SSR and query ownership

P1's awaited bootstrap remains the meaningful SSR surface. The client-created
session starts after hydration from that accepted descriptor, and the exact
immutable Overview query remains owned by Q1. There must still be exactly one
bootstrap request and one global Query provider. A later coordinator enhancement
may dehydrate the exact Overview result, but must use the identical Q1 key and
must not introduce a second acquisition path.

## D4 chart-color delta

The explicit `/svelte` entrypoint does not currently expose the pure
`stableSeriesColor` helper from `components/chart.ts`; importing `/report` would
pull the TSX compatibility barrel into the Svelte client closure. Before the X0
visual gate, export that pure helper from `@ai-usage/design-system/svelte` and
apply it to timeline segments and matching legend swatches by `series.key`.
Until that coordinator delta, P2 deliberately uses the semantic accent color
while retaining stable `data-series-key` identities. Regenerate package/export
evidence from the accepted D4 source; do not hand-edit generated Panda output.

## Retired owner evidence

P8 owns the Svelte replacements for `cursor-attribution-panel.tsx`,
`group-panel.tsx`, `project-summary.tsx`, and `shared.tsx`, although the initial
Wave 0 ledger assigned their production/render rows to P2. At X0, attach P8's
accepted source and test commits to those P2 ledger rows and mark the legacy
rows complete or reviewed-removal as appropriate. Do not duplicate Breakdown
components under Overview merely to satisfy the ledger owner.

## Validation note

The local `apply_patch` helper intermittently failed because the execution image
lacked bubblewrap. P2 used exact, reviewable Git/perl substitutions in its
isolated worktree and then ran Ultracite, recursive closure, strict targeted
Svelte typecheck, SSR and pure model gates. No source, behavior or assertion was
weakened because of the tooling incident, and the temporary typecheck config was
deleted before commit.

## Campaign and machine presentation seams

- Build one campaign-label index from the accepted bootstrap overrides. Pass
  `presentCampaignSeries` through `presentCampaignTimelineSeries`, and pass
  `presentSessionItem` through `presentFocusedOverviewSessionItem`. These two
  callbacks own display language only; stable campaign keys, row identities and
  filter values remain unchanged.
- Pass raw active legend keys and one `onDimensionFilter` callback from the
  existing dashboard search owner. P2 never owns a second filter state.
- Derive machine labels from the accepted `bootstrap.machineFreshness`, never
  from a new history/fleet acquisition. At X0, extract the framework-neutral
  snapshot/label/status helpers currently embedded in `manual-transfer-model.ts`
  into a collector-free presentation leaf, retaining legacy re-exports. Build
  `presentMachineSeries(key, label)` from that single snapshot and pass its exact
  `fresh | stale | unavailable` value plus label. Pass
  `machineFreshnessStatus` from the same snapshot. This avoids importing the
  manual-transfer module's usage-store types into the client closure and avoids
  duplicating P7's fleet owner.
