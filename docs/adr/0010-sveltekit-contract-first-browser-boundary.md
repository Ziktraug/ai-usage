# ADR 0010: SvelteKit with a contract-first browser boundary

- **Status**: Proposed. Acceptance withdrawn 2026-08-05: the presentation-parity
  evidence below was invalidated by a maintainer-reported Activity regression. The
  transport, boundary, SSR/hydration, cache-ownership and lifecycle decisions this
  ADR records are unaffected and remain in force.
- **Date**: 2026-08-02
- **Amends**: the Web framework and browser transport only
- **Preserves**: ADR 0007 and ADR 0009 (sole-writer usage engine and direct SQLite readers)
- **Superseded in part by**: ADR 0012 for browser report visibility, retry,
  paging, replay, mutation state, and SPA cache ownership

## Context

The Solid Web application composes routing, SSR, TanStack Start server
functions, Query defaults, and hand-written coordinators. Those pieces work,
but they do not mechanically establish which data is request-scoped, which
cache policy owns a read, or whether public browser code can reach a server
implementation. Nitro/Vite also carries Web-specific server-function warmup,
hydration, output, and long-lived SSE workarounds.

The product remains a trusted local Bun application. It does not need a report
service between local readers and SQLite, and the migration must not turn the
usage-engine operational listener into one.

## Decision

Svelte 5 and SvelteKit own Web routing, SSR, hydration, server-only module
enforcement, endpoints, and hooks. Components use runes syntax where reactive
component state is actually required. Existing framework-neutral domain and
controller modules remain the behavior owners rather than being translated
into component effects.

The browser-to-Web application boundary is a pure contract-first oRPC contract.
Browser code imports only contract values, runtime schemas, closed public
errors, and its client adapter. It never imports or infers types from the server
router. Router implementations and request capabilities remain in SvelteKit
server-only modules. The independent repository graph checker backs up
SvelteKit's build-time boundary, including `.svelte` source and transitive,
re-exported, and dynamic imports.

Every procedure runtime-validates input and output. Public errors are a closed,
sanitized set; raw paths, SQLite details, engine credentials, rendezvous data,
stack traces, and arbitrary exceptions do not cross the browser boundary.
Transport leaves adapt the existing deep server modules and do not copy SQL,
filesystem workflows, served-revision coordination, or engine-control logic.

TanStack Svelte Query owns browser server-state, with one named policy per data
identity. QueryClient and oRPC clients are request/navigation scoped; no module
global client, request event, cache, or QueryClient is permitted. Universal
loads await critical prefetches and dehydrate the exact keys components use, so
hydration does not duplicate the request. Current aliases may be invalidated by
a newer publication, but immutable revision/fingerprint keys are never swept.
Skills, quota, Sync, and source control retain independent ownership.

The following lifecycle paragraph records the migration-era decision and is
superseded by ADR 0012; it is retained as historical context.

TanStack Query owns request execution, exact query keys, immutable result
caching, cancellation, deduplication, and named freshness/garbage-collection
policies. It does not decide which report revision becomes visible.
`ServedReportSession` owns descriptor acquisition, destination identity,
supersession, exactly one expiry retry, preservation of the last complete
result, and atomic visible commit. The Session table query owner owns bounded
paging and transaction-owned replay under the same lifecycle. Svelte component
state is only a replacement-only projection of the accepted immutable snapshot.

The universal root layout intentionally tracks the navigation URL so SvelteKit
propagates live search state and back/forward restoration. The report page
captures the RPC origin and document-scoped parent metadata with
`LoadEvent.untrack`; filter, sort, range, and destination changes therefore do
not reacquire a bootstrap through a route load or request `__data.json`. The
browser destination still intentionally acquires exactly one current bootstrap
for each transition.

SvelteKit remote functions and application server/form actions are not the RPC
layer. Native actions remain available only for a future explicitly reviewed
progressive-HTML form requirement.

## Preserved data and control planes

ADR 0009 remains authoritative:

- Web and CLI open compatible SQLite stores directly through read-only,
  `query_only` readers and execute bounded current/exact-revision queries.
