# Plan 069: Centralize Web server-state ownership in TanStack Query and oRPC

> **Executor instructions**: Read this plan completely before editing code. Run
> each gate in order and do not begin the next gate until the current one is
> green. This is an ownership migration, not a visual rewrite. Preserve the
> current UI, direct SQLite data plane, exact-revision protocol, demo privacy,
> and explicit file/SSE transports. If a STOP condition occurs, stop and report
> it instead of adding another coordinator or compatibility owner.
>
> **Drift check (run first)**:
> `git diff --stat c1eef7b0..HEAD -- apps/web/src/lib/query apps/web/src/lib/features/report apps/web/src/lib/features/sessions apps/web/src/lib/features/skills apps/web/src/lib/features/sources apps/web/src/lib/features/sync apps/web/src/routes packages/web-contract docs/adr docs/architecture.md`
> This plan was written at `c1eef7b0` after also inspecting the uncommitted
> 2026-08-07 data-loading worktree. Do not execute it from that mixed worktree.
> First integrate or deliberately discard the active Plan 068/data-loading
> changes and record the resulting clean baseline SHA in this plan. Sidebar,
> navigation, shell styling, icons, and visual snapshots are outside this plan;
> concurrent work in those paths is not a reason to edit them here.

## Status

- **Priority**: P1
- **Effort**: XL, delivered as gated vertical slices
- **Risk**: HIGH
- **Depends on**: Plan 068's integrated SvelteKit/oRPC/Query foundation and a
  clean checkpoint for the active 2026-08-07 worktree
- **Category**: architecture, performance, correctness, tests, dx
- **Planned at**: commit `c1eef7b0`, 2026-08-07; current dirty worktree also
  inspected and must be reconciled before execution
- **Status**: TODO

## Why this matters

The SvelteKit rewrite installed the right pieces but did not finish the
ownership transfer. TanStack Query currently caches many oRPC results, while
hand-written owners still decide when those results are requested, copied,
cancelled, retried, replayed, and made visible.

The split is concrete:

- `apps/web/src/lib/query/composition.ts:34-70` declares Query ownership, but
  `createWebQueryRuntime` at lines 73-94 creates new request-local clients for
  route-prefetch paths.
- `apps/web/src/lib/query/options/report.ts:47-103` gives current and exact
  report reads Query keys and policies, but
  `apps/web/src/lib/features/report/composition/report-destination.ts:283-350`
  imperatively calls `fetchQuery` from a second lifecycle.
- `apps/web/src/served-report-session.ts:38-99` separately owns request IDs,
  abort, expiry retry, last-good retention, and visible commit.
- `apps/web/src/lib/features/sessions/table/session-table-query-owner.ts:192`
  starts another state machine for page data, page depth, campaign expansion,
  revision recovery, replay, and publication.
- Svelte components project those accepted results into local `$state`, so
  changing a tab or report key can rebuild most of the page even when Query has
  useful cached data.
- `@orpc/svelte-query` is installed but unused. One-to-one procedure keys and
  options are manually duplicated instead of being derived from the contract
  client.
- Current aliases are event-invalidated and fresh forever. That avoids repeated
  bootstraps, but it is not a bounded SWR fallback when an event is missed.

The result is neither a clean Query architecture nor a clean coordinator
architecture. Query owns the transport cache, but feature owners still behave
like a second cache. This plan makes TanStack Query the only browser server-state
owner and leaves oRPC as the typed browser/Web transport.

## Decision: one owner per kind of state

