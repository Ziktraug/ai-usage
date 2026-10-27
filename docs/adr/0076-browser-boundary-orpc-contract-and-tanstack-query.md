# ADR 0076: Browser boundary: oRPC contract + TanStack Query, derived once

- **Status**: Accepted; "Derive once" implemented 2026-10-27 (plan 120 phase B,
  amendment below)
- **Date**: 2026-10-24
- **Supersedes**: [ADR 0010](0010-sveltekit-contract-first-browser-boundary.md) and
  [ADR 0012](0012-tanstack-query-browser-server-state-ownership.md), consolidated
  here; both keep their history
- **Carries**: [ADR 0037](0037-current-producers-and-durable-skill-invocations.md)'s
  amendment of ADR 0012 (the `collection-swr` policy)
- **Preserves**: [ADR 0002](0002-immutable-focused-report-revisions.md),
  [ADR 0007](0007-server-render-report-bootstrap.md),
  [ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md),
  [ADR 0020](0020-bundle-ceiling-and-drift-guard.md)

## Context

ADR 0010 chose SvelteKit with a contract-first oRPC boundary. Six days later
ADR 0012 moved request, cache and visibility lifecycle to TanStack Query and
superseded part of 0010. A reader needs both, and 0010's surviving text
contradicts the code: it says the QueryClient and oRPC clients are
request/navigation scoped and that universal loads prefetch, while the browser
holds one long-lived QueryClient (`apps/web/src/lib/query/provider.svelte`) and
the report prefetches in a server load
(`apps/web/src/routes/(report)/+layout.server.ts`).

The boundary has one consumer, `apps/web`, and 48 procedures (pinned in
`apps/web/src/lib/server/rpc/handler.server.test.ts`). Sixteen of them leave
with ADR 0049 on `feat/work-resume-cockpit` and plan 120 phase B
(`sessionDistillation.*`, `memory.*`, `projects.*`, `replication.status`).
Adding one procedure touches the contract module, its server router module,
`router.ts`, an entry in `request-policy.ts` that restates the method and error
families the contract already declares, `rpcPathByOperation` in
`request-policy-handler.ts`, two pinned counts, the browser's `GET_RPC_PATHS`
(`apps/web/src/lib/rpc/client.ts`, which repeats the contract's
`.route({ method: 'GET' })`), a client wrapper and a Query options module. A
procedure missing from `rpcPathByOperation` and the policy table answers
`404 NotFound` at runtime (`request-policy-handler.ts`).

Server loads acquire through the app's own endpoint: `createWebQueryRuntime`
points an oRPC client at `/rpc` through SvelteKit's `event.fetch`. SvelteKit
strips `Host` from such subrequests, so
`subrequest-normalization.server.ts` re-adds `host`, `origin` and
`sec-fetch-site: same-origin` to owned internal requests before the trust
checks run.

SvelteKit 3.1.0 ships remote functions (`query`, `command`, `form`,
`prerender`, `query.batch`, `query.live`). They are enabled only by the
`experimental.remoteFunctions` option (default `false`), which the Kit
types describe as "not subject to semantic versioning". A `RemoteQuery` offers
`current`, `refresh()`, `set()` and optimistic overrides; it has no infinite
queries and no named staleness or garbage-collection policies. Svelte 5.57.2
still gates `await` in components behind `compilerOptions.experimental.async`.

## Decision

### The boundary (from ADR 0010)

- SvelteKit owns routing, SSR, hydration, server-only module enforcement,
  endpoints and hooks; components use Svelte 5 runes where reactive state is
  needed, and framework-neutral domain modules remain the behaviour owners.
- The browser-to-Web boundary is the pure contract in `@ai-usage/web-contract`.
  Browser code imports only contract values, runtime schemas, closed public
  errors and its client adapter. It never imports or infers types from the
  server router. SvelteKit's server-only guard and the client-module manifest
  check (`tools/check-web-client-manifest.ts`) enforce this.
- Every procedure validates input and output at runtime. Public errors are a
  closed, sanitized set; paths, SQLite details, engine credentials, rendezvous
  data, stack traces and arbitrary exceptions do not cross.
- Source control stays an explicit bounded EventSource endpoint, and manual
  merge upload and download stay explicit HTTP file endpoints with their byte,
  abort, staging and cleanup guarantees. Ordinary RPC JSON never carries file
  bytes. oRPC does not extend to the engine, CLI, SQLite or filesystem
  (ADR 0009).

### Server state (from ADR 0012, with ADR 0037)

- The URL and small component-local values own requested identity and
  interaction intent. TanStack Query owns remote results, status, errors,
  freshness, cancellation, deduplication, retained data, invalidation,
  mutations, hydration and collection. The oRPC client is the typed transport
  and owns no freshness or visibility decision. An EventSource adapter owns its
  connection and publishes its latest bounded snapshot into Query.
- The browser has one long-lived `QueryClient`, one oRPC client and one Query
  utility tree. Server loads build an isolated request runtime, prefetch the
  same named Query options for a document request, dehydrate the bounded
  successful data and clear the client; an SPA entry gets an empty hydration
  delta and the browser cache answers.
- Freshness comes from six named policies, not from components:
  `current-alias-swr` (30 s plus publication invalidation), `finite-swr`
  (30 s), `collection-swr` (skill observations: one-minute revalidation,
  focus and mount revalidation, a server-provided proof deadline as a
  data-aware stale time, provisional qualification of stale or in-flight
  data), `collection-facts-swr` (Work attention facts outside the served
  revision, ADR 0050: one-minute stale time and polling, focus and mount
  revalidation), `bounded-control-plane` (5 s), and `immutable-revision`
  (fresh indefinitely, bounded garbage collection).
