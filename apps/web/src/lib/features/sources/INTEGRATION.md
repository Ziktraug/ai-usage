# Canonical Sources integration

`apps/web/src/routes/+layout.svelte` creates exactly one
`SourceControlProvider` inside the root `WebQueryProvider` and around the single
`AppShell`. The provider owns start, reconnect, current-report invalidation, and
disposal for both the navigation summary and Sources page.

The layout defines one `SourceControlSummary` snippet and passes it through
`AppShell` to `AppNavigation`. Navigation renders that snippet once in each
mutually exclusive responsive branch and never in demo mode. Feature code does
not create another provider, source-control service, EventSource subscription,
or summary instance.

`apps/web/src/routes/sources/+page.svelte` renders the canonical `SourcesPage`.
The page owns its `main` landmark and heading and consumes the root provider
rather than wrapping itself in another route frame or lifecycle owner.

Source-control HTTP ownership remains explicit in
`apps/web/src/routes/api/source-control/+server.ts` and
`apps/web/src/routes/api/source-control/command/+server.ts`; snapshot waiting,
event fan-out, command execution, and process lifecycle stay delegated to the
usage engine.