| Concern | Sole owner | May do | Must not do |
| --- | --- | --- | --- |
| Requested report destination | URL plus small component-local UI intent | Hold tab, filters, sort, selected row, requested page depth and expanded campaign IDs | Hold server results, revision descriptors, cursors returned by the server, or request status |
| Browser server state | TanStack Query | Cache, deduplicate, cancel, retry, expose status/error, retain placeholder data, hydrate, invalidate, update after mutations, and garbage-collect | Delegate visible-result ownership to a feature state machine |
| Browser/Web calls | oRPC contract client | Validate typed inputs/outputs/errors and execute bounded procedures with `AbortSignal` | Decide freshness, visible revision, retries, or UI state |
| Query identities and policies | `apps/web/src/lib/query/**` | Derive one-to-one keys/options from `@orpc/svelte-query`; define the few composite report queries that call multiple procedures atomically | Import Svelte components or create feature-local caches |
| Initial SSR | SvelteKit server `load` plus a request-scoped QueryClient | Prefetch the exact same Query options used in the browser and dehydrate successful data for a document request | Own navigation freshness, return a second domain DTO, or block SPA navigation when the browser cache can answer |
| Visible report revision | The successful report-destination Query result | Expose one descriptor plus its complete Overview/Breakdown/Sessions-first-window result | Copy that result into `ServedReportSession`, `$state`, or another commit layer |
| Exact-revision recovery | One narrow Query recovery policy | On typed `RevisionExpired`, invalidate the current bootstrap once for the failed `(revision, destination fingerprint)` and let dependent Query keys change | Store data, issue its own exact reads, retry indefinitely, or write new-revision data under an old-revision key |
| Session paging | TanStack infinite queries plus component-local depth/expansion intent | Cache pages/cursors and replay the requested visible depth under a new exact revision before the destination Query becomes successful | Keep a parallel rows/map/cursor snapshot in a `SessionTableQueryOwner` |
| Mutations | TanStack mutations generated from oRPC utilities | Expose pending/error state and update or invalidate the smallest named keys | Call oRPC from a component controller and manually maintain unrelated cache entries |
| Publication/control events | Explicit EventSource connection adapter | Maintain connection/reconnect state, write a bounded snapshot to Query, and invalidate named current aliases | Fetch report payloads, sweep immutable keys, or own report visibility |
| Domain consistency and data access | Existing Web server facades and read-only SQLite readers | Validate fingerprints/revisions, assemble bounded results, preserve immutable revisions | Move report data onto the usage-engine control listener |
| File transfer | Existing explicit HTTP endpoints | Stream bounded uploads/downloads with current trust and abort guarantees | Encode files as Query/oRPC JSON |

SvelteKit, Query, and oRPC therefore form a pipeline rather than three competing
caches:

```text
URL / local UI intent
        |
        v
TanStack Query observer ---- stale/placeholder/error/pending/visible result
        |
        +---- @orpc/svelte-query options ---- one procedure
        |
        +---- composite queryFn ------------ atomic report destination
                         |
                         v
                    oRPC client
                         |
                         v
              existing Web server facade
                         |
                         v
                 read-only SQLite
```

## Data classes and freshness policy

1. **Current aliases**: report bootstrap/manifest and current control snapshots
   use bounded stale time, background refetch, and event-driven invalidation.
   They retain data while refetching. Missing an SSE event may delay freshness
   only until the bounded fallback expires; changing a dashboard tab must not
   synchronously reacquire them.
2. **Immutable exact results**: report destinations, Session pages/details,
   and revision-keyed support use `staleTime: Infinity`, bounded `gcTime`, no
   focus/reconnect refetch, and a key containing revision plus canonical request
   identity. New publication means a new key, never invalidation of old exact
   keys.
3. **Finite SWR reads**: Skills inventory/documents, Sync fleet, quota, and
   source snapshots show cached data immediately and revalidate in background
   after their named finite stale time.
4. **Mutations**: use generated mutation options and update/invalidate only
   explicit family keys after a successful typed response.
5. **Streams and files**: EventSource and file endpoints remain transports, not
   ordinary Query functions. The latest bounded EventSource snapshot is stored
   in Query; connection mechanics and file bytes are not.

The exact stale times are a policy choice, not component behavior. Begin with
30 seconds for finite reads and current aliases, retain the existing bounded GC,
and measure. Any different number must be justified in the execution log with a
network/freshness measurement; do not introduce per-component numbers.

