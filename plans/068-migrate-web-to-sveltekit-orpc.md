# Plan 068: Migrate Web to SvelteKit with contract-first oRPC

> **Executor instructions**: Read this plan completely before editing code.
> Execute the waves in order, run every wave gate, and keep each wave reviewable.
> Do not weaken an invariant to make a framework integration pass. If a STOP
> condition occurs, stop and report it instead of improvising. Update the status
> row in `plans/README.md` only after the final gate passes.
>
> **Drift check (run first)**:
> `git diff --stat b8a3aad..HEAD -- apps/web packages/design-system tools package.json turbo.json docs/adr docs/architecture.md`
> This plan is based on the usage-engine runtime split at `b8a3aad`. If a
> current-state path or excerpt below has changed, reconcile the affected wave
> against the live code before implementation. A changed transport wrapper is
> expected; a changed served-revision, data-plane, or process-ownership invariant
> is a STOP condition until the plan is updated.

## Status

- **Priority**: P1
- **Effort**: L (multi-PR program)
- **Risk**: HIGH
- **Depends on**: plans 066 and 067 (both DONE)
- **Category**: migration, tech-debt, performance, tests, dx
- **Planned at**: commit `b8a3aad`, 2026-08-02
- **State**: DRAFT — architectural direction is locked; adapter/version pins are
  intentionally resolved by Wave 1 against the then-current ecosystem.

## Why this matters

The Web application has accumulated four overlapping owners for server state:
TanStack Router loaders, TanStack Query, TanStack Start server functions, and
hand-written client coordinators. Their individual behavior is mostly tested,
but their composition no longer gives an obvious answer to which reads are
server-rendered, when data becomes stale, or which event invalidates which data.

The root QueryClient treats every non-null result as fresh forever, Skills is
explicitly client-only, and public modules import server-function wrappers. The
Vite/Nitro setup also has custom server-function warmup, dependency-scan and
hydration workarounds. Data-loading regressions and server-to-client bundle
leaks are consequently easier to introduce than they should be.

The target is not “SvelteKit magic.” SvelteKit owns routing, SSR and mechanically
enforced server-only modules; contract-first oRPC owns the browser/Web wire
contract; TanStack Svelte Query owns cache and stale-while-revalidate semantics;
existing deep domain modules continue to own report consistency, SQLite reads,
Skills operations and usage-engine control. Framework remote functions and
server actions are not used as the application RPC layer.

## Outcomes

When this program is complete:

1. `apps/web` is a Svelte 5/SvelteKit application running under Bun.
2. Solid, TanStack Start/Solid Router/Solid Query/Solid Table, `lucide-solid`,
   `@ark-ui/solid`, Nitro and Solid Vite are absent from the production Web
   closure.
3. Browser-to-Web operations use a pure contract-first oRPC interface. Browser
   code cannot import router implementations or server dependencies, directly
   or transitively.
4. SvelteKit `.server.ts`/`$lib/server` boundaries fail the build on illegal
   imports, and the repository boundary checker independently enforces the graph.
5. Initial report HTML contains the bounded support bootstrap required by ADR
   0007; hydration does not duplicate the request.
6. Every query has an explicit cache policy; there is no global infinite-stale
   fallback or publication-wide invalidation sweep.
7. Exact served-revision data remains revision-keyed, supersedable and atomically
   committed. A transport change cannot silently switch an exact read to current.
8. Web and CLI still query SQLite directly through read-only/query-only
   connections. oRPC never becomes a report API on the usage-engine listener.
9. Source-control SSE remains an explicit bounded operational stream rather than
   being hidden inside oRPC, Query or a framework remote function.
10. Accessibility, visual, demo-privacy, scale, production lifecycle,
    direct-SQLite and sole-writer gates remain green.

## Decisions locked by this plan

