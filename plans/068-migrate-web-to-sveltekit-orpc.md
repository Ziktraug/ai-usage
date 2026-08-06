# Plan 068: Migrate Web to SvelteKit with contract-first oRPC

> **Executor instructions**: Read this plan completely before editing code.
> One coordinator owns the integration branch and schedules the autonomous work
> packets below from their dependency graph. Waves are convergence milestones,
> not worker assignments: independent packets may run concurrently, but a wave
> gate is evaluated only on the integrated branch. Do not weaken an invariant to
> make a framework integration pass. If a STOP condition occurs, stop and report
> it instead of improvising. Only the coordinator updates this plan or the status
> row in `plans/README.md`, and only after the final gate passes.
>
> **Drift check (run first)**:
> `git diff --stat 72c648e..HEAD -- apps/web packages/design-system packages/web-contract tools package.json bun.lock turbo.json docs/adr docs/architecture.md`
> This plan was reconciled against the merged usage-engine runtime split at
> `72c648e`. If a
> current-state path or excerpt below has changed, reconcile the affected wave
> against the live code before implementation. A changed transport wrapper is
> expected; a changed served-revision, data-plane, or process-ownership invariant
> is a STOP condition until the plan is updated.

## Status

- **Priority**: P1
- **Effort**: XL (single-PR, multi-agent program)
- **Risk**: HIGH
- **Depends on**: plans 066 and 067 (both DONE)
- **Category**: migration, tech-debt, performance, tests, dx
- **Planned at**: commit `72c648e`, 2026-08-02
- **State**: REOPENED for presentation parity, 2026-08-05. The transport,
  boundary, SSR/hydration, cache-ownership and lifecycle outcomes remain
  integrated, independently reviewed and green through checkpoint `ac63cf8`
  (Actions run `30947971788`, attempt 3); they are not being rejudged. Level 4
  parity is not met: the maintainer reported the Activity brush handles rendering
  unstyled and the chart drawing the whole domain, and the audit found the
  semantic Panda layer had been rebuilt with local `css()` rather than ported,
  leaving 183 exports without a consumer. Repairs land on the same draft PR `#27`,
  which stays draft and unmerged.

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
| Writer package boundary | Web may use the usage-store reader facade but must never import the writer-capable `@ai-usage/usage-merge`; only usage-engine-runtime owns that package. |
| Control plane | Preserve authenticated numeric-loopback engine command/status/SSE. Web adapts it without exposing credentials or rendezvous details. |
| Source snapshots | Preserve the engine runtime's source-snapshot broker and bounded control event stream. SvelteKit adapts their existing control interface; it does not recreate snapshot waiting or event fan-out. |
| Client server-state | Keep `@tanstack/svelte-query` for cache, mutation state, SWR and invalidation. Do not recreate a query cache with Svelte state. |
| SSR | Create request/navigation-scoped QueryClient and oRPC clients. Await all server prefetches. No module-global `$client`, QueryClient, request event or cache. |
| Validation | Runtime-validate every oRPC input/output. Prefer one Standard Schema library; default to Valibot unless Wave 1 proves an incompatibility. Preserve current wire shapes and bounded errors. |
| Errors | Expose closed typed sanitized errors. Raw exceptions, paths, SQLite details, engine tokens and stack traces never cross the browser boundary. |
| SSE | Keep `/api/source-control` as explicit `EventSource` transport for cutover. oRPC event iterators are out of scope without measured benefit. |
| Upload/download | Keep merge uploads and downloads as explicit HTTP endpoints with existing byte/path/content-disposition/abort guarantees. Forward `AbortSignal` through inbox staging, race abort against staging, and clean a handoff that completes late; do not encode files as ordinary RPC JSON. |
| Process/file identity | Reuse `@ai-usage/usage-engine-control/node` file-identity, ownership, process-start and liveness helpers in Web build/runtime adapters; do not fork those checks in SvelteKit scripts. |
| URL state | Preserve shareable dashboard query strings, canonical defaults and legacy values. URL state remains framework-neutral. |
| Design system | Preserve Panda tokens, recipes, CSS and semantic classes. Port interactive primitives to `@ark-ui/svelte` or native semantic HTML without changing a11y contracts. |
| Migration shape | Introduce oRPC and explicit query ownership on Solid first, build a SvelteKit shadow entry in the same package, then cut over atomically. |
| Delivery shape | One coordinator-owned integration branch, isolated local packet worktrees, no packet PRs, and exactly one final implementation PR after the final local integrated gate. |
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

### Post-merge hardening already present at `72c648e`

- `apps/web/src/server/manual-merge-upload.server.ts` passes the request
  `AbortSignal` into handoff staging, races cancellation against staging, and
  schedules cleanup if staging succeeds after the request has already aborted.
  P7/Wave 11 must preserve all three behaviors, including recovery when detached
  cleanup cannot finish.
- `tools/check-package-boundaries.ts` permits Web/CLI to import only the
  usage-store reader facade and reserves the writer-capable
  `@ai-usage/usage-merge` package for usage-engine-runtime. Contract/RPC/Svelte
  work may not weaken or route around that graph.
- `apps/web/src/focused-report-client.ts` now performs explicit per-destination
  exact revision and canonical fingerprint validation through the same public
  source interface. The simplification changes no ServedReportSession invariant.
- `apps/web/vite-production-build.ts` consumes private file identity, ownership,
  process-start and liveness helpers from
  `@ai-usage/usage-engine-control/node`. The SvelteKit adapter/build cutover
  reuses that deep module instead of copying its implementation.
- The usage-engine runtime owns a dedicated source-snapshot broker and the engine
  app owns the bounded control event stream. P6 adapts those existing interfaces;
  it does not move snapshot waiting, fan-out or event lifecycle into Web.

### Design system

- `packages/design-system` mixes framework-neutral Panda styles with Solid
  components behind one root export; its peer/Ark dependencies are Solid-only.
- `apps/web/panda.config.ts` scans TS/TSX and sets `jsxFramework: 'solid'`.
- Most UI imports semantic classes from `@ai-usage/design-system/report`; retain
  them to avoid an unrelated visual rewrite.
- Playwright covers accessibility, responsive/visual presentation, theme,
  dashboard, Skills, sources, Session scale, demo privacy and production.

## What “feature parity” means

Parity is a release gate, not a visual impression and not “the new page opens.”
Every row in the registers below must be checked at five levels before the old
implementation is deleted:

1. **Interface parity** — URL, keyboard/pointer commands, accessible names,
   focus, error modes and visible states remain compatible.
2. **Data parity** — the same deep module is called with the same normalized
   input, revision/fingerprint and authority context; outputs retain their
   meaning and ordering.
3. **Lifecycle parity** — SSR, hydration, pending, SWR, cancellation,
   supersession, retry, teardown and back/forward behavior are characterized.
4. **Presentation parity** — semantic Panda tokens/classes, responsive geometry,
   reduced motion, light/dark mode and settled screenshots remain equivalent.
5. **Operational parity** — privacy, local trust, CSRF, byte/path bounds,
   observability, loopback binding, process lifecycle and performance budgets
   remain enforced.

A row is not complete because its `.svelte` file exists. It is complete only
when its named pure/unit/server/browser/production gates pass against the new
runtime. Product copy and deliberate visual decisions from plans 045–065 are
part of the interface and must not be “simplified” during the rewrite.

## Feature-parity register

This is the minimum user-visible ledger. The Wave 0 inventory must turn each row
into a machine-readable ID and attach its exact test names, but an executor may
not remove or merge rows without a reviewed plan update.

