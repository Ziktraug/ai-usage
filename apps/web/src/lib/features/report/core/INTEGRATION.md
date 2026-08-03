# Canonical report root integration

The canonical report route is `apps/web/src/routes/+page.ts`. Its awaited
`load` calls `loadReportPageData` with the parent runtime mode, the route `fetch`
function, the current URL, and the stable `report-root-ssr` request owner.
`loadReportPageData` selects demo or E2E data before constructing a live report
client. In live mode it awaits the current-alias bootstrap, accepts a compatible
stored publication, maps typed unavailability to the bounded route error, and
returns the dehydrated exact query key.

`apps/web/src/routes/+page.svelte` renders one `ReportRoot` with that route data.
The root `WebQueryProvider` in `apps/web/src/routes/+layout.svelte` reads the
hydration state, so SSR and hydration reuse the same exact current-alias result
without a second bootstrap or another query provider.

Focused destination sessions are consumed through
`apps/web/src/lib/features/report/lifecycle/report-lifecycle-owner.svelte`.
Route leaves do not serialize a
`ServedReportSession` through page data or reimplement expiry, supersession, or
atomic commit. Each consumer disposes its owner during Svelte teardown so
pending work is aborted exactly once. The last complete workspace remains
visible while a focused refresh is pending or fails.