| Concern | Decision |
| --- | --- |
| Framework | Svelte 5 and SvelteKit. New components use runes syntax; do not add legacy stores merely to mimic Solid signals. |
| Framework RPC | Do not use SvelteKit remote functions or server/form actions as application RPC. Native form actions remain available only for a future explicit progressively-enhanced HTML form requirement. |
| Browser/Web transport | Use oRPC in **contract-first** mode. Browser code imports only contracts, schemas, public errors and its client adapter. |
| API scope | oRPC spans browser to Web server only. It does not span Web to usage-engine, Web to SQLite, CLI to Web, or engine to SQLite. |
| Data plane | Preserve ADR 0009: Web and CLI perform bounded direct SQLite reads; the usage engine remains sole writer. |
| Control plane | Preserve authenticated numeric-loopback engine command/status/SSE. Web adapts it without exposing credentials or rendezvous details. |
| Client server-state | Keep `@tanstack/svelte-query` for cache, mutation state, SWR and invalidation. Do not recreate a query cache with Svelte state. |
| SSR | Create request/navigation-scoped QueryClient and oRPC clients. Await all server prefetches. No module-global `$client`, QueryClient, request event or cache. |
| Validation | Runtime-validate every oRPC input/output. Prefer one Standard Schema library; default to Valibot unless Wave 1 proves an incompatibility. Preserve current wire shapes and bounded errors. |
| Errors | Expose closed typed sanitized errors. Raw exceptions, paths, SQLite details, engine tokens and stack traces never cross the browser boundary. |
| SSE | Keep `/api/source-control` as explicit `EventSource` transport for cutover. oRPC event iterators are out of scope without measured benefit. |
| Upload/download | Keep merge uploads and downloads as explicit HTTP endpoints with existing byte/path/content-disposition/abort guarantees; do not encode files as ordinary RPC JSON. |
| URL state | Preserve shareable dashboard query strings, canonical defaults and legacy values. URL state remains framework-neutral. |
| Design system | Preserve Panda tokens, recipes, CSS and semantic classes. Port interactive primitives to `@ark-ui/svelte` or native semantic HTML without changing a11y contracts. |
| Migration shape | Introduce oRPC and explicit query ownership on Solid first, build a SvelteKit shadow entry in the same package, then cut over atomically. |
| Product behavior | This is not a redesign. Routes, deep links, keyboard behavior, responsive layout, demo privacy and local trust remain stable. |

## Architectural boundary

```text
Browser
  Svelte components and route state
        |
        +--> TanStack Svelte Query ---- cache policy + SWR + mutation state
        |          |
        |          +--> oRPC browser client
        |                     |
        |                     +--> @ai-usage/web-contract
        |                          inputs / outputs / typed errors / schemas only
        |
        +--> explicit EventSource('/api/source-control')
        +--> explicit upload/download endpoints

SvelteKit Web server
  /rpc/[...rest] endpoint
        |
        +--> oRPC router implementation in $lib/server
                   |
                   +--> UsageReadModel -------- read-only/query-only SQLite
                   +--> Skills application ---- bounded local filesystem control
                   +--> engine control client - authenticated loopback commands
                   +--> existing observability and trust checks

Usage engine
  operational HTTP: command / status / bounded SSE only
  SQLite writer: migrations / collection / publication / retention / mutations
```

The contract is a deep interface: it hides server acquisition, runtime mode,
SQLite, filesystem, engine rendezvous, observability and HTTP mechanics. It must
not become a barrel re-exporting implementations.

## Current state and evidence

### Framework/build

- `apps/web/package.json` depends on Solid, TanStack Solid Start/Router/Query/
  Table and `lucide-solid`; Nitro is a beta dev dependency.
- `apps/web/vite.config.ts:9-25` lists server-function entrypoints and client
  optimize dependencies.
- `apps/web/vite.config.ts:43-85` warms server functions manually in dev.
- `apps/web/vite.config.ts:98-105` keeps the root route eager because splitting
  it leaves the app SSR-only and prevents hydration.
- `apps/web/playwright.config.ts` sets `NITRO_DEV_RUNNER=self` because Nitro's
  worker hop conflicts with long-lived SSE under Bun.
- At this baseline there are 269 TS/TSX files under `apps/web/src`, 121 Web
  test/spec files, 20,192 TSX lines across Web/design-system components, and 107
  files importing Solid, TanStack Solid, `lucide-solid`, or Ark UI Solid.

### Data loading

- `apps/web/src/routes/__root.tsx:42-53` sets ten-minute GC, no focus/reconnect
  refetch, no retry, and infinite staleness for every non-null result.
- `apps/web/src/routes/index.tsx:26-35` uses an infinitely-stale Router loader for
  report bootstrap, while `:127-146` separately listens for publications.
- `apps/web/src/routes/skills.tsx:194-224` wraps Skills in `ClientOnly` and
  disables the initial query on the server.
- `apps/web/src/web-query-options.ts:4-15` imports Skills server wrappers into a
  public query module.
