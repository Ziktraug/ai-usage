# Canonical report root integration

The canonical report route uses `+page.server.ts` for bounded document SSR and
`+page.ts` only to adopt parent/runtime data. A live document request awaits the
current bootstrap and the exact requested destination, then dehydrates their
canonical Query keys. Demo and E2E select bundled data before any live client is
constructed. Typed bootstrap unavailability maps to the bounded route error.

On a SvelteKit data request, `+page.server.ts` returns an empty hydration delta.
It does not prefetch Report RPC data. The long-lived Query client in
`+layout.svelte` therefore serves a previously visited destination immediately;
its mounted observers fetch only missing or stale entries.

`apps/web/src/routes/+page.svelte` renders one `ReportRoot` with that route data.
The root `WebQueryProvider` merges root quota and page hydration states, so SSR
and hydration reuse authoritative timestamps without a duplicate request or a
second provider.

`reportDestinationQueryOptions` is the sole live destination lifecycle. Its one
result contains the accepted descriptor, Overview, and optional Breakdown or
complete requested Session window at the same revision. TanStack Query owns
supersession, abort, pending/error state, retained data, and cache lifetime. The
composite query owns one typed expiry recovery by refreshing the current
bootstrap once. Components render `query.data` directly and retain only URL,
selection, requested Session depth, and presentation intent locally.

Publication invalidates current bootstrap/manifest aliases only. Exact
revision entries are immutable and remain available until their bounded GC.
Campaign labels and project-group writes use Query observers and named minimal
cache updates/invalidation.