- The report destination is one composite Query result that becomes visible
  only when every required exact leg validates at one revision, with one typed
  expiry retry and the last complete value retained on a failed refresh.
  Session pages are exact infinite-query data; detail, neighbours and VCS are
  dependent exact queries. Mutations use Query mutation observers and update or
  invalidate named exact families only. A completed publication cycle
  invalidates the current report aliases and the skill-observation identity.

### Remote functions are not adopted now

They would collapse contract, router and client wrapper into one module, but
in 3.1.0 they are opt-in experimental and outside semantic versioning, they
type the browser from the server implementation (the seam this boundary
rejects), and they lack infinite queries and named freshness policies, so Query
would remain and the app would run two caches. SvelteKit form actions are not
the application API either.

**Re-evaluation trigger**: a SvelteKit release that moves remote functions out
of `experimental`, together with either Query owning remote-function results
(infinite pages, named stale and garbage-collection times) or remote queries
gaining those semantics. Each SvelteKit upgrade ADR checks the trigger.

### Derive once (plan 120 phase B)

Both refactors touch `request-policy*`, `router.ts` and `context.server.ts`,
which PR #67 changes heavily, so they land after it.

1. **The contract declares each procedure once.** Method (`.route`),
   application error families (`.errors`), and request size class, response
   size class and transport (contract metadata, `.meta`) are declared on the
   procedure. The operation policy table, `rpcPathByOperation`, the pinned
   counts and the browser's GET set are derived from the contract, so an
   incomplete declaration fails type checking instead of answering 404. The
   browser receives only a generated path-to-method table or a
   `minifyContractRouter` artifact for `inferRPCMethodFromContractRouter`
   (`@orpc/contract` 1.16), never the schema-bearing router, so the derivation
   adds no schema bytes to the initial closure (ADR 0020). Explicit HTTP
   endpoints keep hand-written policies.
2. **SSR calls the router in process.** Server loads use an oRPC router client
   (`createRouterClient`, already used in tests) with the request context the
   HTTP handler builds, instead of `event.fetch` subrequests to `/rpc`. The
   same procedures run with the same output validation, Query keys and
   dehydration. The per-operation rules that are not HTTP rules (demo
   forbidden, application error families) apply unchanged; CSRF, Origin and
   body-size checks do not apply because no HTTP request is made, and the
   document request has already passed the trusted-local hook. When no load
   uses a subrequest, `subrequest-normalization.server.ts` and its forged trust
   headers are deleted.

> Implemented 2026-10-27 (plan 120 phase B, after ADR 0084 removed 8 of the
> procedures, leaving 49). Each procedure starts from `rpcProcedure({ method,
> transport, requestSize, responseSize, errors, demo? })`
> (`packages/web-contract/src/rpc-procedure.ts`): the declaration type admits
> only GET queries with no or URL input and POST queries or mutations with no or
> bounded JSON input, and requires a non-empty set of public error families; an
> absent `demo` means forbidden. The root contract `satisfies` that shape and the
> server router `satisfies` the contract, so a procedure missing its declaration
> or its implementation fails type checking. `rpcProcedureTable` derives the
> operation policies (CSRF from the transport), the path table, the demo set and
> the test counts. The browser imports a committed, import-free
> `rpc-get-paths.generated.ts` (`bun run generate` in `packages/web-contract`),
> whose freshness a test checks against the contract; the initial closure fell
> by 446 B. Deriving the table exposed 13 procedures whose hand-written policy
> listed error families their contract did not declare (`work.attention`,
> `workAttempts.*`, `workRouting.qualify`, `workThreads.*`, and `Forbidden` on
> four delegation mutations); their contracts now declare them, and a test pins
> the derived table to a snapshot of the hand-written one. The manual-merge
> download joined the explicit HTTP policies. Server loads call
> `createInProcessWebRpcClient(request)`, the `/rpc` router with the dependencies
> `/rpc` builds, behind an interceptor that applies the demo rule;
> `subrequest-normalization.server.ts` and the `handleFetch` hook are deleted.
> The HTTP response byte bound does not apply in process: SSR outputs are bounded
> by their output schemas and by the dehydration of successful data only.

## Consequences

- One record states the browser boundary; ADRs 0010 and 0012 remain as history.
- After phase B a new procedure touches the contract, its router module, a
  client wrapper and its Query options; nothing else needs registering, except
  regenerating the browser GET table when the set of GET procedures changes
  (a test fails until it is regenerated).
- SSR stops paying an HTTP hop per read, and the only code that manufactures
  trust headers goes away.
- oRPC's client and Query's core stay in the initial closure; replacing them
  would mean owning a protocol and a cache.

## Rejected alternative

Replacing oRPC with hand-written `fetch` endpoints and per-route schemas was
rejected: it would save one chunk of the closure but re-implement typed
clients, closed errors and serialization that the contract gives every
procedure, and it would keep the multi-place registration problem.

## Evidence

- [Contract](../../packages/web-contract/src/contract.ts)
- [Request policy](../../apps/web/src/lib/server/rpc/request-policy.ts) and
  [handler](../../apps/web/src/lib/server/rpc/request-policy-handler.ts)
- [Browser RPC client](../../apps/web/src/lib/rpc/client.ts)
- [Query composition](../../apps/web/src/lib/query/composition.ts) and
  [policies](../../apps/web/src/lib/query/policies.ts)
- [Subrequest normalization](../../apps/web/src/lib/server/rpc/subrequest-normalization.server.ts)
- [Report server load](<../../apps/web/src/routes/(report)/+layout.server.ts>)
- `node_modules/@sveltejs/kit/types/index.d.ts` (`experimental.remoteFunctions`,
  `RemoteQuery`) and `node_modules/@orpc/contract/dist/index.d.mts`
  (`inferRPCMethodFromContractRouter`, `minifyContractRouter`)