- `apps/web/src/source-control-context.tsx:27-35` invalidates quota and all Skills
  data on any report publication even though Skills is an independent Web-owned
  filesystem plane.
- Report/Session clients have framework-neutral source interfaces but production
  adapters dynamically import `./server/report-payload`; separation is
  conventional rather than mechanically enforced.

### Server operations

Thirty TanStack server-function definitions live in four files:

| Current owner | Operation family | Target namespace |
| --- | --- | --- |
| `server/report-payload.ts` | manifest/bootstrap/support/overview/breakdown, Session page/children/neighbors/detail/VCS, campaign labels, project groups, perf flag | `report.*`, `session.*`, `campaign.*`, `projectGroup.*`, `runtime.*` |
| `server/provider-quota.ts` | quota history | `quota.history` |
| `server/skills.ts` | snapshot/refresh/paths/inventories/config/toggles/reconcile/preview/target/markdown | `skills.*` |
| `server/sync.ts` | fleet and manual merge export | `sync.*` plus explicit download endpoint when binary semantics matter |

These wrappers already call deeper `.server.ts` modules. Replace wrappers; do
not move business logic into the oRPC router.

### Invariants

- `apps/web/src/served-report-session.ts` owns acquisition, one expiry retry,
  supersession, same-revision behavior, atomic commit and preservation of last
  good data. It is a domain coordinator, not transport glue.
- `apps/web/src/server/usage-read-model.server.ts` owns bounded current and
  exact-revision reads over read-only SQLite. Keep it server-only.
- ADR 0007 requires initial SSR HTML with bounded support bootstrap.
- ADR 0009 rejects a report REST/GraphQL/tRPC service between readers and the
  engine/store. oRPC here is strictly browser-facing Web transport.
- `CONTEXT.md` defines served revision, data/control plane, focused report result,
  source publication and Skills projection terminology.

### Design system

- `packages/design-system` mixes framework-neutral Panda styles with Solid
  components behind one root export; its peer/Ark dependencies are Solid-only.
- `apps/web/panda.config.ts` scans TS/TSX and sets `jsxFramework: 'solid'`.
- Most UI imports semantic classes from `@ai-usage/design-system/report`; retain
  them to avoid an unrelated visual rewrite.
- Playwright covers accessibility, responsive/visual presentation, theme,
  dashboard, Skills, sources, Session scale, demo privacy and production.

## Target layout

```text
packages/web-contract/
  src/contract.ts                 # contract composition only
  src/errors.ts                   # closed public errors
  src/report.ts                   # report/session schemas
  src/skills.ts                   # Skills schemas
  src/control.ts                  # browser-facing command contracts
  src/sync.ts                     # JSON metadata only
  src/*.test.ts

apps/web/src/lib/
  rpc/client.ts                   # browser client factory, contract only
  query/client.ts                 # scoped QueryClient factory
  query/keys.ts
  query/policies.ts
  query/options/*.ts
  report/served-report-session.ts
  url/dashboard-search.ts
  components/**/*.svelte

apps/web/src/lib/server/
  rpc/context.ts                  # request-scoped capabilities
  rpc/router.ts                   # contract implementation composition
  rpc/report.ts
  rpc/skills.ts
  rpc/control.ts
  rpc/quota.ts
  rpc/sync.ts
  usage-read-model.ts
  ...existing Web services

apps/web/src/routes/
  +layout.ts
  +layout.svelte
  +error.svelte
  +page.ts
  +page.svelte
  skills/.../+page.svelte
  sources/+page.svelte
  sync/+page.svelte
  rpc/[...rest]/+server.ts
  api/source-control/+server.ts
  api/source-control/command/+server.ts
  api/manual-merge/...
```

Do not put implementations in `web-contract` or infer client types from an
imported server router. The contract is the only browser/server value bridge.

## Data-loading ownership matrix

Every query chooses a named policy; no anonymous default is allowed.

