# Canonical Sources integration

`apps/web/src/routes/+layout.svelte` creates exactly one
`SourceControlProvider` inside the root `WebQueryProvider` and around the single
`AppShell`. The provider owns start, reconnect, current-report invalidation, and
disposal for both the navigation summary and Sources page.

The explicit EventSource service owns one connection and reconnect lifecycle.
Each bounded state publication is written to the named Sources Query key, which
is the value consumed by the provider context and UI. Commands use one Query
mutation; pending/error state comes from its observer. A new publication
invalidates only the current Report bootstrap/manifest aliases.

The layout defines one `SourceControlSummary` snippet and passes it through
`AppShell`, which renders it once in the workspace header on every route, except
in demo mode. Its compact button opens collection details on hover or activation
(keyboard and touch), including warnings and the Collect now action. The panel
mounts only while open; elapsed-time updates stop when it closes. Report filters
do not render collection controls. Feature code does
not create another provider, source-control service, EventSource subscription,
or summary instance.

Report destinations retain their own displayed-data timestamp and any explicit
Apply action needed to preserve an exploration. These describe the displayed
revision, while the header describes global collection and report preparation.

The header reports active collection and publication first, then `Needs attention`
for current failures or uncertain metrics, or `Up to date`. Uninstalled and
unsupported harnesses are not failed collection runs. Dated metric anomalies
whose latest occurrence is older than seven days remain visible under
`Historical data` in the panel and on Sources, without a global alert. Unknown
dates and mixed historical/current warnings remain actionable. The seven-day
window is collection-wide and independent of report filters; old uncertainty is
never erased or presented as repaired.

`apps/web/src/routes/sources/+page.svelte` renders the canonical `SourcesPage`.
The page owns its `main` landmark and heading and consumes the root provider
rather than wrapping itself in another route frame or lifecycle owner.

Source-control HTTP ownership remains explicit in
`apps/web/src/routes/api/source-control/+server.ts` and
`apps/web/src/routes/api/source-control/command/+server.ts`; snapshot waiting,
event fan-out, command execution, and process lifecycle stay delegated to the
usage engine.