## Target report lifecycle

The report uses two dependent Query layers and no visible-commit state machine:

1. `reportBootstrapQueryOptions` returns the current descriptor. It is a
   bounded/event-invalidated current alias and remains visible while refetching.
2. `reportDestinationQueryOptions` is keyed by descriptor revision, canonical
   destination fingerprint, and Session window intent. Its `queryFn` validates
   and awaits the whole visible destination:
   - Overview: Overview only;
   - Breakdown: Overview and Breakdown in parallel;
   - Sessions: Overview plus every top-level/campaign page required by the
     current window intent.
3. The destination query uses guarded previous data as placeholder data. It may
   reuse the prior result only when it is a fully validated report destination;
   the UI reads `isPlaceholderData` to show non-blocking refresh affordance.
4. A destination result becomes visible only when the composite query succeeds.
   TanStack observer key changes provide supersession and cancellation. No
   `onCommit`, mirrored `$state`, or request ID is permitted.
5. A typed expiry invalidates the current bootstrap once. The new bootstrap
   yields a new exact destination key. The old complete Query result stays
   visible until the new exact key succeeds. Never place a response for revision
   B in revision A's cache entry.
6. A non-expiry error retains the last complete Query result and exposes the
   error locally; it must not replace the report subtree with a page-sized
   loading or failure surface.

Session window depth and expanded campaign IDs are interaction intent, not
server state. Keep those small serializable values local. All returned rows,
counts, cursors, pages, loading flags, and errors live in Query. Use
`createInfiniteQuery`/oRPC `infiniteOptions` for the page families. Before the
outer destination query succeeds for a new revision, ensure those infinite
queries have replayed the requested depth. Exact cached pages mean increasing
depth normally fetches only the new cursor page.

## Scope

### In scope

- Query runtime, policies, keys, generated oRPC Query utilities, hydration, and
  ownership tests under `apps/web/src/lib/query/**`.
- Report bootstrap/destination composition and report route SSR prefetch.
- Session page/campaign paging and exact-revision recovery.
- Session detail/neighbors/VCS reads where they still use imperative owners.
- Skills, Sync, quota-rail/history, and source snapshot reads/mutations.
- oRPC contract/router additions only when a browser-visible finite server read
  currently exists solely in SvelteKit route data, notably the provider quota
  rail.
- ADR 0010/architecture updates through one superseding ADR.
- Network-count, hydration, last-good, exact-revision, and cache-boundary gates.

### Out of scope

- Sidebar/navigation layout, icons, styling, screenshots, chart rendering, and
  other Plan 068 presentation work.
- Changes to report math, fingerprints, revision lease duration, SQLite schema,
  writer ownership, usage-engine scheduler, or control-plane authentication.
- Moving report reads from direct read-only SQLite to the usage engine.
- Replacing explicit EventSource or file-transfer endpoints.
- A new state library, Svelte stores mirroring Query data, optimistic product
  behavior not already present, or a general oRPC contract redesign.

## Files expected to change

- `apps/web/src/lib/query/composition.ts`, `client.ts`, `policies.ts`, `keys.ts`,
  `publication.ts`, their tests, and new focused Query orchestration modules.
- `apps/web/src/lib/query/options/{report,session,skills,sync,quota}.ts` and tests.
- `apps/web/src/lib/rpc/client.ts` to expose one
  `createORPCSvelteQueryUtils(...)` tree alongside the contract client.
- `apps/web/src/lib/features/report/{core,composition,lifecycle}/**` only for
  data ownership and rendering status.
- `apps/web/src/lib/features/sessions/{table,detail}/**` only for Query adapters.
- `apps/web/src/lib/features/{skills,sources,sync}/**` only for Query consumers.
- report/Skills/Sync/root route load files only for SSR prefetch and hydration.
- `packages/web-contract/src/report.ts` and the matching Web router only if the
  quota rail needs a bounded browser contract.