| Data | Key identity | SSR | Freshness/invalidation |
| --- | --- | --- | --- |
| Current report bootstrap | current alias, then revision/fingerprint aliases | Required on `/` | current alias immediately stale; newer publication invalidates only current; exact revision is immutable with bounded GC |
| Support/overview/breakdown | revision + normalized request fingerprint + destination | support required; visible destination optionally prefetched | immutable/infinite stale, bounded GC; never publication-invalidated |
| Session page/children/neighbors/detail/VCS | revision + exact request fingerprint/row identity | only initially visible content | immutable per served revision; drawer reads on demand; never publication-invalidated |
| Quota history | provider + range + durable generation where available | browser-on-demand unless visible | finite SWR; invalidate only on fresh-quota completion or quota-source event |
| Skills snapshot/paths/inventories | canonical Skills key | SSR on `/skills` | finite SWR; invalidate only after Skills mutation/refresh |
| Skill markdown | scope + project/skill identity | prefetch selected document | finite SWR; successful save updates exact cache; dirty buffer is client state |
| Source control | explicit SSE reducer, not Query | optional initial snapshot | reconnect takes bounded snapshot; stream owns updates |
| Sync fleet | fleet key + compatible store generation | SSR on `/sync` if visible | short finite SWR; invalidate after completed import/merge or relevant generation |
| Runtime/demo flags | request/build context | yes | request lifetime, no global query |

Global QueryClient rules:

- queries are `enabled: browser` during component render; server data comes only
  from awaited `fetchQuery`/`prefetchQuery`;
- preserve `retry: false` unless one operation defines typed retryability;
- retain finite GC, measured by the Session scale/heap suite;
- no global `staleTime`; every option factory selects a named policy;
- no focus/reconnect refetch unless the specific policy opts in;
- mutation handlers update/invalidate the smallest exact key set.

## SSR and hydration rules

1. `+layout.ts` creates a QueryClient per SSR request/client navigation; never
   export a singleton.
2. The oRPC client factory accepts the `fetch` from the SvelteKit load event.
   Never retrieve a global request event from shared code.
3. Universal loads await browser-addressable oRPC queries. Use `fetchQuery` for
   critical content so typed failures reach route errors; `prefetchQuery` only
   for optional data with intentional loading UI.
4. Components use identical query options/keys so hydration prevents duplicate
   browser requests.
5. Do not use `initialData` as the primary report/Skills pattern; it loses the
   authoritative server fetch timestamp and is brittle when queries move.
6. No ordinary query may continue on the server after HTML is sent.
7. Critical SSR errors use route handling; optional query failures are typed
   inline states. Raw internal errors are never serialized.
8. Demo mode selects synthetic adapters before real database/filesystem/engine
   implementations are acquired.

## Commands

| Purpose | Command | Expected |
| --- | --- | --- |
| Install | `bun install` | exit 0; intended manifests/lock only |
| Format | `bun x ultracite fix` | exit 0; retain only in-scope formatting |
| Check | `bun run check` | exit 0 |
| Boundaries/lint | `bun run lint` | exit 0 |
| Types | `bun run typecheck` | all workspaces, including `svelte-check`, pass |
| Web tests | `bun test apps/web/src apps/web/*.test.ts` | all current/replacement tests pass |
| Contract | `bun test packages/web-contract` | all schema/error tests pass |
| Full tests | `bun run test` | exit 0 |
| Build | `bun run build` | isolated production output succeeds |
| Browser | `bun run test:e2e` | all pass |
| Demo privacy | `bun run test:e2e-demo` | all pass without local-data access |
| Production browser | `bun run test:e2e-production` | report and Session scale pass |
| Production lifecycle | `bun run test:web-production` | engine/Web start/stop cleanly |
| Dev/build isolation | `bun run test:web-dev-build-isolation` | outputs do not collide |
| Setup | `bun run test:setup-loopback` | passes |
| Diff | `git diff --check` | no output |

All process tests use isolated temporary homes, stores, ports, logs and
rendezvous paths. Never test against real home/database/histories/Skills/engine
state.

## Scope

**In scope**:

- SvelteKit/Svelte 5 Web runtime and production Bun adapter.
- Contract-first oRPC browser/Web contracts, adapters and tests.
- TanStack Svelte Query policies, SSR prefetch and hydration.
- Mechanical client/server boundary enforcement.
- Porting routes, components, interactive design primitives and browser tests
  without redesign.
- Preserving/adapting pure report/session/Skills models and coordinators.
- Replacing Router navigation/search while preserving URL contracts.
- Replacing TanStack Solid Table with TanStack Table core plus a narrow Svelte
  adapter or a measured Svelte-native implementation preserving scale/a11y.
- Replacing Nitro routes/plugins/build/start with SvelteKit equivalents.
- Scripts, CI, supervisor, docs/ADRs and removal of retired production code.

