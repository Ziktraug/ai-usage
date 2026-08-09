# Canonical Overview integration

`live-report-destination.svelte` projects the requested Overview identity from
the URL and small local timeline intent. `reportDestinationQueryOptions` owns
the current descriptor and exact Overview result under the same persistent
Query client used by every Report destination.

## Query ownership

- Render `overview-page.svelte` directly from the complete destination result
  and expose pending/error/retained status from its Query observer.
- A stale or failed refresh retains the previous complete Overview; do not copy
  it into component state or replace the workspace with global loading UI.
- Range, filters, timeline dimension, value, selection, and drag preview remain
  component/URL interaction intent and are not server-state caches.
- Publication and typed expiry change only named current aliases and produce a
  new immutable exact key; never write a new revision under an old key.

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

A document request dehydrates the bootstrap and exact initial Overview under
the same keys used by the browser. Hydration performs no duplicate acquisition;
there is exactly one root Query provider and one browser oRPC client.

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