- `docs/adr/0012-tanstack-query-browser-server-state-ownership.md`,
  `docs/architecture.md`, affected `INTEGRATION.md` files, and this plan's row.

Delete after their replacement gates pass:

- `apps/web/src/served-report-session.ts` and its tests;
- `apps/web/src/lib/features/report/lifecycle/served-report-session-owner.svelte.ts`
  and its tests/fixture;
- `apps/web/src/lib/features/report/lifecycle/report-lifecycle-owner.svelte`;
- `apps/web/src/lib/features/report/composition/focused-destination-refresh.svelte`;
- `apps/web/src/lib/features/report/composition/session-destination-refresh.svelte`;
- `apps/web/src/lib/features/sessions/table/session-table-query-owner.ts` and its
  state-machine tests after equivalent Query tests are green;
- `apps/web/src/session-query-operation-owner.ts` if no remaining consumer exists.

Do not delete validation/fingerprint helpers merely because their current file
also contains an owner. Move pure helpers to the Query or domain composition
module with tests.

## Gate 0: Stabilize the baseline and freeze observable behavior

1. Wait for the active worktree to be integrated into a clean commit. Record
   that SHA and the relation to Plan 068 in this plan's execution log.
2. Confirm no in-scope file is simultaneously owned by the sidebar session.
   Sidebar-only files are excluded; an overlap in report/query/routes is a STOP.
3. Run the existing targeted Query, report lifecycle, Session owner, route-load,
   Skills, Sync, and source provider tests before editing.
4. Add/extend Playwright instrumentation that counts `__data.json` and oRPC
   procedure calls by operation. Capture, without weakening assertions:
   - direct document load;
   - Overview -> Breakdown -> Sessions -> Overview;
   - filter/range/sort changes and back/forward;
   - a publication while a destination request is pending;
   - one exact-revision expiry;
   - a failed background refresh;
   - navigation among Skills children and Report/Skills/Sync.
5. Record DOM identity for the report workspace and graph across those actions.
   This plan permits data updates, not remounting the complete report subtree.

**Gate 0 passes when** the baseline tests are green, request counts and DOM
identity are recorded, and the clean baseline SHA is written below. Do not claim
an improvement yet.

## Gate 1: Establish the Query/oRPC kernel

1. Create one oRPC Svelte Query utility tree with
   `createORPCSvelteQueryUtils` from the injected request/browser contract
   client. Do not create a module-global client.
2. Derive one-to-one query keys, `queryOptions`, `infiniteOptions`, and
   `mutationOptions` from that utility. Domain wrappers may add named policies,
   validation, `select`, or placeholder guards, but must not invent a second
   transport key.
3. Add a `current-alias-swr` policy: bounded stale time, retained data,
   background refetch on reconnect/focus, event invalidation, and no retry storm.
   Keep immutable exact policies infinite-stale and revision-keyed.
4. Make the browser QueryClient long-lived under the root provider. Server
   prefetch clients remain request-scoped and are cleared after dehydration.
   Client-side route loads must not create a competing QueryClient.
5. Add an executable ownership/boundary test. After final convergence it must
   permit imperative `fetchQuery`, `ensureQueryData`, `fetchInfiniteQuery`, and
   `fetchNextPage` only inside `lib/query/**` and server prefetch helpers. Feature
   components and controllers may create/consume observers and mutations, but
   may not orchestrate raw cache reads.
6. Test key stability, input canonicalization, abort propagation, deduplication,
   current-alias SWR, immutable non-refetch, GC, hydration timestamps, and
   request isolation.

**Gate 1 passes when** the Query kernel tests are green, two identical oRPC
calls share one key/request, server requests have isolated clients, and a stale
current alias renders cached data during its background request.

## Gate 2: Move the complete report destination into Query