**Out of scope**:

- Report data endpoints on the usage engine, remote/LAN/multi-user mode, browser
  SQLite, or changing sole-writer ownership.
- SvelteKit remote functions, oRPC SSE, GraphQL/tRPC duplication, OpenAPI
  publication or external API consumers.
- Served-revision/database/retention/report/source-cadence changes.
- Visual redesign, route renaming, broken legacy URLs or unrelated features.
- Replacing Panda, Playwright, Bun, Effect, SQLite or engine control.
- Moving Skills into the usage-engine plane.
- Shipping two production Web apps or permanent Solid compatibility.

## Git and delivery

- Execute in a dedicated worktree/branch from the approved plan commit.
- Prefer one PR per wave or tightly related pair; every PR is green.
- Suggested commits/PRs: `Characterize the Web migration boundary`, `Add the
  browser Web contract`, `Replace Web server functions with oRPC`, `Make Web
  query ownership explicit`, `Bootstrap the SvelteKit Web runtime`, `Port the
  report workspace to Svelte`, `Port Skills and control surfaces to Svelte`,
  `Cut over the Web runtime to SvelteKit`.
- A shadow Svelte entry may coexist inside `apps/web`, but root production stays
  Solid until Wave 12.
- Never allow both apps to mutate real Skills/send engine commands in ordinary
  production; shadow execution is demo/E2E-only until cutover.
- Do not mark DONE until retired dependencies/glue are removed and final gates
  pass.

## Waves

### Wave 0: Freeze behavior, budgets and ownership

1. Add `docs/adr/0010-sveltekit-contract-first-browser-boundary.md`. It amends
   Web framework/browser transport only and preserves ADRs 0007/0009.
2. Add a machine-readable inventory listing every server function by stable
   name, read/mutate/file class, input/output parser, implementation owner and
   public errors.
3. Instrument initial `/` SSR/hydration: exactly one bootstrap acquisition, no
   duplicate hydrated query, no already-prefetched exact request, and no server
   query continuing after response settlement.
4. Record production bundle closure, HTML size, render/hydration timings,
   request count, Session DOM/heap budgets and cold/warm dev startup in
   `docs/performance/web-framework-migration-baseline.md` with reproducible
   commands. Do not invent a composite score.
5. Characterize every dashboard search parameter/default/legacy value, nested
   Skills URL, selected document, drawer identity and back/forward behavior.
6. Confirm demo tests fail on real database/home/Skills/engine/network acquisition.

**Gate**: unchanged Solid Web unit, E2E, demo and production suites pass and the
baseline is reproducible.

### Wave 1: Resolve adapter/version uncertainty with a disposable spike

1. Scaffold a disposable minimal SvelteKit app with TypeScript, Panda, SSR, one
   oRPC echo, Query prefetch/hydration, illegal server import and SSE held beyond
   the current Nitro timeout.
2. Test official `@sveltejs/adapter-node` under Bun first and
   `svelte-adapter-bun` second because Bun currently recommends it.
3. Verify numeric loopback host/port, `bun --no-env-file`, abort propagation,
   >30-second SSE, signal shutdown, no descendants, request context, assets,
   build output control, dev/build concurrency and supervisor compatibility.
4. Verify current non-deprecated oRPC/Svelte Query APIs and pin exact versions of
   SvelteKit, Svelte, adapter, oRPC, Query, Ark UI and schema library.
5. Delete the spike; commit only the decision and reusable lifecycle fixture.

Default: select adapter-node if every gate passes; otherwise select the Bun
adapter only if it passes all gates. If neither passes, STOP rather than keeping
Nitro under SvelteKit as an unplanned hybrid.

**Gate**: a tool test starts the production artifact on ephemeral loopback,
observes SSR and >30-second SSE, signals shutdown, and proves port/process exit.

### Wave 2: Create the pure contract and graph guards

1. Add `packages/web-contract` with explicit exports and dependencies limited to
   oRPC contract, selected schema library and pure domain contract packages.
2. Define small namespaces from the inventory without “cleaning up” wire shapes.
3. Define closed public errors and map known expired revision, incompatible
   store, invalid input, unavailable engine, forbidden demo and Skills conflict.
4. Test valid/invalid boundary values, outputs, errors, serialization and file
   exclusions.
