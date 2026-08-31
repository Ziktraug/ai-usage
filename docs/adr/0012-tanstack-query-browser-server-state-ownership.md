# ADR 0012: TanStack Query owns browser server state

- **Status**: Accepted
- **Date**: 2026-08-08
- **Supersedes**: ADR 0010 only where it assigns report visibility, retry,
  paging, or replay to `ServedReportSession` and the Session table owner
- **Preserves**: ADR 0002, ADR 0007, ADR 0009, and ADR 0010's SvelteKit,
  oRPC, trust, privacy, file-transfer, and direct-read decisions
- **Amended by**: [0037](0037-current-producers-and-durable-skill-invocations.md)
  (time-bounded skill-observation producer proof)

## Context

The SvelteKit migration installed TanStack Query and oRPC but left several
feature owners in charge of request timing, copied results, cancellation,
expiry recovery, paging, mutation status, and visible commits. Query cached the
same responses without being their lifecycle owner. Returning to a tab could
therefore rebuild a route cache or reacquire data that remained useful in the
browser.

## Decision

There is one browser owner for each kind of state:

- the URL and small component-local values own requested identity and
  interaction intent;
- TanStack Query owns remote results, request status, errors, freshness,
  cancellation, deduplication, retained data, invalidation, mutation state,
  hydration, and collection;
- the contract-first oRPC client is the typed browser/Web transport and owns no
  freshness or visibility decisions;
- SvelteKit server loads may prefetch the same named Query options for an
  initial document and dehydrate their bounded successful data;
- an EventSource adapter owns its one connection while publishing its latest
  bounded source snapshot into Query; explicit upload/download endpoints remain
  outside ordinary JSON Query procedures.

The root Svelte tree creates one long-lived browser `QueryClient`, one oRPC
contract client, and one generated oRPC Query utility tree. Server prefetches
create isolated request clients and clear them after dehydration. Route loads
must not create a browser client. Report, Skills, and Sync server loads await
bounded data for document requests and return only an empty hydration delta for
SPA entry, allowing the persistent browser cache to answer immediately.

Named policies define freshness rather than components:

- current report aliases use a 30-second stale-while-revalidate policy plus
  publication invalidation;
- finite Skills, quota, and similar reads use a 30-second SWR policy;
- skill observations use one-minute `collection-swr` revalidation plus
  publication invalidation, focus revalidation, and unconditional mount
  revalidation. Their server-provided proof deadline defines a data-aware stale
  time capped at one minute, and stale or in-flight retained data is qualified
  as provisional (ADR 0037);
- bounded control snapshots use their short named policy;
- exact report and Session values include immutable revision and canonical
  request identity, remain fresh indefinitely, and have bounded garbage
  collection.

The report destination is one composite Query result containing its descriptor,
Overview, and optional Breakdown or complete requested Session window. A result
becomes visible only when every required exact leg validates at the same
revision. TanStack supersession/cancellation prevents late destinations from
publishing. One typed expiry retry refreshes the current bootstrap; a failed
background refresh retains the last complete Query value.

Session pages remain in exact infinite-query data. Components may retain only
requested depth, expansion, selection, focus, and virtualization intent. Detail,
neighbors, and VCS are dependent exact queries, not controller-owned result
snapshots.

Mutations use Query mutation observers. Successful responses update or
invalidate only named exact families. Skills drafts, dirty/conflict decisions,
focus, navigation blocking, and success copy remain local because they are user
interaction state, not server state.

## Consequences

- Fresh tab revisits render cached data with zero business RPC calls.
- Stale values stay visible while refetching instead of replacing a complete
  page with a loading surface.
- Initial documents may contain as much bounded, contract-approved data as is
  useful for first paint, subject to ADR 0007's privacy exclusions.
- A completed publication cycle invalidates the current report aliases and, since
  ADR 0022, the skill-observation identity that the same cycle writes. Immutable
  revisions, the Skills snapshot, Sync, and quota are not swept. The trigger is
  the cycle rather than a new revision: a cycle that leaves the report rows
  unchanged renews the current revision, which still moves the manifest's
  `publishedAt` and `expiresAt`.
- SvelteKit route-data requests used for SPA routing may still occur, but they
  contain no prefetched business result and do not rebuild a Query client.
- Ownership is enforced by static scans, Query lifecycle tests, hydration
  tests, and Playwright operation counts.

## Rejected alternatives

- Keeping `ServedReportSession` and Session table owners around Query was
  rejected because it leaves two caches and two lifecycle authorities.
- Treating SvelteKit page data as a navigation cache was rejected because it
  blocks SPA transitions and discards the long-lived browser cache.
- Moving report reads onto the usage-engine control listener was rejected; Web
  continues direct bounded read-only SQLite access.