1. Build `reportDestinationQueryOptions` with the target lifecycle above. Keep
   the query result as one immutable value containing descriptor, destination,
   Overview, and the optional Breakdown or Session-window identity.
2. Use one observer in the live report composition. Render directly from
   `query.data`; derive pending/error/placeholder status from Query. Remove the
   local `commit`, deferred remote result, and manual refresh effects.
3. Implement exactly one expiry recovery policy. Characterize TanStack's
   placeholder-on-error behavior first. If Query cannot preserve previous data
   on failure without a local result mirror, STOP and deepen the Query design;
   do not retain `ServedReportSession` as a fallback.
4. Initial SSR prefetches the same bootstrap and destination options. Document
   requests receive dehydrated data; search/tab/range SPA transitions do not
   request route data and do not construct a route QueryClient.
5. Keep dynamic component chunks independent from data ownership. A lazy
   Breakdown/Sessions module may delay its own code, but must not receive or
   stage a second remote result.
6. Delete `ServedReportSession` and its Svelte lifecycle adapter only after
   equivalent Query tests cover same destination, supersession, expiry,
   last-good failure, and atomic Overview/secondary-leg visibility.

**Gate 2 passes when**:

- revisiting a cached destination performs zero oRPC data requests while fresh;
- a stale destination keeps its complete prior subtree visible during
  background revalidation;
- rapid A -> B -> C navigation can display only A or C, never late B;
- Overview and Breakdown/Sessions never expose different revisions;
- expiry causes one bootstrap refresh and one new exact-key attempt;
- no search/tab/range transition requests `__data.json`;
- the report workspace DOM node remains identity-stable across tab changes;
- there is no production import of `served-report-session`.

## Gate 3: Move Session paging and detail into Query

1. Replace top-level and campaign page state with oRPC `infiniteOptions` keyed
   by exact revision plus canonical scope. Returned cursors and pages remain only
   in `InfiniteData`.
2. Keep requested page depth and expanded campaign IDs as small UI intent. The
   outer destination query ensures the requested depth is present before a new
   revision becomes visible, reusing immutable cached pages.
3. Port load-more, campaign expansion, unfiltered campaign sessions, and
   revision replay tests from `SessionTableQueryOwner` to Query-level tests.
4. Migrate detail, neighbors, and VCS owners to ordinary dependent queries.
   Selection/history remains UI state; fetched detail and operation status do
   not.
5. Delete the table/operation owners after the new scale, expiry, abort, and
   replay tests pass.

**Gate 3 passes when**:

- loading page N makes one new page request, not N repeated network requests;
- concurrent load-more is deduplicated and aborts on destination change;
- publication/expiry preserves the requested top-level and campaign depth and
  swaps Overview plus the complete visible Session window atomically;
- 5,000-row DOM, heap, keyboard, mobile, and request budgets do not regress by
  more than 10% without an explained measurement;
- no component-local rows, cursor maps, remote loading flags, or
  `SessionTableQueryOwner` remain.

## Gate 4: Converge all other finite server state

1. Migrate Skills reads and writes to generated Query/mutation options. Keep
   editor draft, dirty/conflict choice, focus, and navigation blocking local;
   inventory, documents, mutation results, and pending/error state belong to
   Query.
2. Move Skills SSR prefetch to a document-only server path. Child Skills
   navigation reads the long-lived browser cache and revalidates in the
   background; it must not rebuild/hydrate a route QueryClient.
3. Keep Sync fleet as finite SWR under one key. Document SSR may prefetch it;
   SPA entry must render from/cache-fill through the browser observer without a
   blocking route-data round trip.
4. Put quota rail/history behind oRPC Query. Add a small bounded quota-summary
   procedure only if the history contract cannot serve the rail without
   overfetching. Remove browser-visible quota payload ownership from the root
   SvelteKit layout.
5. Keep one EventSource connection, but write its latest bounded source snapshot
   to a Query key. Commands use Query mutations. Publication invalidates only
   the report bootstrap/manifest aliases; the dependent destination observer
   selects the new exact-revision key after the descriptor changes. Immutable
   exact entries, Skills, Sync, and quota stay untouched.