- `apps/usage-engine` remains the sole production writer for migrations,
  collection, publication, retention, and usage-domain mutations.
- The authenticated numeric-loopback engine listener carries only command,
  status, and bounded sanitized SSE events. oRPC does not extend to the engine,
  CLI, SQLite, or filesystem.
- Web cannot import `@ai-usage/usage-merge` or usage-engine-runtime. Runtime and
  build adapters reuse `@ai-usage/usage-engine-control/node` identity,
  ownership, process-start, and liveness helpers.

ADR 0007 also remains authoritative: `/` SSR embeds the bounded support
bootstrap for one immutable revision, including a compatible last publication
when the engine is unavailable. Destination reads continue after hydration
against that exact revision. `/skills` gains an equivalent awaited snapshot
prefetch without acquiring live filesystem state in demo mode.

## Explicit non-RPC transports

Source control remains an explicit bounded EventSource endpoint. The Web
adapter delegates snapshot waiting and event fan-out to the existing engine
broker/control stream; Query and oRPC do not own its lifecycle.

Manual merge upload and download remain explicit HTTP file endpoints with
existing byte, path, content-disposition, trust, abort, opaque-ID, and cleanup
guarantees. Upload staging receives the request AbortSignal, races cancellation,
cleans a staging result that completes after abort, and retains the existing
identity-validated recovery when detached cleanup cannot finish. Ordinary RPC
JSON never carries file bytes.

## Consequences

- Routing, request scope, browser/server reachability, and cache ownership
  become mechanically testable rather than conventional.
- The contract is a deep interface hiding acquisition, runtime mode, SQLite,
  filesystem, observability, engine control, and HTTP mechanics.
- Solid and Svelte coexist only during the additive migration. Solid stays the
  production authority until the parity ledger, operational gates, and final
  dependency/client-manifest scans pass; the retired stack is then removed
  atomically.
- Routes, URL/default/legacy behavior, calculations, copy, accessibility,
  keyboard/focus behavior, responsive geometry, Panda semantics, demo privacy,
  and local trust do not change as part of this decision.
- This ADR becomes Accepted only after Plan 068's cutover and final green gates.

## Rejected alternatives

- Keeping TanStack Start/Nitro behind Svelte components was rejected because it
  preserves the overlapping routing, transport, and lifecycle owners.
- SvelteKit remote functions or actions as the application API were rejected
  because they would make framework implementation the browser contract.
- Inferring client types from the oRPC server router was rejected because it
  gives browser code a transitive implementation seam.
- Moving report reads to the usage engine, browser SQLite, or a new
  REST/GraphQL/tRPC data service was rejected by ADR 0009 and remains out of
  scope.
- Hiding SSE or files in ordinary RPC/Query was rejected because their stream,
  abort, byte, cleanup, and backpressure semantics are explicit interfaces.

## Evidence required for acceptance

Plan 068 is integrated through implementation checkpoint
`ac63cf8bb2e4623d62f949d2991a853b3e4826f7`. It includes atomic combined
Overview/Sessions revision handling, retained report DOM during refresh,
replacement-only immutable Session state, search-navigation load isolation, and
a complete 113/113 Playwright-title inventory. Independent X2 review ACCEPTed
both required axes. The sole draft implementation PR `#27` passed all five
Actions lanes in run `30947971788`, attempt 3, including 98/98 functional
browser tests.

- [Plan 068](../../plans/068-migrate-web-to-sveltekit-orpc.md)
- [ADR 0007](0007-server-render-report-bootstrap.md)
- [ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
- Wave-0 parity ledger (retired after cutover; acceptance evidence remains in
  Plan 068 and its execution state)
- [Wave-0 performance baseline](../performance/web-framework-migration-baseline.md)
- Contract, boundary, SSR/hydration, cache-policy, demo, production lifecycle,
  long-SSE, file-transfer, browser, scale, and client-manifest gates named by
  Plan 068

The operation ledger and retired Solid/TanStack Start/Nitro scanners were
migration acceptance scaffolding. Plan 070 removed their executable forms after
cutover; current request-policy tests and capability-based client-manifest checks
own the lasting boundaries.
