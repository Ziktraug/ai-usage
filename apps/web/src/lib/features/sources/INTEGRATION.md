# P6 Sources integration request

Ownership of the root layout, shared shell and route leaves remains with the
coordinator. Integrate this feature exactly once as follows:

1. In `svelte-shadow/routes/+layout.svelte`, import
   `SourceControlProvider` from
   `$lib/features/sources/source-control-provider.svelte`.
2. Inside the existing `WebQueryProvider`, wrap the single root `AppShell` and
   its children with
   `<SourceControlProvider runtimeMode={data.runtimeMode}>`. The Query provider
   must stay outside so publication events can invalidate the two current
   Report aliases.
3. Render exactly one `SourceControlSummary` from
   `$lib/features/sources/source-control-summary.svelte` in the shared
   navigation/header surface, beneath that provider.
4. Replace the marker-only `/sources` route content with exactly one
   `SourcesPage` from `$lib/features/sources/sources-page.svelte`. `SourcesPage`
   owns its `main` landmark and heading; do not wrap it in `RouteFrame`.

Do not create a second `SourceControlProvider`, source-control service,
EventSource subscription or summary instance. The root provider is the sole
owner of start, reconnect, publication invalidation and disposal for both the
summary and Sources page.