6. Convert successful mutation cache writes to typed helpers next to their
   family options. No controller may update a stringly related key.

**Gate 4 passes when** each family has one named owner/policy, stale data remains
rendered while refetching, mutation pending/error comes from Query, Skills
drafts survive refreshes, and invalidation tests prove zero unrelated refetches.

## Gate 5: Delete compatibility ownership and document the final design

1. Run the ownership scan and delete obsolete lifecycle files, adapters,
   fixtures, route DTO helpers, and unused manual keys.
2. Add ADR 0012. It supersedes only ADR 0010's browser ownership clauses that
   assign visibility/retry/replay to `ServedReportSession` and the Session table
   owner. It preserves ADR 0002 immutable focused revisions, ADR 0007 bounded
   SSR bootstrap, ADR 0009 direct read-only SQLite/sole writer, and ADR 0010's
   SvelteKit/oRPC/security decisions.
3. Update `docs/architecture.md` and affected `INTEGRATION.md` files to state:
   SvelteKit prefetches, oRPC transports, Query owns browser server state, URL
   owns requested identity, and components own only interaction state.
4. Update Plan 068's execution-state prose or add a reconciliation note; do not
   rewrite its historical record as if `ServedReportSession` never shipped.
5. Update this plan's row to DONE only after the integrated functional,
   production, scale, privacy, and static ownership gates pass.

**Gate 5 passes when** repository search finds no retired owner, docs match the
code, all final commands below pass from a clean worktree, and measured tab
transitions satisfy the acceptance budgets.

## Acceptance budgets

| Scenario | Required outcome |
| --- | --- |
| Hydrated initial Report | No duplicate bootstrap/destination call; meaningful SSR HTML |
| Fresh Overview -> Breakdown -> Overview | First unseen destination may call its exact procedures; return to Overview makes zero data calls |
| Stale cached destination | Existing complete subtree remains visible; request is background-only |
| Rapid destination changes | Obsolete work is aborted/superseded; no obsolete commit |
| Publication | One current-alias refresh; active destination moves atomically; zero immutable-key sweeps |
| Search/filter/range/sort | No `__data.json`; no page-sized loading replacement |
| Skills child navigation | No snapshot/inventory reacquisition while fresh; dirty document unchanged |
| Report/Skills/Sync SPA navigation | Browser QueryClient identity remains stable; cached families render immediately |
| Session load more | One new cursor request; prior pages retained |
| Failed background refresh | Last complete result retained with local retry/error affordance |
| Cache lifetime | Exact/finite entries are collected within the named bounded GC policy after becoming inactive |

## Verification commands

Run focused commands at each gate, then the full suite at Gate 5:

```sh
bun test apps/web/src/lib/query
bun test apps/web/src/served-report-session.test.ts
bun test apps/web/src/lib/features/report/composition/report-destination.test.ts
bun test apps/web/src/lib/features/sessions/table/session-table-query-owner.test.ts
bun test apps/web/src/lib/features/sessions/detail/query-owner.test.ts
bun test apps/web/src/routes/report-load-invalidation.test.ts
bun test apps/web/src/lib/features/skills
bun test apps/web/src/lib/features/sync
bun test apps/web/src/lib/features/sources
bun run --cwd apps/web typecheck
bun x ultracite check
git diff --check
```

After the retired files disappear, replace their direct commands with the new
Query lifecycle test paths in this plan. Final integrated gate:

```sh
bun run check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:web-client-manifest
bun run test:e2e
bun run test:e2e-demo
bun run test:e2e-production
git diff --check
```

All commands exit 0. Stop every development/preview/production process and
confirm its port is reusable before marking DONE.

## Test plan

- Pure Query tests cover key identity, policy selection, guarded placeholder
  compatibility, hydration timestamps, request isolation, current-alias SWR,
  immutable non-refetch, expiry recovery, cancellation, and GC.