| ID | Current feature/interface | Current owners | Required Svelte target and parity evidence |
| --- | --- | --- | --- |
| SHELL-01 | Shared navigation on Report, Skills, Sources and Sync; active route; deep-scroll destination remains visible; narrow layout has no overflow | `app-navigation.tsx`, `routes/__root.tsx`, `components/source-control-summary.tsx` | `+layout.svelte` shell using SvelteKit links; preserve active semantics, sticky behavior, demo visibility and the accessibility route matrix |
| SHELL-02 | Theme resolved before paint, named toggle, light/dark/system behavior and reduced motion | `dashboard-theme.tsx`, root inline theme script, Panda global CSS | SSR-safe theme bootstrap before hydration; run `theme.spec.ts`, focus/reduced-motion tests and light/dark visual gates |
| SHELL-03 | Scroll restoration, default Not Found, route error shell and report retry | `router.tsx`, `routes/index.tsx` | SvelteKit navigation/snapshot policy and `+error.svelte`; characterize restoration, 404, retry after loader error and no hydration mismatch |
| REPORT-01 | Initial production Overview is server-rendered from a bounded support bootstrap and compatible stored publication when engine is down | `report-runtime.ts`, `routes/index.tsx`, `Dashboard`, UsageReadModel | `+page.ts/+page.svelte` awaited query hydration; assert meaningful initial HTML, one bootstrap acquisition and compatible-last-publication behavior |
| REPORT-02 | Report lifecycle distinguishes first load, focused pending, last complete output, refresh error, expiry retry and supersession | `dashboard-report-lifecycle.ts`, `served-report-session.ts`, `dashboard-report-workspace.tsx` | Preserve the same deep session interface and transition tests; a thin rune adapter must not reimplement state transitions |
| REPORT-03 | Overview metric tiles, comparison semantics, token anatomy, provenance explanations, source freshness, spend coverage and data-quality labels | `dashboard-metrics.tsx`, `overview.tsx`, `provider-status-panel.tsx`, `report-warnings.tsx` | Port presentation over unchanged pure models; retain DOM/text/token assertions and `dashboard-presentation.spec.ts` |
| REPORT-04 | One report range owns every chart; presets, text, keyboard, pointer and canonical URL; wheel scroll is not captured | `time-range-control.tsx`, `date-range-controller.ts`, `time-range-control-state.ts` | Preserve state module as interface; replace DOM adapter only; run all `time-range.spec.ts` cases and controller tests |
| REPORT-05 | Activity timeline, campaign/machine/origin grouping, legends, boundary ticks, selectable heatmap days and compact Punchcard with keyboard parity | `overview.tsx`, `time-range-control.tsx`, pure overview/group models | Port SVG/DOM with stable series keys and geometry; run timeline/heatmap/punchcard DOM, keyboard, geometry and visual tests |
| REPORT-06 | Primary Overview/Sessions/Breakdown navigation, Breakdown legacy deep links, sub-tabs, list search, value/tokens/sessions sorting and measured/partial/zero bars | `dashboard-breakdown*.tsx`, `group-panel.tsx`, dashboard search/model modules | Preserve query-string contract and ordering/value semantics; port Tabs/SegmentedControl; run dashboard, value-presentation and breakdown tests |
| REPORT-07 | Exact breakdown URL copy and safe CSV of only visible sorted rows | `report-sharing-actions.tsx`, `report-export.ts` | Keep Clipboard/download behavior and explicit HTTP/file rules; same filename, headers, rows, escaping and error feedback |
| FILTER-01 | Text, harness, machine, origin, exact dimension, time-cell, date and column filters are URL-owned, removable and back/forward-safe | `dashboard-filter-bar.tsx`, `dashboard-active-filters.tsx`, `origin-filter.tsx`, `dashboard-navigation-controller.ts` | Pure parser/serializer plus SvelteKit navigation adapter; full default/legacy/canonical/history test matrix |
| FILTER-02 | Harness badge filters stop row selection propagation and expose pressed state; machine staleness keeps raw filter identity | design `HarnessBadge`, `machine-staleness.spec.ts` | Controlled Svelte Toggle with same stop-propagation, label/title and raw-value behavior |
| SESSION-01 | One responsive Sessions surface survives viewport changes; desktop table/mobile summaries share state | `session-table.tsx`, `session-surface-mode.ts` | One state owner with desktop/mobile projections; no duplicate table/query owner across breakpoints; existing viewport-change E2E |
| SESSION-02 | Sortable/hideable 25-column schema, Work/Tokens/Reliability presets and legacy URL column diffs | `session-columns.tsx`, `session-table-schema.ts`, TanStack Table | Framework-neutral sorting/visibility types; preserve schema, headers, comparators, presets, URL encoding and all column tests |
| SESSION-03 | Campaign expansion, explicit child loading, automatic top-level paging and stable row identity | `session-query-client.ts`, `session-query-operation-owner.ts`, table expansion | Preserve exact revision/request fingerprint, one operation owner, dedupe/cancel/supersede and campaign reachability gates |
| SESSION-04 | Bounded virtual window, fixed row geometry, desktop/mobile sentinels and 5,000-row DOM/heap/network budgets | `session-row-window.ts`, virtual surfaces in `session-table.tsx` | Reuse pure window math; Svelte DOM adapter must meet production scale/benchmark and viewport geometry tests |
| SESSION-05 | Session selection from Overview/table, URL/history identity, drawer next/previous/close keyboard commands and focus return | `dashboard-session-selection.ts`, `session-drawer.tsx`, Router history | Svelte navigation adapter plus controlled Drawer; preserve history/back-forward, focus, Escape and neighboring-session behavior |
| SESSION-06 | Detail, VCS, chronology and Claude/Codex/OpenCode analysis with recorded/partial/unavailable trust semantics | `session-analysis.tsx`, `session-vcs-summary.tsx`, detail/VCS clients and pure presentation modules | Keep deep server clients and pure analysis models; port rendering only; run all multi-harness render/production gates |
| CAMPAIGN-01 | Every top-level row is campaign-shaped; human root is not a subagent; neutral origin and undeclared-origin gap semantics | dashboard model, campaign/origin presentation | Preserve domain aggregation and exact labels; origin/campaign/category E2E remains byte/text-equivalent where asserted |
| CAMPAIGN-02 | Local campaign-label rename/reset preserves filter key; project groups can be edited/saved without changing report identity | `campaign-label-editor.tsx`, `project-group-editor.tsx`, controllers/server modules | Typed oRPC mutations with current validation/conflict semantics; preserve local-only authority and post-save refresh behavior |
| QUOTA-01 | Codex quota history is on demand, responsive, reset-aware and gap-aware | `provider-quota-history-panel.tsx`, quota model/client | Independent finite query policy; drawer opens/fetches without blocking report SSR or reacting to unrelated publication |
| SKILLS-01 | Nested addressable Global/Project/Skill/Matrix routes and selection links | `routes/skills*`, `skills-selection-link.tsx`, `skills-route-model.ts` | SvelteKit route tree with encoded stable keys and same redirect/default/deep-link behavior |
| SKILLS-02 | SSR workspace with tree, editor and Inspector in one bounded desktop row; mobile prioritizes editor/picker; matrix cards/table responsive | `routes/skills.tsx`, `skills-workspace.tsx`, `skills-tree.tsx`, `skills-context-panel.tsx`, `skills-matrix.tsx` | Replace current ClientOnly with hydrated SSR while preserving every geometry/a11y/visual test |
| SKILLS-03 | SKILL.md immediately editable; exact draft retained on disk conflict/save failure/refresh; Ctrl/Cmd+S; follow-up edits | `skill-markdown-editor.tsx`, `skill-markdown-editor-model.ts` | Preserve controller as deep module; Svelte adapter owns textarea/events only; all editor conflict/shortcut tests remain |
| SKILLS-04 | Unsaved draft blocks in-app navigation, reload and selection; discard/keep/focus flows | Router `useBlocker`, `DiscardConfirmationDialog`, workspace draft guard | SvelteKit `beforeNavigate` plus `beforeunload` adapter and controlled confirmation UI; test resolved/cancelled navigation and cleanup |
| SKILLS-05 | Snapshot/inventory refresh never replaces dirty document; mutations stay in deterministic E2E backend | `skills-route-controller.ts`, Query cache, E2E fixture | Explicit query/mutation ownership with smallest cache updates; preserve dirty-state priority and no real filesystem in E2E/demo |
| SKILLS-06 | Reconcile preview/apply, target directory, runtime projections, unmanaged backlog and validation findings | `skills-consolidate.tsx`, `skills-health.tsx`, `skill-diagnostics.tsx`, Skills server modules | One `skills.*` contract family over existing application module; retain path trust, lock, conflict and neutral-unmanaged semantics |
| SOURCES-01 | Complete catalogue, independent source enable/disable/collect/publish, one publication, deviation cards, progress and partial-SSE rejection | `routes/sources.tsx`, source-control client/presentation | Explicit EventSource state module plus typed command RPC/endpoint; run all `sources.spec.ts` and reducer/server tests |
| SOURCES-02 | Responsive source-control summary on Report and routes, engine unavailable/reconnect and sanitized state | summary component and source-control context/client | Svelte context adapter with one subscription and deterministic dispose/reconnect; no Query ownership |
| SYNC-01 | Fleet comparison, machine contribution/staleness and explicit manual file-transfer-only UX | `routes/sync.tsx`, `sync-machine-fleet.tsx`, `sync-machine-comparison.tsx` | SSR/SWR fleet query and same pure comparison models; preserve labels, warnings and responsive render tests |
| SYNC-02 | Bounded export/upload/preview/confirm with opaque IDs, stale preview, warnings and cleanup | sync route, manual-transfer model, upload/export server modules | Explicit SvelteKit file endpoints plus oRPC metadata only; retain byte/path/trust/abort/content-disposition tests |
| PRIVACY-01 | Demo serves synthetic report only and keeps local database, engine, Skills, source/sync commands and protected routes inert | demo guard/middleware/fixtures | SvelteKit server hook + route policy selected before acquisition; `demo-privacy.spec.ts` remains the destructive negative gate |
| SECURITY-01 | Local-request trust and CSRF cover browser mutations/server operations | `start.ts`, `local-request-trust.server.ts`, demo middleware | SvelteKit `hooks.server.ts` and oRPC mutation middleware with identical rejection semantics; add route matrix proving no handler bypass |
| OPS-01 | Web read wide-event observability initializes once and remains sanitized/bounded | Nitro plugin and Web observability module | SvelteKit server hook/lifecycle adapter; existing server tests plus single-initialization/teardown test |
| OPS-02 | Loopback-only dev/production, build lock, isolated outputs, engine readiness, clean signals/descendants and long SSE | Vite/Nitro/build/start/supervisor/tool tests | Selected Svelte adapter must pass the exact operational suite before old runtime deletion |

## Complete UI migration ledger

Every production TSX file is accounted for below. “Port” means reproduce its
interface in Svelte; “preserve” means keep/extract its pure TypeScript module and
replace only the framework adapter. Wave 0 must fail if a new TSX file is not
assigned to a ledger row before cutover.

| Cluster | Current files | Treatment |
| --- | --- | --- |
| Root/routing | `router.tsx`, `routes/__root.tsx`, `routes/index.tsx`, all five nested `routes/skills.*.tsx`, `routes/skills.tsx`, `routes/sources.tsx`, `routes/sync.tsx` | Replace with SvelteKit layouts/pages; preserve pure loaders/parsers behind injected interfaces |
| Shared shell/control | `app-navigation.tsx`, `dashboard-theme.tsx`, `source-control-context.tsx`, `components/source-control-summary.tsx` | Port; replace Router/Context lifecycles and keep source-control state module framework-neutral |
| Report composition | `dashboard.tsx`, `dashboard-header.tsx`, `dashboard-status.tsx`, `dashboard-provider-status.tsx`, `dashboard-report-workspace.tsx`, `dashboard-pending-surface.tsx`, `report-warnings.tsx` | Port composition; preserve existing lifecycle/session modules rather than embedding them in components |
| Filters/navigation | `dashboard-filter-bar.tsx`, `dashboard-filters.tsx`, `dashboard-active-filters.tsx`, `origin-filter.tsx` | Port DOM; preserve pure search, navigation intent and filter models |
| Overview/time/value | `overview.tsx`, `time-range-control.tsx`, `dashboard-metrics.tsx`, `provider-status-panel.tsx`, `provider-quota-history-panel.tsx`, `project-summary.tsx`, `group-panel.tsx`, `cursor-attribution-panel.tsx`, `shared.tsx` | Port render/interaction adapters; preserve calculations, chart series, window/range and presentation modules |
| Breakdown/actions | `dashboard-breakdown.tsx`, `dashboard-breakdown-panels.tsx`, `dashboard-breakdown-harness-panel.tsx`, `report-sharing-actions.tsx`, `campaign-label-editor.tsx`, `project-group-editor.tsx` | Port; retain sorted/filtered export and mutation controller semantics |
| Sessions | `session-table.tsx`, `session-columns.tsx`, `session-drawer.tsx`, `session-analysis.tsx`, `session-vcs-summary.tsx`, `drawer-detail-item.tsx`, `highlighted-text.tsx` | Port table/drawer/rendering; preserve schema/window/selection/query/analysis modules and exact identifiers |
| Skills | `skills-workspace.tsx`, `skills-tree.tsx`, `skills-context-panel.tsx`, `skills-matrix.tsx`, `skills-detail.tsx`, `skills-health.tsx`, `skills-consolidate.tsx`, `skill-diagnostics.tsx`, `skill-markdown-editor.tsx`, `skills-selection-link.tsx`, `discard-confirmation-dialog.tsx` | Port all; preserve route/editor/query/controllers as deep modules where framework-free; explicitly replace Router blocker/link adapters |
| Sync | `sync-machine-fleet.tsx`, `sync-machine-comparison.tsx` | Port rendering over pure transfer/comparison models |

