---
status: accepted
---

# ADR 0007: Server-render the report bootstrap

The trusted loopback report route loads its initial report data during SSR. Live mode embeds the bounded support bootstrap for one immutable revision, while demo and browser-test modes embed deterministic synthetic data. This accepts that local report metadata is present in the initial HTML because the same trusted browser can request it from the local server, and it avoids a global loading screen plus the hydration failure produced by a client-only route fallback.

[ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
changes only the backing location: SSR reads the current manifest and bounded
support bootstrap directly from revision-keyed SQLite through a read-only,
query-only connection. A compatible last publication remains SSR-readable when
the engine is down. No report data moves over engine HTTP; the SSR decision is
otherwise unchanged.

## Consequences

The report shell and bootstrap-backed dashboard render in the initial response. Exact-revision Overview, Breakdown, and Session destination queries remain bounded and continue after hydration. Browser-only finite queries, including quota history, are mounted only when their client interaction opens them so they cannot suspend the server render.

## Considered option

The previous client-only route kept all report data out of server HTML with `ssr: false`. That boundary was rejected after it introduced a visible first-render loading state and a deterministic Solid hydration mismatch in TanStack Router's pending route path.