5. Extend `tools/check-package-boundaries.ts`: browser/Svelte code may not reach
   `node:*`, `bun:*`, `@orpc/server`, usage-store, report-data, local-machine,
   engine implementations, `$lib/server` or `*.server.*`, even via re-exports.
6. Add SvelteKit fixtures proving direct/indirect/re-export/dynamic illegal
   imports fail. Keep graph checks because test runners disable Kit detection.

**Gate**: contract/boundary tests and `bun run lint` pass; the contract has no
server/runtime imports.

### Wave 3: Replace server functions with oRPC while Solid is authoritative

1. Add one browser client factory and Nitro `/rpc` handler with per-request
   runtime/trust/observability/read-model/control capabilities.
2. Implement namespaces one family at a time. Procedures validate/map/call
   existing `.server.ts` services; copy no SQL/filesystem/domain workflow.
3. Port report reads, exact Sessions, quota, Skills reads/mutations and control
   mutations; preserve abort/deadlines.
4. Keep file/SSE explicit. RPC may return bounded metadata, not file bytes.
5. Switch Solid query/source adapters to injected contract clients and remove
   public dynamic/static server imports.
6. Add real HTTP handler tests with fake deep services for validation, typed
   errors, abort, demo rejection, leakage and size budgets.
7. Delete `createServerFn` wrappers only when inventory parity is complete;
   remove warmup and `/_serverFn/` glue.

**Gate**: no production `createServerFn`, `_serverFn` or warmup match; all Solid
Web/demo/production tests pass through oRPC.

### Wave 4: Make cache/SWR/invalidation explicit

1. Replace `web-query-options.ts` with domain key/policy/options modules whose
   functions receive an oRPC client dependency.
2. Remove root staleness defaults and apply the ownership matrix to all queries.
   Test key, stale, GC, SSR/enabled and invalidation behavior.
3. Decouple publication from Skills/quota. Publication invalidates only current
   report aliases; each control plane owns its refresh.
4. Never refetch immutable exact-revision entries due to a new publication; new
   revision means new keys/coordinator supersession.
5. Characterize first load, background SWR, retained prior data and refresh
   errors.
6. Assert cache/heap GC in Session scale tests.

**Gate**: no duplicate bootstrap, unrelated invalidation or immutable-key
refetch; policy tests pass.

### Wave 5: Bootstrap shadow SvelteKit and port design-system primitives

1. Add SvelteKit shadow scripts/config in `apps/web`; root Solid scripts remain
   authoritative until cutover.
2. Configure Panda's supported Svelte/PostCSS integration to scan TS/Svelte;
   preserve preset, semantic exports and CSS layers.
3. Split design-system framework-neutral styles, explicit Solid compatibility
   exports and Svelte primitives.
4. Port Tooltip, Popover, Drawer, Checkbox, Toggle, Tabs, SegmentedControl and
   MultiSelect with focus/Escape/keyboard/label/reduced-motion/portal parity.
5. Add narrow Svelte render tests where useful; rely on Playwright for integrated
   behavior rather than adding a redundant browser framework.
6. Build root layout, error boundary, theme bootstrap and navigation shell with
   matching SSR/hydration.

**Gate**: shadow build/typecheck, primitive tests and theme/navigation/a11y
subset pass; Solid remains green.

### Wave 6: Port routes and URL-owned state

1. Reuse pure dashboard search parsing/defaults/canonicalization; replace its
   Solid Table type with a framework-neutral sort shape.
2. Add SvelteKit routes matching `/`, nested `/skills`, `/sources`, `/sync`,
   trailing slash and 404 behavior.
3. Build a narrow SvelteKit URL adapter preserving unrelated params, replace vs
   push, defaults and back/forward without loops.
4. Port navigation and route loading/error shells with demo policy.
5. Test direct deep links, reload, copy/paste, legacy values and history.

**Gate**: URL/deep-link suites pass against both apps; demo shadow acquires no
real services.

### Wave 7: Port report SSR and exact-revision coordination

1. Add scoped QueryClient/oRPC client factories and root provider.
2. `+page.ts` awaits current bootstrap through event fetch; component uses the
   exact hydrated key.
3. Port ServedReportSession as pure TypeScript, retaining transition tests; add
   a thin rune owner without duplicated transitions.
4. Port report shell/status/warnings/header/filters/time/overview before other
   destinations; keep models/presentation pure.
5. Publication may revalidate current aliases; exact destination changes only
   after coordinator atomic acceptance.