The nested route shims accounted for by the Root/routing row are
`routes/skills.global.tsx`, `routes/skills.global.$skillName.tsx`,
`routes/skills.matrix.tsx`, `routes/skills.projects.$projectKey.tsx`, and
`routes/skills.projects.$projectKey.$skillName.tsx`. They are deleted only after
the equivalent SvelteKit route directories pass compile-time parameter and
deep-link tests.

## Design-system parity register

The design-system work is not “swap `@ark-ui/solid` for `@ark-ui/svelte`.” The
module interface includes controlled state, focus, DOM attributes, keyboard,
portals, responsive geometry and semantic tokens. Each row gets a Svelte render
test and at least one integrated browser consumer before the Solid adapter is
removed.

The production component files owned by this register are
`components/badge.tsx`, `components/checkbox.tsx`,
`components/drawer.tsx`, `components/metric-tile.tsx`,
`components/popover.tsx`, `components/segment-bar.tsx`,
`components/segmented-control.tsx`, `components/select.tsx`,
`components/tabs.tsx`, `components/toggle.tsx`, and
`components/tooltip.tsx`. The passive `.ts` style modules are owned by the
“Passive style modules” row.

| Design module | Current interface/implementation details to preserve | Target/gate |
| --- | --- | --- |
| Preset/global CSS | light/dark token sets, categorical harness/model/series colors, focus ring, line/surface hierarchy, keyframes, responsive conditions and WCAG contrast tests | Keep one framework-neutral `aiUsagePreset`; Panda Svelte scan must emit identical semantic tokens/classes; preset contrast and target-size tests unchanged |
| Semantic style exports | `report.ts` exposes layout/button/chart/field/overview/panel/refresh/skills/status/table/time classes; app imports stable names | Preserve export names and CSS layer order; generated CSS class/token snapshot or normalized CSS bundle gate detects omissions |
| `Toggle` | controlled `pressed`, disabled, accessible label/title, click plus pressed-change | Svelte Ark Toggle adapter; assert `aria-pressed`, click ordering, disabled and keyboard Space/Enter |
| `HarnessBadge` | passive span or interactive Toggle; family tones; active state; click stops parent row selection | Svelte passive/interactive branches over same pure tone functions; propagation and pressed-state browser test |
| `Checkbox` | controlled boolean, disabled, hidden native input, label, checked indicator/data-state | Ark Svelte Checkbox; form/a11y role/name/state and callback exactly once |
| `Drawer` | controlled open; optional modal/trap/outside-close; initial/final focus; portal; responsive bottom sheet/right drawer; Escape/focus return | Ark Svelte Drawer; complete option matrix, reduced motion, no background focus leak, existing session/a11y/visual tests |
| `Popover` | button trigger with optional label/title/class; lazy mount/unmount; 4px gutter; portal/z-index | Ark Svelte Popover/snippet adapter; trigger semantics, outside/Escape/focus, sticky-toolbar layering |
| `Tooltip` | 300ms default/open-delay override; lazy portal; trigger association; arbitrary content; provenance marker accessible fallback | Ark Svelte Tooltip; hover/focus/dismiss/delay plus provenance text/role tests |
| `MultiSelect` | controlled string array; multiple; stays open; reactive collection/labels; same-width popup; summary placeholder/one/count; highlighted/selected; portal z-index override | Ark Svelte Select; complete keyboard selection/deselection, label/value preservation, dynamic options and stacking tests |
| `SegmentedControl` | controlled single value; not deselectable; optional label/default marker; ToggleGroup keyboard behavior | Ark Svelte ToggleGroup; exactly one selection, arrows/Space, no empty value and URL callback parity |
| `Tabs` | controlled value; disabled items; composite keyboard; lazy/unmount; active panel forced into tab order after Zag frame | Ark Svelte Tabs; explicitly retain the `tabIndex=0` contract and test the post-animation-frame behavior rather than assuming adapter parity |
| `SegmentBar` | role image/label; positive segments only; stable proportional widths/titles; token anatomy fills | Mostly framework-neutral Svelte iteration; exact width/title/empty/zero tests |
| `MetricTile` | label/value/hint; optional delta arrow hidden from AT; comparison hint | Svelte passive view; existing render/presentation assertions |
| Passive style modules | button, chart color helpers, empty state, field, layout, overview, panel, refresh, skills, status, table, time slider | Keep framework-neutral functions/constants; prove no component import is required to consume them and CSS extraction includes every recipe |
| Icons | one `lucide-solid` import plus text/SVG glyphs with decorative/accessibility distinctions | Select equivalent Svelte icons or local SVG adapter; keep size/stroke/`aria-hidden`/labels and include icons in client bundle budget |

Design-system package shape after the transition:

```text
@ai-usage/design-system/preset       # framework-neutral Panda preset
@ai-usage/design-system/css          # generated functions/classes
@ai-usage/design-system/report       # semantic report styles, no component runtime
@ai-usage/design-system/svelte       # Svelte interactive/passive modules
@ai-usage/design-system/solid        # temporary compatibility during migration
```

The root export must not silently expose both runtimes. During coexistence,
callers use explicit `/solid` or `/svelte` entrypoints; at cutover the root may
point to Svelte only after all Solid imports are deleted. Ark peer dependencies
must also live behind the corresponding export so installing the final Web does
not retain the Solid runtime.

## Framework-foundation replacement register

This register accounts for behavior provided by the current framework stack,
including responsibilities that are easy to miss because they are not visible
as application features.

| Current foundation/interface | Current usage/evidence | Replacement seam and parity gate |
| --- | --- | --- |
| TanStack file routes and generated typed tree | root + `/`, `/sources`, `/sync`, `/skills` and five nested Skills files; `routeTree.gen.ts`; typed `Link`/navigate params | SvelteKit filesystem routes/generated `$types`; pure typed URL builders for links and dashboard search. Compile fixtures must reject missing/invalid route params and E2E covers every deep link |
| Router search validation/default stripping | `/` `validateSearch`, `stripSearchParams`, dashboard defaults/legacy parsing | Keep parser/canonical serializer as deep module; SvelteKit adapter reads `URLSearchParams` and emits minimal canonical URLs. Golden parse/serialize matrix is the interface test |
| Router loaders/cache/invalidation/error | report loader, infinite route stale time, explicit `router.invalidate`, error retry | SvelteKit universal load + TanStack Query. Critical fetch throws route error; current alias invalidation re-runs exact query option, not whole-route magic. Network-count and retry tests |
| Router navigation/history | `Link`, `useNavigate`, `useLocation`, `useRouterState`, numeric history ±1, replace vs push | One injected navigation port with SvelteKit adapter and in-memory test adapter; preserve scroll/history/selection semantics through interface tests |
| Router blocker | Skills `useBlocker` handles in-app route plus `beforeunload` with resolver | SvelteKit `beforeNavigate` cancellation + browser `beforeunload`, wrapped by one draft-navigation module returning keep/discard outcomes; test every exit path and listener cleanup |
| Router ClientOnly | Skills and Theme avoid SSR-specific browser values | Eliminate for Skills through SSR hydration; theme uses SSR-safe initial script/browser-only enhancement. No generic ClientOnly wrapper unless another browser-only interface is proven |
| Router scroll/not-found | `scrollRestoration: true`, default Not Found | SvelteKit navigation/snapshot behavior plus `+error`; browser tests for forward/back scroll, anchor/deep scroll and 404 |
| TanStack Start server functions | 30 wrappers, input validators, generated transport/serialization and server function warmup | Contract-first oRPC procedures/adapters with exact operation inventory, runtime schemas, typed errors, abort and HTTP integration. Remove warmup only at 30/30 parity |
| TanStack Start request middleware | `start.ts` composes demo rejection, trusted-local request validation and CSRF for every server function | `hooks.server.ts` handle sequence plus oRPC mutation middleware and explicit route checks. A generated endpoint/method matrix proves every RPC/file/SSE mutation crosses the required checks |
| TanStack Query provider/cache | root provider/defaults; Skills initial/inventory/mutation cache; quota history; source publication invalidation | scoped Svelte Query client and named policies. Preserve `setQueryData` post-mutation state, pending/error flags and no retry; eliminate broad invalidation; SSR/hydration/network-count tests |
| TanStack Table | column defs/meta/flex render, core/expanded row models, subrows, sorting, visibility, expansion callbacks | Prefer framework-neutral Table core or a thin Svelte adapter behind `SessionTableModel`; keep 25-column schema, row expansion, metadata and pure windowing. Table is not complete until 5,000-row and keyboard gates pass |
| Solid fine-grained reactivity | 157 signals, 239 memos, 60 effects, 24 mounts, 44 cleanups, 12 batches, 10 untracks, 590 Shows, 296 Fors, Suspense and portals across 88 files | Do not mechanically translate. Pure computation moves to `.ts`; local state uses `$state`, pure projections `$derived`, external subscriptions/DOM sync `$effect` with cleanup, lifecycle uses actions/onMount, markup uses `{#if}`/`{#each}`. Per-cluster controller tests prevent effect-order regressions |
| Solid context/root ownership | Query/source-control contexts and test-created reactive roots | Svelte context only for truly shared runtime modules; clients/controllers accepted as dependencies. Replace Solid-root unit tests with pure module/interface tests or Svelte render tests, not rune-internals tests |
| Solid SSR/hydration | `HydrationScript`, `renderToString`, eager-root workaround and 11 render-test files | SvelteKit native SSR/hydration; replace render assertions with Svelte SSR output/Playwright DOM while retaining semantic assertions. Remove eager-root workaround only after interactive hydration test |
| Ark UI Solid/Zag adapters | eight primitives with controlled state, portals and focus behavior | Explicit design-system `/svelte` adapters; the design parity register, not matching prop names, is authoritative |
| Panda Solid integration | Solid JSX scan and generated CSS/build-info ownership | Panda's documented Svelte/PostCSS scanning; retain preset/import map/build-info/generated ownership and CSS bundle gates |
| Nitro HTTP/plugin runtime | source-control handlers, observability plugin, Bun preset, separate build/output and SSE runner workaround | SvelteKit endpoints/hooks plus selected adapter. Preserve Web server interface: loopback, streaming, abort, status/headers, startup/shutdown and output isolation |
| Custom Vite/build glue | dep-scan JSX preserve, dedupe, serverFn warmup, route split workaround, ignored generated trees, production build lock | Delete only when corresponding SvelteKit behavior is proven. Carry ignored generated/output paths and build lock into new scripts; cold-dev and concurrent-build tool tests are deletion gates |