- Composite report tests cover Overview/Breakdown/Sessions atomicity,
  supersession, one expiry refresh, last-good failure, and wrong
  revision/fingerprint rejection.
- Session Query tests cover page dedupe, cursor progression, expansion,
  requested-depth replay, new-revision replacement, expiry during incremental
  paging, and 5,000-row memory/request budgets.
- Route tests prove document-only prefetch, no SPA `__data.json`, one browser
  QueryClient, request-scoped server clients, and no hydration duplicate.
- Mutation tests prove smallest-key cache updates and no unrelated invalidation.
- Playwright network/DOM tests prove the acceptance table from a user's
  perspective in live-compatible deterministic fixtures.
- Demo tests prove no real oRPC/SQLite/filesystem/source-control acquisition.
- Production tests preserve direct SQLite, exact revision, sole writer,
  shutdown, and port-reuse behavior.

## Done criteria

- [ ] TanStack Query is the only browser owner of remote result, request, error,
      freshness, placeholder, retry, invalidation, and mutation state.
- [ ] One-to-one procedure options use `@orpc/svelte-query`; composite options
      exist only for atomic multi-procedure report reads.
- [ ] SvelteKit server loads only prefetch the same Query identities for initial
      SSR and do not act as a client-navigation cache.
- [ ] Current aliases have bounded SWR fallback plus event invalidation.
- [ ] Immutable results remain revision/fingerprint keyed and never refetch from
      publication invalidation.
- [ ] `ServedReportSession`, `SessionTableQueryOwner`, and their mirrored remote
      state are deleted.
- [ ] Exact-revision supersession, one expiry recovery, last-good retention,
      atomic visibility, and loaded-depth replay remain covered and green.
- [ ] Skills, Sync, quota, source snapshots, Session detail, and mutations obey
      the ownership matrix.
- [ ] Sidebar/navigation/presentation and the direct SQLite/control/file/SSE
      boundaries are unchanged.
- [ ] Acceptance budgets and every final verification command pass.
- [ ] ADR 0012, architecture/integration docs, Plan 068 reconciliation, and the
      plans index match the shipped code.

## STOP conditions

Stop and report if:

- the active dirty worktree is not integrated into a clean, attributable
  baseline or another session owns an in-scope report/query/route file;
- previous complete data cannot be retained on a failed/stale Query transition
  without reintroducing a second result store;
- exact data for a new revision would be written under an old revision key;
- atomic Overview/Sessions visibility or loaded-depth replay would be weakened;
- a proposed fix moves report data to the usage-engine listener, adds a writer
  to Web, changes revision leases/fingerprints, or crosses private boundaries;
- oRPC utilities cannot preserve canonical domain keys or `AbortSignal`
  propagation; deepen the adapter or amend the plan instead of using `any` or
  unchecked casts;
- initial SSR requires a module-global QueryClient/client/request event;
- source SSE or file bytes must be hidden inside ordinary JSON Query procedures;
- the work requires sidebar/navigation styling or a presentation redesign;
- an acceptance budget regresses by more than 10% without a measured,
  documented reason and explicit plan amendment;
- any gate fails twice after one focused correction.

## Maintenance notes

New finite browser reads must enter through the oRPC contract, receive one
named Query identity/policy, and be consumed from Query. A feature may own local
interaction intent, but never a copy of remote data or its request lifecycle.
New streams and files require an explicit transport decision; they do not
silently become exceptions. Keep the ownership boundary test updated when a new
family is added.

## Execution log

- 2026-08-07 — Plan drafted at `c1eef7b0` after inspecting the active dirty
  SvelteKit/data-loading worktree. The observed architecture already has named
  Query policies and exact keys, but report visibility and Session replay remain
  owned by parallel state machines. Execution has not started. The first
  required entry is the clean reconciled baseline SHA and Gate 0 measurements.