6. Test live, compatible-last-publication, unavailable, one expiry retry,
   superseded request, demo and E2E payload SSR/hydration.
7. Assert meaningful initial HTML and no global loading replacement.

**Gate**: report/SSR/hydration/publication/visual tests pass with one bootstrap.

### Wave 8: Port breakdown, filters, visualizations and report actions

1. Port breakdown destinations preserving semantic color/legend/order.
2. Port filters, origin/time cells, grouping, labels, share/CSV; keep mutation
   transport decisions.
3. Replace Solid icons with equivalent Svelte icons/framework-neutral SVG while
   preserving accessible/decorative behavior.
4. Port quota history as independent browser-on-demand policy; do not block SSR.
5. Run deterministic DOM/geometry/token assertions before visual snapshots per
   the index presentation gate.

**Gate**: presentation/value/filter/quota/visual/a11y/performance subsets pass.

### Wave 9: Port Sessions table, paging, drawer and analysis

1. Prefer TanStack Table core plus narrow Svelte integration if it preserves
   models. Use another table only after a scale/a11y spike and ADR update.
2. Port query owner, paging/windowing, selection, neighbor prefetch, campaign
   children and columns with identical fingerprints.
3. Port Drawer/detail/VCS/chronology/multi-harness analysis; keep drawer reads
   on demand and abort superseded selections.
4. Preserve 5,000-row geometry, keyboard, visibility, sorting, URL, memory and
   network budgets.
5. Add component tests only where browser/pure tests cannot localize ownership.

**Gate**: Session/drawer/VCS/analysis and production scale/benchmark pass within
Wave 0 budgets.

### Wave 10: Port Skills with SSR and independent cache ownership

1. SSR-prefetch Skills snapshot and known paths; remove ClientOnly shell and
   reuse hydrated cache.
2. Port controller/tree/workspace/matrix/health/detail/diagnostics/context/
   consolidation/editor; dirty buffers remain local client state.
3. Port mutations through typed RPC; use returned post-state or invalidate only
   affected keys; preserve conflicts/dirty/pending replacement flows.
4. Preserve filesystem authority, configured sources, unmanaged safety and demo
   acquisition isolation.
5. Add SSR assertions plus edit/save/reconcile/projection/responsive E2E.

**Gate**: initial HTML contains the Skills workspace, no duplicate fetch, and all
Skills/unit/E2E/visual/demo tests pass.

### Wave 11: Port Sources, Sync, explicit SSE and file routes

1. Port `/sources`, `/sync` and pure presentation models.
2. Move Nitro source-control GET/POST to SvelteKit endpoints preserving trust,
   replay, heartbeat, abort, reconnection and backpressure.
3. Port EventSource owner to explicit Svelte service/context with start,
   subscribe, reconnect and dispose; keep outside Query.
4. Map publications only to Wave 4 keys; never invalidate Skills.
5. Port merge upload/export with byte limits, opaque IDs, disposition, no-follow,
   validation, confirmation and abort cleanup; no ordinary RPC file bytes.
6. Port Web read observability to SvelteKit hooks without widening logged data or
   duplicating wide events.

**Gate**: control client/server/E2E, sources, sync, upload, demo, production and
>30-second SSE tests pass.

### Wave 12: Cut over and delete the retired stack

1. Switch Web dev/build/preview/check/test/Turbo scripts to SvelteKit.
2. Adapt start/build/supervisor only as selected adapter requires, preserving
   locks, output isolation, loopback, explicit env, engine readiness and shutdown.
3. Switch Playwright/demo/start/setup tools; remove Nitro workaround only after
   SSE proof.
4. Delete Solid routes/components/shadow compatibility and retired tests after
   Svelte parity.
5. Remove Solid/TanStack Start/Solid packages, Solid Vite/icons/Ark and Nitro;
   retain framework-neutral core only if used.
6. Delete warmup, hydration workaround, Nitro handlers/plugins/paths/exceptions.
7. Scan emitted client manifest as well as sources for retired/server modules.
8. Compare final bundle/HTML/requests/timing/startup/Session memory/lifecycle to
   Wave 0. Investigate >10% regressions; claim no unmeasured performance win.
9. Update README/Web README/architecture/public interfaces/generated ownership/
   ADR consequences and final performance results.
10. Accept ADR 0010 and mark plan DONE only after final gates.

## Test plan