### Solid-to-Svelte translation rules

The rewrite must reduce framework coupling rather than reproduce it under new
syntax:

- `createMemo` that performs pure transformation becomes an ordinary pure
  function first; use `$derived` only when a component truly owns reactive input.
- `createEffect` is not translated one-for-one. Effects that derive state are
  redesigned as pure projections; effects that synchronize DOM/subscriptions use
  `$effect`/actions and return cleanup.
- Existing controller modules with `getState/subscribe/command` interfaces stay
  framework-neutral and receive a thin Svelte adapter. This applies especially
  to ServedReportSession, source control and the Markdown editor.
- `batch`/`untrack` sites are individually reviewed for atomic visible state and
  dependency suppression. Svelte's scheduling is not assumed equivalent without
  a transition test.
- `onMount`/`onCleanup` pairs become one owned lifecycle with an idempotent
  disposer. No listener, ResizeObserver, timer, EventSource or request controller
  survives unmount or navigation.
- Solid `Suspense` is not copied around arbitrary queries. Route-critical data
  belongs in awaited load; optional browser queries render explicit pending/
  refreshing/failed-with-prior-data states.
- Portals remain owned by the design-system adapters so feature modules do not
  learn Ark/Zag portal mechanics.

### Exact server-function replacement ledger

Wave 3 must track 30/30 operations. Target names can be refined in Wave 2, but
no operation may disappear or change method/error semantics implicitly.

| Current operation | Target procedure/transport |
| --- | --- |
| `getReportRevisionManifest` | `report.revisionManifest` query |
| `getReportRevisionBootstrap` | `report.revisionBootstrap` query |
| `getFocusedReportSupport` | `report.focusedSupport` query |
| `getFocusedReportOverview` | `report.focusedOverview` query |
| `getFocusedReportBreakdown` | `report.focusedBreakdown` query |
| `getReportSessionPage` | `session.page` query |
| `getReportSessionCampaignChildren` | `session.campaignChildren` query |
| `getReportSessionNeighbors` | `session.neighbors` query |
| `getReportSessionDetail` | `session.detail` query |
| `resolveReportSessionVcs` | `session.vcs` query |
| `getCampaignLabelOverrides` | `campaign.labelOverrides` query |
| `setCampaignLabelOverride` | `campaign.setLabelOverride` mutation |
| `saveProjectGroups` | `projectGroup.save` mutation |
| `getReportPerfEnabled` | request/runtime context or `runtime.reportPerfEnabled` query only if it cannot be derived safely |
| `getProviderQuotaHistory` | `quota.history` query |
| `getSkillManagementSnapshot` | `skills.snapshot` query |
| `refreshSkillManagementSnapshot` | `skills.refreshSnapshot` mutation despite its current GET wrapper, because it requests active refresh work |
| `getKnownSkillProjectPaths` | `skills.knownProjectPaths` query |
| `saveSkillManagementConfig` | `skills.saveConfig` mutation |
| `toggleManagedSkill` | `skills.toggleProjection` mutation |
| `reconcileManagedSkill` | `skills.reconcileOne` mutation |
| `reconcileAllManagedSkills` | `skills.reconcileAll` mutation |
| `previewReconcileAllManagedSkills` | `skills.previewReconcileAll` query only if proven side-effect free; otherwise mutation |
| `createManagedSkillTargetDirectory` | `skills.createTargetDirectory` mutation |
| `getSkillProjectInventories` | `skills.projectInventories` query |
| `getProjectSkillMarkdown` | `skills.projectMarkdown` query |
| `getManagedSkillMarkdown` | `skills.managedMarkdown` query; normalize current POST only after input/privacy tests |
| `saveManagedSkillMarkdown` | `skills.saveManagedMarkdown` mutation |
| `getSyncFleet` | `sync.fleet` query |
| `exportManualMergeBundle` | explicit download route; oRPC may issue bounded metadata/one-use identifier but never carries bundle bytes |

Method normalization above is intentional but cannot change trust/CSRF/cache
semantics. Wave 0 records whether each current GET is pure; any GET with durable
or external side effects becomes a mutation and receives CSRF protection.

## Test-parity and deletion register

Tests are migrated by interface, not mechanically translated by filename.

| Current test layer | Required treatment | Deletion gate |
| --- | --- | --- |
| Pure `.test.ts` models/controllers | Preserve unchanged after removing framework-only imported types; these are the highest-value stable interface tests | No Solid/TanStack import remains and all assertions still describe the same domain/presentation outcome |
| Solid-root controller tests | Move controller to framework-neutral interface where possible; otherwise replace with a Svelte adapter test | Equivalent transition/subscription/disposal cases pass without observing rune internals |
| 11 Solid SSR/render test files | Recreate semantic HTML/a11y assertions with Svelte SSR or focused Playwright; do not replace with snapshots alone | Every existing named assertion is mapped in Wave 0 and passes in replacement suite |
| Design preset/chart tests | Preserve unchanged | Same token/contrast/series results and generated CSS presence |
| Server `.server.test.ts` | Preserve at deep module interface; add oRPC handler integration above rather than replacing them | Existing server outcomes plus contract validation/error mapping pass |
| Router/search/navigation tests | Keep pure search tests; add SvelteKit adapter/in-memory navigation tests and browser history/scroll cases | Default/legacy/deep-link/blocker/retry/404/scroll matrix passes |
| Query tests | Add key/policy/cache transition tests independent from component rendering | Network counts and exact invalidation matrix pass in SSR/hydration E2E |
| Playwright functional specs | Keep test intent and selectors unless markup semantics legitimately improve; update harness/start command only | Every named current test is present and green against Svelte; removals require an explicit reviewed equivalence note |
| Axe/visual/geometry specs | Run after deterministic content settles; update snapshots only after DOM/token/geometry assertions pass | Light/dark, desktop/narrow, drawer and Skills settled artifacts reviewed |
| Production/scale/benchmark specs | Keep as cross-framework release authority | Initial SSR, paging, chronology, 5,000-row reachability, DOM/heap/network and lifecycle budgets pass |
| Demo privacy/negative tests | Preserve or strengthen; never mock away real adapter acquisition | Synthetic-only response and every protected local interface remain inert |

### Browser-suite preservation map

| Existing suite | Interface it freezes for the rewrite |
| --- | --- |
| `accessibility.spec.ts` | shared navigation, overflow, sticky destination, light/dark focus, reduced motion and Axe gates for Overview/drawer/Skills/Sources/Sync |
| `audit-performance.spec.ts` | deterministic settled DOM measurements used by the performance audit |
| `campaign-label-overrides.spec.ts` | local rename/reset without filter identity drift |
| `category-visibility.spec.ts` | populated harness/machine visibility under default filters |
| `dashboard-presentation.spec.ts` | metric qualification/provenance, source freshness, token/spend encoding, Overview hierarchy, Punchcard/timeline geometry and mobile filter stack |
| `dashboard.spec.ts` | report load/pending/retry, navigation/deep links, share/export, quota, URL filters, drawer, session presets, charts, responsive state and explicit sync boundary |
| `demo-privacy.spec.ts` | synthetic-only app and inert local interfaces |
| `drawer-value-presentation.spec.ts` | token magnitude and accessible drawer explanation |
| `machine-staleness.spec.ts` | stale-machine presentation without raw filter-value drift |
| `origin-campaign.spec.ts`, `origin-gap.spec.ts` | neutral origin, bounded campaign roots, legacy URL handling and undeclared-origin gap causes |
| `production-report.spec.ts` | real production SSR, source control, focused refresh stability, exact-revision paging, chronology/VCS and mobile paging |
| `session-viewport-geometry.spec.ts` | virtual viewport anchoring on desktop/mobile |
| `skills.spec.ts` | complete editor/draft/conflict/refresh/Inspector/workspace/unmanaged/mobile/matrix interface |
| `sources.spec.ts` | catalogue, independent commands, publication, partial SSE rejection, deviation/progress presentation |
| `theme.spec.ts` | pre-hydration theme resolution and toggle naming |
| `time-range.spec.ts` | report-range/chart/heatmap/Punchcard controls, grouping, URL commit, wheel and canonicalization |
| `value-presentation.spec.ts` | measured/partial/zero Breakdown distinction |
| `visual-regression.spec.ts` | settled desktop/narrow Overview, drawer and Skills visual artifacts |
| `session-scroll.scale.ts` | every top-level production campaign reached exactly once at both viewports |
| `session-scroll-benchmark.scale.ts` | repeatable production scroll samples and retained budget comparison |

The Solid render suites
`dashboard-metrics.render.test.tsx`, `drawer-detail-item.render.test.tsx`,
`group-panel.render.test.tsx`, `highlighted-text.render.test.tsx`,
`overview.render.test.tsx`, `project-summary.render.test.tsx`,
`session-analysis.render.test.tsx`, `session-drawer.render.test.tsx`,
`session-vcs-summary.test.tsx`, `skills-detail.render.test.tsx`, and
`sync.render.test.tsx` also receive explicit replacement IDs. Their semantic
assertions move to Svelte SSR/render or focused Playwright tests; they are not
discarded merely because the renderer changed.

Wave 0 creates the schema/checker plus domain shards under
`apps/web/migration-parity/` (or an equivalent tool-owned data path), with stable
feature IDs, current test titles and target gates. The coordinator owns schema
and aggregation; family packets own only their assigned shard. Wave 12 fails if:

- a feature ID has no passing Svelte evidence;
- a current E2E test title was deleted without an explicit replacement ID;
- a production TSX file is neither ported nor recorded as intentionally removed;
- a design-system export lacks a Svelte consumer/test or an explicit
  framework-neutral classification;
- one of the 30 server operations is not mapped to RPC/context/file transport;
- a forbidden foundation package remains reachable from the client manifest.

## Target layout

```text
packages/web-contract/
  src/contract.ts                 # contract composition only
  src/errors.ts                   # closed public errors
  src/report.ts                   # report/campaign/quota schemas
  src/session.ts                  # exact-revision Session schemas
  src/skills.ts                   # Skills schemas
  src/control.ts                  # browser-facing command contracts
  src/sync.ts                     # JSON metadata only
  src/*.test.ts

apps/web/src/lib/
  foundation/                     # framework-neutral navigation/table/lifecycle seams
  rpc/client.ts                   # browser client factory, contract only
  query/client.ts                 # scoped QueryClient factory
  query/policies.ts
  query/options/report.ts
  query/options/session.ts
  query/options/skills.ts
  query/options/sync.ts
  features/shell/**/*.svelte
  features/report/**/*.{ts,svelte}
  features/sessions/**/*.{ts,svelte}
  features/skills/**/*.{ts,svelte}
  features/sources/**/*.{ts,svelte}
  features/sync/**/*.{ts,svelte}

apps/web/src/lib/server/
  rpc/context.ts                  # request-scoped capabilities
  rpc/router.ts                   # contract implementation composition
  rpc/report.ts
  rpc/session.ts
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
| Session benchmark | `bun run --cwd apps/web benchmark:session-scroll` | production scroll samples pass within recorded budgets |
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

## Autonomous single-PR execution protocol

The implementation is delivered as **exactly one implementation PR**. A single
implementation PR does not mean one commit, one worktree or linear work. It
means one coordinator owns one integration branch while autonomous workers
produce reviewed local commits from isolated worktrees. Packet branches are
never pushed and never receive PRs.

This planning PR is not the implementation PR. After the runtime-split branch
and this plan are merged, packet B0 creates the implementation branch from the
then-approved `origin/main`. The coordinator opens exactly one implementation PR
only after packet X2's local clean-worktree gate and independent `ACCEPT`.
Opening that PR triggers its CI; plan 068 becomes DONE only after that CI is
green and any CI-driven fix has been re-reviewed.

### Entry gate

Before dispatching any implementation packet, the coordinator must:

1. Confirm plans 066/067 and this plan are present in `origin/main` and record
   the exact `BASE_SHA` in `plans/068-execution-state.md`.
2. Run the complete current Solid verification commands from a clean worktree.
   The base must be green with no allowlisted migration failure. At plan
   reconciliation, `bun run check` and `bun run lint` pass on `72c648e`; B0 must
   still run the complete gate against the later post-plan `BASE_SHA`.
3. Re-run the drift check against `BASE_SHA`, reconcile path/test/operation
   inventory changes, and STOP on any changed served-revision, direct-read,
   sole-writer, trust or demo-privacy invariant.
4. Create one local integration branch named
   `agent/migrate-web-sveltekit-orpc`. Only the coordinator may check it out,
   merge into it, rebase it, push it or open its PR.
5. Create `plans/068-execution-state.md` with the base SHA, integration HEAD,
   frozen decisions, packet states, worker/reviewer commit SHAs, accepted gates,
   deviations and current integration checkpoint. This is execution evidence,
   not a substitute for the machine-readable parity ledger.
6. Confirm each worker can create an isolated worktree with its own temporary
   home, store, ports, logs, rendezvous and build-output paths.

No packet may start from the planned `72c648e` automatically. It starts from the
exact post-plan integration checkpoint named in its dispatch card.

### Roles and scheduler

**Coordinator/integrator**:

- owns the integration branch, execution state, dependency scheduler, shared
  files and exclusive process-test lane;
- freezes interfaces before fan-out, creates packet dispatch cards, reviews
  scope and cherry-picks only accepted commits;
- performs all composition, dependency/lockfile changes, generated-file updates,
  old-code deletion and GitHub actions;
- never rewrites a worker's domain implementation while integrating it. A
  semantic conflict returns to the worker on a fresh checkpoint.

**Implementer**:

- works only in the packet worktree and path/symbol allowlist;
- reads this complete plan plus its dispatch card, implements tests with code,
  commits atomically and returns the handoff contract below;
- never edits coordinator-owned files, updates the global ledger schema/aggregate
  outside its assigned family shard, weakens a gate, merges/rebases the
  integration branch, pushes or opens a PR.

**Independent reviewer**:

- did not implement the packet and reviews `packetBase..packetHead` read-only;
- separately checks parity/spec and code quality/seam discipline;
- returns `ACCEPT`, `REWORK` or `STOP` with exact file/symbol evidence. `REWORK`
  returns to the original implementer; the reviewer does not silently fix it.

Use all available child slots for ready implementation packets. Do not reserve a
reviewer permanently: as packets finish, use idle agents for circular cross-
review while other lanes continue. Reviews take scheduling priority when two
accepted-but-unreviewed packets are queued, preventing a large unverified merge
batch. The coordinator remains available for integration, interface decisions
and user-visible progress.

### Worktree and commit protocol

For packet `<ID>` at checkpoint `<SHA>`:

1. The coordinator creates branch `agent/068-<id>-<slug>` and an isolated
   worktree from `<SHA>`; the branch is local-only.
2. The dispatch card freezes dependencies, interfaces, parity IDs, allowed paths,
   forbidden paths, commands and STOP conditions. An agent may not infer broader
   authority from this program plan.
3. The worker adds before removing. Solid remains authoritative until the
   packet's convergence owner switches its assigned interface.
4. The worker commits one logical change per independently reviewable outcome.
   Generated output, package-manager caches and build artefacts are excluded.
5. A different agent reviews the commit range. The original worker performs any
   rework in the same worktree and returns a new head SHA.
6. The coordinator confirms the changed-path allowlist, reruns the packet gate,
   cherry-picks the accepted commits in DAG order and records them in execution
   state.
7. If cherry-pick has a semantic conflict, abort it and create a new packet
   worktree from the latest compatible checkpoint, then reapply/rework the
   commits there. The coordinator may resolve only mechanical composition-file
   conflicts. A generated-file conflict is resolved by regenerating from its
   accepted sources, never by editing conflict markers manually.

The coordinator may push only the integration branch at reviewed green
checkpoints as a backup. No PR is opened at those checkpoints. Exactly one
implementation PR is opened after X2's local gate; worker branches are never
pushed. Its CI is the post-open final gate.

### Mandatory packet dispatch card

Every worker prompt must contain all of these fields; a missing field means the
packet is not ready to dispatch:

| Field | Required content |
| --- | --- |
| Identity | packet ID/title, implementer role, risk and expected maximum size |
| Base | exact integration `baseSha`, prerequisites already integrated and drift command limited to owned paths |
| Parity | feature/operation/design/test IDs the packet must satisfy; no unscoped “port this feature” |
| Frozen inputs | exact upstream interfaces, decisions and files to consume without modifying |
| Write set | exclusive allowed paths and any symbol-level restriction in otherwise shared files |
| Denylist | coordinator/shared files and adjacent domains that must not change |
| Deliverables | named modules, adapters, tests and evidence the packet returns |
| Gates | exact targeted commands and expected exit/result, including write-set and bundle-boundary checks |
| STOP | packet-specific false assumptions, interface changes, invariant failures and two-attempt limit |
| Handoff | required commit SHAs, changed paths, parity evidence, test results, dependency/config requests and residual risks |

The worker's final handoff uses this exact shape:

```text
Packet: <ID>
Base: <SHA>
Commits: <SHA...>
Changed paths: <list>
Parity IDs/evidence: <ID -> test/command>
Commands: <command -> result>
Requested integration deltas: <none or precise manifest/config/composition change>
Deviations/risks: <none or precise STOP/review item>
```

### Coordinator-owned hot files

These paths serialize the program. Feature workers request a precise integration
delta rather than editing them. A foundation packet may own one only where its
register row names that exact responsibility; after that packet converges, the
path returns to coordinator ownership:

| Area | Coordinator-only paths/responsibility |
| --- | --- |
| Workspace/dependencies | root `package.json`, `bun.lock`, `turbo.json`, root TypeScript/Biome/Lefthook/CI configuration; all dependency/version updates |
| Web runtime | `apps/web/package.json`, `apps/web/tsconfig*.json`, `apps/web/svelte.config.*`, `apps/web/vite.config.ts`, `apps/web/panda.config.ts`, `apps/web/start.mjs`, `apps/web/vite-{production-build,output-paths,warmup}*` |
| SvelteKit composition | `apps/web/src/app.d.ts`, `apps/web/src/hooks.server.ts`, root `routes/+layout*`, `routes/+error.svelte`, root `routes/+page*` and global providers |
| RPC composition | `apps/web/src/lib/server/rpc/context.ts`, `router.ts` and `/rpc/[...rest]/+server.ts`; V0 temporarily owns the pure request-policy schema/matrix, V5 owns its composition |
| Contract composition | `packages/web-contract/package.json`, root export map and `src/contract.ts`; V1–V4 own only disjoint family leaves, V5 owns composition |
| Query composition | Q0 temporarily owns `lib/query/client.ts`, common key/policy vocabulary and pure harness; Q3 owns provider/root wiring and aggregate invalidation composition; family option files remain family-owned |
| Design public surface | `packages/design-system/package.json`, `src/index.ts`, `src/report.ts` and final `/solid`/`/svelte` export-map changes; D0 temporarily owns `src/preset.ts`, `preset.test.ts`, passive style modules and its CSS harness, while D4 owns public composition |
| Tests/harnesses | Playwright configs/helpers/production server, `dashboard.spec.ts`, `production-report.spec.ts`, accessibility, demo privacy, audit-performance, visual regression and snapshots |
| Generated/global evidence | `routeTree.gen.ts` until deletion and generated manifests; B1 temporarily owns parity schema/aggregator/checker and ADR 0010, while plan/execution state/README/architecture remain coordinator-owned |
| Cutover | root scripts, old TSX/server-function/runtime deletion, Solid/Nitro dependency removal, final lockfile and docs |

Only the coordinator runs an installation that may modify manifests or
`bun.lock`; those changes land in the same checkpoint. Workers may run only
`bun install --frozen-lockfile` when an isolated worktree needs dependencies.
Never use `bun update` during this program.

Never edit `routeTree.gen.ts`, generated Panda `styled-system`, `.svelte-kit`,
Turbo caches or build outputs manually. Extend the architecture scanners to
`.svelte` in B1/F0; otherwise the migration could reintroduce the client/server
leaks it is intended to eliminate.

### Parallel ownership seams

Feature and family modules live behind small interfaces. Route files, the oRPC
router, contract composition and providers assemble them; they do not contain
their implementation. The target write-set prefixes are:

```text
packages/web-contract/src/
  report*.ts                 # report/campaign/project-group/quota contract owner
  session*.ts                # Session contract owner
  skills*.ts                 # Skills contract owner
  control*.ts, sync*.ts      # Sources/control/Sync contract owner

