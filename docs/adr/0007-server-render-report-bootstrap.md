# ADR 0007: Server-render the report bootstrap and initial destination

- **Status**: Accepted
- **Date**: 2026-07-22; amended 2026-08-08 (initial-destination embedding) and
  2026-10-24 (current rationale and SSR acquisition)
- **Amended by**: [ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
  (backing location only),
  [ADR 0076](0076-browser-boundary-orpc-contract-and-tanstack-query.md)
  (in-process SSR acquisition)

The trusted loopback report route loads its initial report data during SSR. Live mode embeds the bounded support bootstrap for one immutable revision, while demo and browser-test modes embed deterministic synthetic data. This accepts that local report metadata is present in the initial HTML because the same trusted browser can request it from the local server, and it avoids a global loading screen plus the hydration failure produced by a client-only route fallback.

## 2026-08-08 amendment

Live mode may also embed the bounded exact focused result for the initially
requested destination. The trusted loopback browser is already authorized to
request that result immediately after hydration; serializing it in the initial
Query bundle removes that duplicate round trip and improves first paint without
expanding the trust boundary.

The initial bundle may therefore contain browser-visible report fields such as
session labels, stable row/source identities, machine/project metadata, local
source paths, and validated VCS links. This does not authorize raw prompt
bodies, credentials or tokens, provider stderr, unsafe URLs, local file
contents, or data outside the bounded focused-result contract. Those values
remain forbidden in both SSR and browser RPC responses.

[ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
changes only the backing location: SSR reads the current manifest and bounded
support bootstrap directly from revision-keyed SQLite through a read-only,
query-only connection. A compatible last publication remains SSR-readable when
the engine is down. No report data moves over engine HTTP; the SSR decision is
otherwise unchanged.

## Consequences

The report shell, bootstrap-backed dashboard, and initially requested exact
destination may render from the initial response. Other exact-revision
destinations and subsequent refreshes remain bounded Query operations after
hydration. Browser-only finite queries, including quota history, are mounted
only when their client interaction opens them so they cannot suspend the server
render.

## 2026-10-24 amendment

The decision stands; its reasons and mechanism are restated for the SvelteKit
app. Report acquisition is a server layout load
(`apps/web/src/routes/(report)/+layout.server.ts`) for two reasons. A
universal `load` would run again during hydration and re-acquire the report
over the network, because SvelteKit's serialized SSR fetch cache cannot replay
the Overview request, whose body is a Blob by then. And as a layout load it is
shared by the Session and Campaign detail routes, which must not re-acquire the
mounted report when the detail path changes. A client-only route would bring
back the first-render loading state.

Neither installed release removes the reason: Svelte 5.57.2 still gates `await`
in components behind `experimental.async`, and SvelteKit 3.1.0's remote
functions are still experimental (ADR 0076). What changes is how the server
load reads. Today it calls the app's own `/rpc` endpoint through `event.fetch`
subrequests, whose trust headers `subrequest-normalization.server.ts` has to
restore. ADR 0076 replaces those subrequests with an in-process router client
in plan 120 phase B; the embedded data, Query keys and privacy exclusions
above do not change.

## Considered option

The previous client-only route kept all report data out of server HTML with `ssr: false`. That boundary was rejected after it introduced a visible first-render loading state and, in the former Solid app, a deterministic hydration mismatch in TanStack Router's pending route path. The live reasons are in the 2026-10-24 amendment.