Preserve framework-neutral ServedReportSession, request fingerprint, operation
owner, search parser, presentation/model, server service, UsageReadModel and
usage-engine tests. Add:

- one contract test per procedure, public error and invalid boundary;
- reviewed wire serialization snapshots and file exclusions;
- illegal import fixtures plus emitted client manifest scans;
- abort/deadline and demo adapter acquisition tests;
- concurrent SSR request isolation and no work after response;
- hydration timestamp/no-duplicate tests for report and Skills;
- current-vs-immutable invalidation, retained-data SWR and GC tests;
- primitive focus/keyboard/Escape/a11y tests;
- complete deep-link/history parity;
- report, Session scale, Skills, Sources, Sync, demo privacy and production
  lifecycle parity through existing Playwright suites.

## Final done criteria

- [ ] `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test` and
  `bun run build` exit 0.
- [ ] `bun run test:e2e`, `bun run test:e2e-demo`,
  `bun run test:e2e-production`, `bun run test:web-production`,
  `bun run test:web-dev-build-isolation` and `bun run test:setup-loopback` exit 0.
- [ ] `git diff --check` emits no output.
- [ ] No production match remains for `createServerFn`, `_serverFn`, TanStack
  Solid/Start/Router/Query/Table, `solid-js`, Solid Vite/icons/Ark, Nitro or the
  Nitro runner workaround.
- [ ] Client manifest contains no `node:*`, `bun:*`, `@orpc/server`, usage-store,
  report-data, local-machine, engine implementation, `$lib/server` or `.server`
  module.
- [ ] Every Wave 0 operation is implemented or explicitly classified as file/SSE;
  none is lost.
- [ ] Initial `/` and `/skills` HTML has settled content and no duplicate fetch.
- [ ] Exact revision retry/supersession/atomic commit matches characterization.
- [ ] Publication does not invalidate Skills or immutable exact revision; quota
  is independently owned.
- [ ] ADRs 0007/0009 remain true and tested.
- [ ] Final measurements are recorded; every >10% regression is fixed or
  explicitly approved with evidence.
- [ ] Plan 068 is marked DONE only after all checks.

## STOP conditions

Stop and report if:

- ADR 0009's direct reads/sole writer changes underneath the plan;
- oRPC seems to require an engine report endpoint, browser SQLite or engine
  credentials/rendezvous in browser;
- the contract must import the server router/implementation, or client can reach
  server code transitively;
- neither adapter passes Bun SSE/shutdown/output/lifecycle tests;
- SSR requires a module-global event/client/QueryClient/cache;
- cache work removes exact keys, one expiry retry, supersession, fingerprint
  validation or atomic commit;
- a port changes URLs, calculations, cadence, Skills authority or demo privacy;
- a boundary must be weakened or raw server failures exposed;
- table parity cannot meet scale/heap/keyboard budgets—return to Wave 9;
- a gate fails twice after reasonable scoped correction;
- work expands into redesign or unrelated product features.

## Maintenance notes

- A procedure exists because the browser needs a Web capability, not because a
  server function happens to exist.
- New queries must classify identity as current, immutable revision, filesystem
  snapshot or operational live state before selecting staleness.
- Retain SvelteKit server-only enforcement plus repository graph checks because
  unit tests do not enforce Kit boundaries.
- Do not adopt remote functions opportunistically; require a superseding ADR.
- Keep oRPC isolated behind contract/client/router adapters so transport can be
  replaced without touching query/domain ownership.
- Re-run adapter lifecycle/SSE fixtures on major SvelteKit/adapter/Bun/oRPC
  upgrades and cache memory tests after new exact destinations/prefetch.

## Primary references

- <https://svelte.dev/docs/kit/server-only-modules>
- <https://svelte.dev/docs/kit/adapter-node>
- <https://bun.sh/docs/guides/ecosystem/sveltekit>
- <https://orpc.dev/docs/contract-first/define-contract>
- <https://orpc.dev/docs/adapters/svelte-kit>
- <https://orpc.dev/docs/integrations/tanstack-query>
- <https://orpc.dev/docs/best-practices/optimize-ssr>
- <https://tanstack.com/query/v5/docs/framework/svelte/ssr>
- <https://panda-css.com/docs/installation/svelte>
- <https://ark-ui.com/blog/introducing-ark-ui-svelte>

Re-check these time-sensitive references in Wave 1. Repository ADRs/tests remain
the authority for ai-usage domain behavior.