apps/web/src/lib/
  foundation/                # framework-neutral navigation/table/lifecycle seams
  rpc/                       # browser adapter; composition coordinator-owned
  query/options/             # one directly imported file per family
  server/rpc/                # one implementation leaf per contract family
  features/
    shell/
    report/
    sessions/
    skills/
    sources/
    sync/

packages/design-system/src/svelte/
  passive/
  controls/
  overlays/
  compound/
```

Do not add feature barrels. Import the exact module needed. Each feature exposes
one narrow page/destination module interface for coordinator-owned route/shell
composition. Deep server modules under `apps/web/src/server/*.server.ts` remain
implementation owners; RPC leaves adapt their interfaces and do not copy SQL,
filesystem or domain workflows.

Before UI fan-out, F0 removes only structural framework types that can be shared
without the new transport/cache existing: dashboard search/sort/navigation
intent, table sorting/visibility/updater shapes and subscription primitives.
Report lifecycle moves behind its Svelte seam in P1, Session selection in P4,
and the shared Skills controller in P5 after their V/Q dependencies exist. P4 alone
owns `dashboard-session-selection` and its new adapter; P3 exposes only table,
query and row-identity interfaces. P5 alone owns the shared Skills
route/snapshot/query controller; P9 owns only editor/draft adaptation and a
blocker integration request. Solid and Svelte adapters then exercise the same
seam. This is justified by two real adapters during migration; do not create
ports around code with only one implementation.

### Machine ledger sharding

The parity ledger must not become a concurrent-edit bottleneck:

- B1 owns its schema, checker and read-only aggregate.
- Each packet owns one shard under
  `apps/web/migration-parity/<packet-or-family>.ts` (or equivalent tool-owned
  data path) and may update only its assigned IDs/evidence. Parallel design and
  Skills packets therefore use separate shards rather than sharing one family
  file.
- The aggregate is generated or composed deterministically without a hand-edited
  barrel. The coordinator alone changes the schema, ID assignment or reviewed
  removal records.
- The checker fails on duplicate IDs, missing current inventory, evidence for a
  non-integrated commit, or an agent editing another family's shard.

### Quality and test lanes

Every packet receives independent review before integration. Review has two
separate verdicts:

1. **Parity/spec** — assigned IDs, behavior, errors, lifecycle and test intent
   match this plan.
2. **Code quality/seams** — explicit client/server graph, deep-module ownership,
   injected dependencies, cleanup/cancellation, SSR isolation and maintainable
   Svelte code match repository standards.

For `COORDINATOR` packets, “before integration” means before accepting the new
checkpoint or dispatching any dependent packet: the coordinator commits a
bounded range on the integration branch, a different agent reviews that range,
the coordinator performs any rework, and the same independent verdict is
required again. Being already present on the integration branch does not waive
packet review.

Packet worktrees run only deterministic scoped gates:

- changed-path allowlist and `git diff --check`;
- targeted Ultracite/Biome check without unrelated formatting;
- unit/contract/render tests named in the packet;
- affected workspace typecheck/`svelte-check` and shadow build when applicable;
- assigned parity shard and client/server graph checks;
- no unexpected generated, manifest or lockfile changes.

After each accepted cherry-pick or coordinator packet, the coordinator runs repository architecture
lint, aggregate parity check, affected workspace tests/typecheck and the shadow
build. At B1, B2, F0, V5, Q3, D4, R1, X0, X1 and X2 checkpoints, run
`bun run check`, `bun run lint`, `bun run typecheck`, `bun run test` and
`bun run build`, plus the integrated browser subset named by that checkpoint.

One coordinator-managed **exclusive process-test token** serializes suites that
share authoritative scripts, ports, process trees, outputs or expensive browser
state. Workers do not run these concurrently unless the dispatch card supplies
proven isolated ports/outputs:

- complete Playwright functional, Axe and visual suites;
- demo privacy and production report/Session scale;
- Web production lifecycle, dev/build isolation and setup loopback;
- long SSE, bundle/manifest, heap, request/timing and startup measurements.

At final PR time, split `.github/workflows/pr-checks.yml` into independently
parallel jobs for static/types, unit/build, lifecycle (including
`test:web-dev-build-isolation`), functional E2E and demo/production E2E while
preserving every current command and artifact. Cache only paths proven safe;
the deliberately uncached Web production build must remain uncached. This may
not remove a check, change test semantics or hide a failure behind
`continue-on-error`.

For optional remote feedback before the PR exists, the coordinator may push a
green integration checkpoint and start the existing `workflow_dispatch` at that
exact ref. This never authorizes a worker push or an intermediate PR.

### Failure and rework policy

- An allowlist violation or unapproved interface change is `REWORK`, even if the
  implementation appears correct.
- A semantic cherry-pick conflict, changed upstream interface or stale base
  causes redispatch from the latest compatible checkpoint, not improvised
  integration.
- One flaky-looking failure may be rerun once for classification. Never add
  `.skip`, weaken an assertion, increase a timeout without measurement or accept
  a red-baseline delta.
- A packet failing the same invariant twice reaches its packet/program STOP
  condition. Independent lanes may continue only if they do not depend on it.
- Integration regressions remove the offending packet from the queue and return
  it to its owner; do not stack unrelated fixes on top of a red checkpoint.

Before X2, fetch `origin/main`. If it differs from B0's base, the coordinator
alone rebases/reconciles the integration branch, updates every rewritten SHA in
execution state, redispatches semantic conflicts to their owners, and reruns X1
plus the full gates. The cold reviewer uses the resulting final merge-base.
Fetch again immediately before opening the PR: any new relevant `main` change
invalidates the previous `ACCEPT`. If `main` advances after the PR opens, repeat
the affected full gates and X2 review before merge; never rely only on GitHub's
mergeability flag.

## Work-packet dependency graph

The scheduler dispatches packets, not whole waves. `COORDINATOR` packets are
serialized on the integration worktree. All other ready packets use isolated
worktrees and independent review.

```text
B0 ──┬── B1 ──┐
     └── B2 ──┴── F0 ──┬── V0 ──┬── V1 ──┐
                       │        ├── V2 ──┤
                       │        ├── V3 ──┼── V5 ── Q0 ──┬── Q1 ──┐
                       │        └── V4 ──┘               └── Q2 ──┴── Q3
                       │
                       └── D0 ──┬── D1 ──┐
                                ├── D2 ──┼── D4
                                └── D3 ──┘

F0 + V5 + Q3 + D4 ── R0 ── R1

R1 ──┬── P1 ──┬── P2 ──────────────┐
     │        ├── P8 ──────────────┤
     │        └── P3 ── P4 ───────┤
     ├── P5 ──┬── P9 ─────────────┤
     │        └── P10 ────────────┤
     ├── P6 ──────────────────────┼── X0 ── X1 ── X2
     └── P7 ──────────────────────┘
```

Critical-path packets receive the first free worker. Remaining slots take ready
design or feature packets. With three child slots, V1/V2/V3 are the first large
cohort; after R1, P1/P5/P6 can run while P7 takes the next slot, followed by
P2/P3/P8 and P9/P10 as their shallow prerequisites finish. Review reuses those
same agents in a circle instead of dedicating one slot permanently to review.

### Packet register

| ID | Owner/dependencies | Exclusive deliverable and parity ownership | Integrated gate / STOP focus |
| --- | --- | --- | --- |
| B0 Lock execution base | **COORDINATOR**, none | Entry gate, integration branch, execution state, exact baseline SHA, dispatch/denylist mechanics | Current Solid full suite green; STOP on red base or invariant drift |
| B1 Freeze parity and budgets | B0 | Wave 0 characterization, ledger schema/shards/checker, 30-op and test inventory, performance baseline, `.svelte` graph-scanner coverage | 100% current features/ops/TSX/design/tests owned; demo negative gates and reproducible budgets |
| B2 Resolve runtime ecosystem | B0 | Disposable Wave 1 adapter/version/oRPC/Query/Ark/Panda spike and lifecycle decision; exercise the existing `usage-engine-control/node` identity/liveness helpers rather than copying them; no production app port | SSR, illegal import, abort, >30s SSE, clean shutdown/output and unchanged private file/process checks; STOP if neither adapter passes |
| F0 Freeze shared foundations | **COORDINATOR**, B1+B2 | Dependency/lockfile checkpoint, Svelte shadow skeleton, target directories, structural navigation/table/subscription types, composition stubs and frozen public conventions; add `.svelte-kit` to `.gitignore`/recursive-scanner ignores and generated-tooling ownership docs | Solid remains green; shadow build/typecheck/boundary fixtures green; clean `git status` has no generated output and no unresolved downstream choice |
| V0 Contract/request-policy kernel | F0 | Pure errors/schema conventions, request-policy interface/matrix and contract tests; no family procedures | Contract closure has no server imports; method/trust/CSRF/body/error policies mechanically testable |
| V1 Report/campaign/quota vertical | V0 | Assigned report/campaign/project-group/quota contracts, RPC leaves, handler tests and Solid client adapters | Assigned operations mapped; exact/current semantics, typed errors and no deep-logic copy |
| V2 Session vertical | V0 | Session page/children/neighbors/detail/VCS contracts, RPC leaves, tests and Solid adapters | Exact revision/fingerprint/abort/supersession gates; no table/UI work |
| V3 Skills vertical | V0 | Skills contracts, RPC leaves, tests and Solid adapters | Filesystem authority, dirty/conflict semantics and demo acquisition isolation |
| V4 Control/Sources/Sync vertical | V0 | Sync/control RPC metadata, policy classification, Solid callers and temporary Nitro adapters only; freeze final SvelteKit endpoint interfaces for P6/P7; Web imports neither `usage-merge` nor engine-runtime | Trust/CSRF/byte/path/staging-abort/late-cleanup; no file bytes or SSE hidden in RPC, no writer-package reachability and no final SvelteKit endpoint leaf |
| V5 Transport convergence | **COORDINATOR**, V1+V2+V3+V4 | Compose contract/router/context/Nitro handler, apply request policy globally, switch Solid callers, retire serverFn wrappers at 30/30 | Solid unit/demo/production gates through oRPC; no serverFn/warmup or policy bypass |
| Q0 Query core | V5 | Exclusive temporary ownership of `lib/query/client.ts`, common key/policy vocabulary, hydration/dehydration seam and framework-neutral cache test harness | No global client/default infinite stale; concurrent request isolation and abort proof |
| Q1 Report/Session/quota policies | Q0 | Family keys/options, exact/current invalidation, retained-data SWR and bounded GC | No duplicate bootstrap, immutable refetch or publication-wide invalidation |
| Q2 Skills/Sync policies | Q0 | Skills markdown/snapshot and Sync fleet keys/options/mutation cache updates | Independent finite SWR; dirty buffers stay client state; smallest-key updates |
| Q3 Query convergence | **COORDINATOR**, Q1+Q2 | Provider/composition, publication mapping and integrated network-count/cache/heap gates | Query ownership matrix complete; unrelated invalidation count is zero |
| D0 Neutral design foundation | F0 | Exclusive temporary ownership of `preset.ts`, `preset.test.ts`, passive style modules and normalized CSS comparison harness; no public root exports/manifest | No unexplained token/class/CSS loss; no Svelte/Solid runtime in passive closure |
| D1 Basic Svelte controls | D0 | Toggle, HarnessBadge, Checkbox, MetricTile and SegmentBar Svelte modules/tests/fixture consumers | Controlled state, propagation, semantic/accessibility and render parity |
| D2 Overlay Svelte controls | D0 | Tooltip, Popover and Drawer Svelte modules/tests/fixture consumers | Portal, focus, Escape, outside interaction, lazy mount and cleanup parity |
| D3 Compound Svelte controls | D0 | Tabs, SegmentedControl and MultiSelect Svelte modules/tests/fixture consumers | Keyboard, hidden input, open-state, focus/tabindex and selection parity |
| D4 Design convergence | **COORDINATOR**, D1+D2+D3 | Public `/svelte`/temporary `/solid` exports, dependency-closure test, fixture consumers and CSS/token aggregate; no application shell/theme/navigation | Solid and shadow fixtures green; Svelte closure cannot reach Solid/Ark Solid |
| R0 URL/navigation adapters | F0+V5+Q3+D4 | Framework-neutral URL/history intent plus Svelte navigation, scroll, error-retry and dirty-blocker adapters under `lib/foundation/navigation/svelte/**`; no route/layout files | Direct/reload/deep-link/history/scroll/blocker adapter tests; no application composition |
| R1 Routes and application shell | **COORDINATOR**, R0 | SvelteKit route skeletons, thin page composition, `features/shell`, theme bootstrap/nav, error/404, global providers and demo hook | Direct/reload/deep-link/history/scroll/error/demo/a11y shell matrix green |
| P1 Report SSR/lifecycle | R1+V1+V2+Q1+D4 | `features/report/core/**` and `features/report/lifecycle/**`: bootstrap/status/workspace and ServedReportSession rune adapter; root-page integration requested, not edited | Meaningful HTML, one bootstrap, expiry/supersession/atomic acceptance and no global loading replacement |
| P2 Overview/range/charts | P1 | `features/report/overview/**` and `features/report/range/**`: metrics, provider status, time controls, timeline, heatmap and Punchcard plus assigned specs | Presentation/value/range/keyboard/a11y/geometry gates; no Breakdown/filter/actions files |
| P3 Sessions table | P1+V2+Q1+D4 | `features/sessions/table/**`: schema adapter, paging, campaign expansion, virtualization and responsive projections | 25 columns/presets and 5,000-row DOM/heap/network/keyboard budgets |
| P4 Session drawer/analysis | P3 | `features/sessions/detail/**`: Drawer selection/navigation/detail/VCS/chronology/multi-harness analysis modules | Focus/Escape/history/neighbors/abort and recorded/partial/unavailable trust semantics |
| P5 Skills shell/SSR | R1+V3+Q2+D4 | `features/skills/shell/**`, tree/workspace/Inspector composition interface, SSR data adapter and Skills route-leaf request; editor/health/matrix are slots | Settled SSR, no duplicate load, nested selection/responsive shell and demo acquisition isolation |
| P6 Sources/SSE | R1+V4+Q2+D4+B2 | `features/sources`, final explicit Svelte EventSource owner and SvelteKit endpoint leaves in Sources-owned prefixes; adapt the existing engine snapshot broker/control stream without duplicating them; shared shell summary requested | Snapshot/replay/heartbeat/reconnect/abort/backpressure, sanitized state, no Query ownership and no Web-owned snapshot waiting/fan-out |
| P7 Sync/files/observability | R1+V4+Q2+D4 | `features/sync`, fleet UI, final SvelteKit manual-transfer endpoints and Web observability leaves in Sync-owned prefixes; forward request abort into staging and preserve cleanup of late staging success | Byte/path/trust/opaque-ID/staging-abort/late-cleanup/recovery and single-init/teardown gates; no `usage-merge` reachability from Web |
| P8 Breakdown/filters/actions | P1 | `features/report/breakdown/**` and `features/report/actions/**`: filters, grouping, breakdown, labels, CSV/share and quota plus assigned specs | Value/filter/URL/CSV/quota/a11y/visual DOM gates; no Overview/range files |
| P9 Skills editor/draft | P5 | `features/skills/editor/**`: Markdown controller adapter, shortcuts, dirty/conflict/pending replacement and navigation-blocker integration request | Exact draft preservation, save/refresh conflict, keep/discard/focus and cleanup gates |
| P10 Skills health/reconcile/matrix | P5 | `features/skills/management/**`: health, diagnostics, context, reconcile/consolidation and matrix modules | Filesystem authority, unmanaged safety, preview/apply, projection and responsive matrix gates |
| X0 Feature convergence | **COORDINATOR**, P2+P8+P4+P9+P10+P6+P7 | Compose root/routes/contexts, apply requested deltas/evidence, run global ledger and integrated functional/demo/production/scale suites | No missing ID/test/title/export/op; semantic conflicts return to feature owner |
| X1 Cut over and delete | **COORDINATOR**, X0 | Wave 12 scripts/runtime/supervisor/CI split, remove Solid/Start/Nitro/old TSX/glue, retain the shared control/node identity seam, final manifests/lockfile/docs/performance | Clean install and every pre-PR final criterion; STOP on manifest/server leak, Web writer-package reachability, duplicated identity logic, unmapped removal or >10% unexplained regression |
| X2 Reconcile and cold final review | **COORDINATOR** plus independent fresh-context reviewer, X1 | Fetch `origin/main`; if it advanced, coordinator rebases/reconciles, redispatches semantic conflicts and reruns full gates. Then review final merge-base-to-HEAD parity/spec, security boundaries, design closure, generated output and code quality | Reviewer ACCEPT plus full clean-worktree gate at unchanged final base; then push/open the one implementation PR and require its CI green before DONE |

Workers must receive a packet-specific expansion of the register row using the
mandatory dispatch card. The register does not authorize them to modify every
file mentioned elsewhere in a wave.

## Git and delivery

- The coordinator-owned implementation branch is the only branch pushed and the
  only branch that receives a GitHub PR.
- Packet branches/worktrees remain local and deliver atomic commits for
  independent review and cherry-pick; never squash the whole program while work
  is in progress because bisectable convergence commits are quality evidence.
- Waves below are integrated behavior gates. They do not imply one PR, one
  worker or blanket ownership of the files named by that wave.
- A shadow Svelte entry may coexist inside `apps/web`, but root production stays
  Solid until X1/Wave 12.
- Never allow both apps to mutate real Skills/send engine commands in ordinary
  production; shadow execution is demo/E2E-only until cutover.
- Delete the retired runtime only in X1 after X0 convergence. Do not open the
  implementation PR until X2's local gate passes, and do not mark plan 068 DONE
  until that sole PR's CI is green.

Primary wave-to-packet mapping:

| Wave | Primary packets |
| --- | --- |
| 0 characterization | B0, B1 |
| 1 ecosystem decision | B2 and the dependency/config part of F0 |
| 2 contract/guards | F0 structural seams, V0 |
| 3 oRPC on Solid | V1–V5 |
| 4 cache ownership | Q0–Q3 |
| 5 shadow/design system | F0 shadow bootstrap, D0–D4 |
| 6 routes/URL shell | R0, R1 |
| 7 report SSR/lifecycle | P1 |
| 8 report destinations/actions | P2, P8 |
| 9 Sessions | P3, P4 |
| 10 Skills | P5, P9, P10 |
| 11 Sources/Sync/files | P6, P7 |
| 12 convergence/cutover | X0, X1, X2 |

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
7. Create the sharded machine-readable parity ledger named in “Test-parity and
   deletion register.” Seed every feature ID, all 30 server operations, every
   production TSX file, every design-system export and every current Playwright
   test title. Each record contains `currentOwner`, `targetOwner`, `evidence`,
   `status` and optional reviewed `replacementReason`; no free-form “covered”
   boolean. Schema/aggregation are coordinator-owned and family shards have
   disjoint ID/write ownership.
8. Add a read-only checker that compares every shard and its deterministic
   aggregate with filesystem exports, server-function inventory and
   Playwright-discovered titles. It fails on duplicate/cross-shard IDs or
   evidence from non-integrated commits. At this wave the Solid entries are
   expected to be current; missing/unowned entries fail.

**Gate**: unchanged Solid Web unit, E2E, demo and production suites pass, the
baseline is reproducible, and the parity checker accounts for 100% of current
features/operations/TSX/design exports/browser tests.

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
7. Specify the request-policy matrix for every RPC and explicit HTTP route:
   public method, demo availability, trusted-local requirement, CSRF requirement,
   maximum body/response class and observable error family. Generate handler
   tests from this data rather than relying on a convention in router files.

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
7. Move TanStack Start's demo, trusted-local and CSRF middleware semantics to a
   transport-independent request-policy module with adapters for the temporary
   Nitro handler and future SvelteKit hook. Prove every mutation/file endpoint
   crosses the same policy before retiring `start.ts`.
8. Delete `createServerFn` wrappers only when inventory parity is complete;
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
3. Split design-system framework-neutral styles, explicit `/solid` compatibility
   exports and `/svelte` primitives. Add an export-condition test proving the
   Svelte dependency closure cannot reach `solid-js` or `@ark-ui/solid`.
4. Port the complete design-system parity register in dependency order: passive
   token/style modules, Toggle, HarnessBadge/Checkbox, Tooltip/Popover,
   SegmentedControl/Tabs/MultiSelect, then Drawer. For every module, land its
   controlled-state/focus/keyboard/render tests and at least one real Svelte
   consumer before marking its ledger row complete.
5. Add narrow Svelte render tests where useful; rely on Playwright for integrated
   behavior rather than adding a redundant browser framework.
6. Build root layout, error boundary, theme bootstrap and navigation shell with
   matching SSR/hydration.
7. Compare normalized generated CSS/token exports between Solid and Svelte
   builds. Differences require classification as framework syntax only,
   intentional unused-code removal, or a parity defect; unexplained omissions
   fail the wave.

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
5. Implement the draft-navigation module replacing `useBlocker`, including
   SvelteKit navigation cancellation/resolution, `beforeunload`, keep/discard,
   focus return and idempotent listener cleanup.
6. Implement and test scroll restoration, numeric history traversal, 404 and
   error retry explicitly; do not assume SvelteKit defaults equal TanStack
   Router's configured behavior.
7. Test direct deep links, reload, copy/paste, legacy values and history.

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

**Gate**: Session/drawer/VCS/analysis and production scale pass, and
`bun run --cwd apps/web benchmark:session-scroll` exits 0 within Wave 0 budgets.

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
   replay, heartbeat, abort, reconnection and backpressure. Adapt the existing
   engine source-snapshot broker/control event stream; do not recreate snapshot
   waiting or fan-out in Web.
3. Port EventSource owner to explicit Svelte service/context with start,
   subscribe, reconnect and dispose; keep outside Query.
4. Map publications only to Wave 4 keys; never invalidate Skills.
5. Port merge upload/export with byte limits, opaque IDs, disposition, no-follow,
   validation and confirmation. Pass the request `AbortSignal` through handoff
   staging, race abort against staging, clean a staging operation that succeeds
   late and preserve identity-validated recovery when detached cleanup fails. No
   ordinary RPC file bytes and no Web import of `@ai-usage/usage-merge`.
6. Port Web read observability to SvelteKit hooks without widening logged data or
   duplicating wide events.

**Gate**: control client/server/E2E, sources, sync, upload, demo, production and
>30-second SSE tests pass.

### Wave 12: Cut over and delete the retired stack

1. Switch Web dev/build/preview/check/test/Turbo scripts to SvelteKit.
2. Adapt start/build/supervisor only as selected adapter requires, preserving
   locks, output isolation, loopback, explicit env, engine readiness and
   shutdown. Reuse `@ai-usage/usage-engine-control/node` private file/process
   helpers; do not copy their implementation into SvelteKit scripts.
3. Switch Playwright/demo/start/setup tools; remove Nitro workaround only after
   SSE proof.
4. Delete Solid routes/components/shadow compatibility and retired tests after
   Svelte parity.
5. Remove Solid/TanStack Start/Solid packages, Solid Vite/icons/Ark and Nitro;
   retain framework-neutral core only if used.
6. Delete warmup, hydration workaround, Nitro handlers/plugins/paths/exceptions.
7. Scan emitted client manifest as well as sources for retired/server modules.
8. Switch every parity-ledger entry from current Solid evidence to passing
   Svelte evidence. Run the ledger checker against production sources, exports,
   procedure routes and Playwright titles; no `unmapped`, `solid-only` or
   unreviewed removal state is allowed.
9. Compare final bundle/HTML/requests/timing/startup/Session memory/lifecycle to
   Wave 0. Investigate >10% regressions; claim no unmeasured performance win.
10. Update README/Web README/architecture/public interfaces/generated ownership/
   ADR consequences and final performance results.
11. Accept ADR 0010 and mark plan DONE only after final gates.

## Test plan

Preserve framework-neutral ServedReportSession, request fingerprint, operation
owner, search parser, presentation/model, server service, UsageReadModel and
usage-engine tests. Add:

- one contract test per procedure, public error and invalid boundary;
- reviewed wire serialization snapshots and file exclusions;
- illegal import fixtures plus emitted client manifest scans;
- abort/deadline and demo adapter acquisition tests;
- manual handoff abort-before-staging, abort-during-staging, late-success cleanup
  and cleanup-failure recovery tests through the final SvelteKit endpoint;
- source snapshot/control-stream adapter tests proving Web does not recreate the
  engine broker or fan-out lifecycle;
- concurrent SSR request isolation and no work after response;
- hydration timestamp/no-duplicate tests for report and Skills;
- current-vs-immutable invalidation, retained-data SWR and GC tests;
- primitive focus/keyboard/Escape/a11y tests;
- complete deep-link/history parity;
- report, Session scale, Skills, Sources, Sync, demo privacy and production
  lifecycle parity through existing Playwright suites.

Final delivery sequence is strict:

1. X1 completes the cutover and every local pre-PR criterion.
2. X2 reconciles the latest `origin/main`, reruns the clean-worktree gate and
   receives an independent `ACCEPT`.
3. The coordinator pushes the integration branch and opens the sole
   implementation PR.
4. The PR CI must pass. Any fix stays on that PR, receives the applicable packet
   re-review plus X2 delta review, and reruns affected/full gates.
5. Only then may the coordinator mark plan 068 DONE or merge the PR.

## Final done criteria

- [x] `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test` and
  `bun run build` exit 0.
- [x] `bun run test:e2e`, `bun run test:e2e-demo`,
  `bun run test:e2e-production`, `bun run test:web-production`,
  `bun run test:web-dev-build-isolation` and `bun run test:setup-loopback` exit 0.
- [x] `bun run --cwd apps/web benchmark:session-scroll` exits 0 and its retained
  DOM/heap/network/timing values remain within the approved Wave 0 budgets.
- [x] `git diff --check` emits no output.
- [x] A clean worktree at the final integration SHA completes
  `bun install --frozen-lockfile` and the exact PR workflow commands without
  relying on another worktree's generated files.
- [x] `plans/068-execution-state.md` records every packet as independently
  reviewed and integrated, with accepted commit SHAs and no unresolved
  deviation/STOP; the sole implementation PR's CI is green.
- [x] No production match remains for `createServerFn`, `_serverFn`, TanStack
  Solid/Start/Router/Query/Table, `solid-js`, Solid Vite/icons/Ark, Nitro or the
  Nitro runner workaround.
- [x] Client manifest contains no `node:*`, `bun:*`, `@orpc/server`, usage-store,
  report-data, local-machine, engine implementation, `$lib/server` or `.server`
  module.
- [x] Web source and emitted manifests contain no `@ai-usage/usage-merge` or
  usage-engine-runtime import; reader access remains on the explicit usage-store
  reader facade.
- [x] Every Wave 0 operation is implemented or explicitly classified as file/SSE;
  none is lost.
- [ ] The parity checker reports every feature ID COMPLETE, 30/30 server
  operations mapped, every former production TSX file ported/preserved/reviewed,
  and every current Playwright title retained or linked to a reviewed equivalent.
  **Incomplete**: REPORT-04 and REPORT-05 were reported COMPLETE against specs
  that assert semantics only. Their geometry now has gates; the register rows are
  reopened until the remaining Overview surfaces are compared to `2183270e`.
- [x] Every design-system export is framework-neutral and consumed; the final
  design-system/Web dependency closure has no Solid/Ark Solid runtime.
  `tools/check-design-export-consumers.ts` now enforces zero unconsumed exports
  without a debt baseline.
- [x] Initial `/` and `/skills` HTML has settled content and no duplicate fetch.
- [x] Exact revision retry/supersession/atomic commit matches characterization.
- [x] Publication does not invalidate Skills or immutable exact revision; quota
  is independently owned.
- [x] Manual transfer preserves abort before/during staging, cleans staging that
  succeeds after abort and retains identity-validated recovery on cleanup
  failure; source SSE still delegates snapshot waiting/fan-out to the engine.
- [x] Web build/runtime adapters reuse the shared
  `@ai-usage/usage-engine-control/node` identity/liveness helpers instead of
  duplicating them.
- [x] ADRs 0007/0009 remain true and tested.
- [x] Architecture/export/workspace scanners cover `.svelte` files and fail on
  direct, indirect, re-exported and dynamic client-to-server reachability.
- [x] Final measurements are recorded; every >10% regression is fixed or
  explicitly approved with evidence.
- [ ] Plan 068 is marked DONE only after all checks.

## STOP conditions

Stop and report if:

- the entry baseline is red, a packet lacks a complete dispatch card, or two
  ready packets require overlapping write ownership;
- ADR 0009's direct reads/sole writer changes underneath the plan;
- oRPC seems to require an engine report endpoint, browser SQLite or engine
  credentials/rendezvous in browser;
- Web needs to import `@ai-usage/usage-merge`, usage-engine-runtime, or recreate
  source snapshot waiting/event fan-out;
- the contract must import the server router/implementation, or client can reach
  server code transitively;
- neither adapter passes Bun SSE/shutdown/output/lifecycle tests;
- SSR requires a module-global event/client/QueryClient/cache;
- cache work removes exact keys, one expiry retry, supersession, fingerprint
  validation or atomic commit;
- a port changes URLs, calculations, cadence, Skills authority or demo privacy;
- a boundary must be weakened or raw server failures exposed;
- the SvelteKit file endpoint cannot propagate staging cancellation, clean late
  staging success or preserve the existing recovery semantics;
- the adapter/build cutover would duplicate private file/process identity logic
  instead of consuming `@ai-usage/usage-engine-control/node`;
- a frozen cross-packet interface must change without coordinator reconciliation,
  or integration produces a semantic conflict outside coordinator-owned files;
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
