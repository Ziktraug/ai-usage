# Plan 071 — Measure and Optimize the Web Session Pipeline End to End

> **Executor instructions:** Read this document completely before changing code.
> Work in order, preserve every STOP condition, and commit each retained experiment
> separately. An experiment that misses its retention gate is reverted rather than
> rationalized. This plan authorizes local implementation and verification only; do
> not push or update a pull request unless the user explicitly asks.

**Status:** DONE

**Priority:** P1

**Effort:** XL

**Risk:** HIGH

**Planned against:** `724387ea1095c883b2824baeae757e43b0b8ac7f` (2026-08-08)

**Depends on:** the integrated SvelteKit/oRPC migration and current Plan 069
TanStack Query ownership

**Suggested branch:** `perf/web-session-pipeline`

## Outcome

Reduce the time, repeated work, DOM size, SSR duplication, and initial network cost
of the 5,000-session workflow without weakening exact-revision correctness,
continuous scrolling, accessibility, local-data isolation, or the current
SvelteKit/oRPC/TanStack Query architecture.

The program is measurement-first. It adds missing attribution to the benchmark,
then evaluates independently reversible changes in this order:

1. virtual-window overscan and the scroll hot path;
2. session page size and request count;
3. append-aware browser projection and table-model reuse;
4. SSR hydration serialization;
5. SQLite query repetition and pagination cost;
6. static precompression and initial bundle boundaries;
7. a final same-machine comparison, documentation, and PR evidence.

The plan is complete when the retained changes have reproducible before/after
evidence, all correctness and boundary gates pass, and the performance document and
PR comparison can be regenerated from recorded artifacts.

## Why this plan exists

The post-migration benchmark improved initial render and filtering, but the current
pipeline still does visibly avoidable work:

- a 900 px viewport mounts 37 desktop rows and 21 mobile cards because both modes
  retain eight overscan rows on each side;
- loading 5,000 sessions in 100-row pages rebuilds several cumulative arrays and a
  TanStack Table model after each append;
- every SQLite page repeats total counts, campaign CTE construction, ordering, and
  `LIMIT/OFFSET` work;
- the initial SSR state serializes overlapping report and destination query data;
- the initial client closure has only about 5 KiB of headroom below its current
  limit, while deferred UI dependencies appear in a shared initial chunk;
- static adapter assets are not precompressed;
- the existing scale benchmark reports point timings and maximum page size, but not
  full-traversal duration, exact request count, cumulative bytes, hydration-family
  bytes, or SQLite phase time.

These findings are candidates, not conclusions. This plan first makes each cost
observable, then keeps only changes that improve the intended metric without moving
the cost into another phase.

## Recorded baseline

The following result was measured from the planned-against commit with Bun 1.3.13,
Playwright 1.61.1, and Chromium 151.0.7922.75. The command performs one warm-up and
three recorded samples:

```sh
bun run --cwd apps/web benchmark:session-scroll
```

| Metric | Current median | Previous Svelte median | Solid baseline |
| --- | ---: | ---: | ---: |
| Initial report | 1,429.586 ms | 1,525.805 ms | 1,526.194 ms |
| Filter | 194.342 ms | 300.274 ms | 225.676 ms |
| Sort | 1,528.293 ms | 1,510.573 ms | 1,390.970 ms |
| Browser heap | 28,330,840 B | 27,639,644 B | 32,059,716 B |
| Maximum session page | 220,694 B | 220,694 B | 321,397 B |
| Desktop mounted window | 37 items / 733 nodes | 33 / 624 | 33 / 624 |
| Mobile mounted window | 21 items / 360 nodes | 18 / 291 | 17 / 258 |

Current production artifact:

| Artifact metric | Value |
| --- | ---: |
| Files | 304 |
| Total | 8,339,397 B |
| Client | 1,210,466 B |
| Server | 7,104,257 B |
| Server source maps | 116 files / 4,566,154 B |
| Initial client closure | 36 assets / 887,871 B raw / 277,577 B gzip |
| Largest current client asset | 282,614 B |
| Artifact SHA-256 | `0e690f24df314d6d9b72bd8bdfac06cb2ff7a3ad48cd0514cd200f1cd7aeb2c9` |

Keep the three raw samples in the final performance record. Medians alone are not
enough to spot variance or a single pathological run.

## Architectural constraints

The following decisions are locked for this program:

- ADR 0004 remains authoritative: Sessions is a continuous, bounded, virtualized
  5,000-row interaction. Do not replace it with visible pagination or an unbounded
  query.
- ADR 0012 remains authoritative: TanStack Query is the sole browser owner of remote
  report state, paging, cache, and hydration. Do not add a parallel component cache,
  controller, or second infinite-query owner.
- Every result remains tied to an exact served revision. Preserve atomic revision
  transitions, fingerprint validation, filter/classifier/cost semantics, campaign
  expansion, and local label overrides.
- The Web and CLI continue to read bounded projections directly from SQLite. Do not
  move report data into the usage-engine control plane, a REST service, or a new
  persistence layer.
- Keep SvelteKit and contract-first oRPC boundaries. Performance work may deepen a
  module or add internal diagnostics; it does not reopen the framework migration.
- Preserve keyboard reachability, focus, semantic table/card markup, screen-reader
  meaning, responsive behavior, and the ability to reach session 0 and session
  4,999 exactly once.
- Keep production limits: at most 200 session rows per page and at most 2 MiB per
  serialized page.
- Do not raise timeouts, byte limits, DOM budgets, or benchmark tolerances to obtain
  a green result.
- Do not reduce product-visible information or remove accessibility nodes merely to
  lower the DOM-node count.
- The stable viewport-height correction in `session-row-window.ts` is intentional.
  Do not revert it, and do not conflate render overscan with `prefetchRows`.
- Server source-map volume is accepted deployment topology. Do not optimize it only
  to make total artifact bytes look smaller.

## In-scope surfaces

Primary implementation and test surfaces:

- `apps/web/e2e/session-scroll-benchmark.scale.ts`
- `apps/web/src/session-row-window.ts`
- `apps/web/src/lib/features/sessions/table/session-virtualization.ts`
- `apps/web/src/lib/features/sessions/table/session-table.svelte`
- `apps/web/src/lib/features/sessions/table/session-table-model.ts`
- `apps/web/src/lib/features/report/composition/report-search.ts`
- `apps/web/src/lib/query/options/session-window.ts`
- `apps/web/src/lib/features/report/destinations/sessions-destination.svelte`
- `apps/web/src/lib/features/report/destinations/sessions-destination-state.svelte.ts`
- `packages/usage-store/src/session-query-sqlite.ts`
- `apps/web/src/lib/query/client.ts`
- `apps/web/src/lib/server/report/report-destination.ts`
- `apps/web/src/lib/server/report/report-bootstrap.ts`
- `apps/web/svelte.config.js`
- report client module boundaries under `apps/web/src/lib/features/report/**`
- design-system export boundaries under `packages/design-system/**`
- focused unit, integration, production, demo, and Playwright tests
- `docs/performance/web-session-optimization.md` as the new current record
- the active PR performance comparison after all local evidence is final

Historical results in `docs/performance/web-framework-migration-baseline.md` remain
historical. Link to them; do not rewrite them as though the new run occurred during
the migration.

## Explicitly out of scope

- visual redesign of the Sessions table or cards;
- changing filters, sort meaning, campaign membership, totals, costs, or labels;
- a new storage schema or public cursor contract without a separately reviewed ADR;
- cross-request or long-lived SQLite reader ownership unless profiling proves that
  reader construction is material; lifecycle work then becomes a separate plan;
- manual chunking that duplicates dependencies across initial and lazy closures;
- SSR of every report destination on the Overview route;
- cleanup of unrelated Plan 068/069 work or existing dirty files;
- pushing commits, force-updating a branch, or editing GitHub without explicit user
  authorization.

## Experiment protocol and retention rules

All comparisons use the same machine, fixture, browser version, build mode, and
power conditions. Alternate control and candidate runs when practical. Each
candidate gets one warm-up followed by at least three samples; report all samples
and compare medians.

A change is retained only when:

1. all correctness, accessibility, boundary, and cleanup gates pass;
2. its target metric improves by at least 5%, or it produces an exact structural
   win such as halving the page count with equivalent output;
3. no unrelated median timing or heap metric regresses by more than 10%;
4. no run exhibits blank virtual space, duplicate/missing rows, stale revisions,
   hydration refetches, or an oversized page;
5. the result remains after a clean production rebuild.

More specific gates below override the general 5% rule. If normal variance overlaps
the claimed gain, increase the sample count before deciding. Never select the best
single run.

## Drift check before implementation

Before changing anything:

```sh
git status --short
git diff --stat 724387ea1095c883b2824baeae757e43b0b8ac7f -- \
  apps/web/e2e/session-scroll-benchmark.scale.ts \
  apps/web/src/session-row-window.ts \
  apps/web/src/lib/features/sessions \
  apps/web/src/lib/features/report \
  apps/web/src/lib/query \
  apps/web/src/lib/server/report \
  apps/web/svelte.config.js \
  packages/usage-store/src/session-query-sqlite.ts \
  packages/design-system
```

Reconcile legitimate drift into the baseline notes. Preserve all unrelated dirty
paths. In particular, do not absorb or rewrite existing changes under `plans/068-*`.

**STOP:** if current code no longer preserves the ADR 0004/0012 ownership model, or
if the benchmark fixture cannot produce deterministic exact-revision output, repair
or re-plan that prerequisite before optimizing.

## Wave 0 — Make the full cost observable

### 0.1 Extend the scale benchmark

Add bounded, machine-readable fields to each sample:

- desktop and mobile full-traversal elapsed time;
- total session-page count, browser session RPC count, and cumulative response bytes;
- first/last session identity, unique identity count, duplicate count, and missing
  count;
- maximum and settled DOM items/nodes for desktop and mobile;
- initial HTML bytes and dehydrated query-state bytes grouped by query family;
- initial static closure bytes as raw, gzip, and Brotli;
- SQLite read time by operation/phase: count, projection/order, and page materialize;
  include count, total, p50, and p95 where the sample size supports it.

Prefer existing bounded performance diagnostics. If new diagnostics are required,
gate them behind `AI_USAGE_PERF`, exclude private values and SQL parameters, and
keep them outside public report result contracts.

The benchmark must clean up its server, browser, profile, fixture, and temporary
SQLite files after both success and failure. It must never read the real home or
user database.

### 0.2 Freeze benchmark invariants

Add assertions for:

- exactly 5,000 unique sessions across the complete fixture;
- exact first/last reachability for every supported sort direction;
- no duplicates or gaps after filter, sort, resize, desktop traversal, and mobile
  traversal;
- response-page row count and byte limits;
- zero unexpected browser business requests immediately after hydration;
- existing DOM ceilings and deterministic cleanup.

### 0.3 Record the enriched control

Run the enriched benchmark twice from a clean production build. The first run proves
instrumentation stability; the second becomes the control artifact for later waves.

```sh
bun run build
bun run --cwd apps/web benchmark:session-scroll
bun run --cwd apps/web benchmark:session-scroll
```

**Gate:** instrumentation may add no product behavior, no public response field, and
no more than 5% median overhead when disabled.

**Suggested commit:** `test(web): attribute session pipeline benchmark costs`

## Wave 1 — Right-size the virtual window and scroll hot path

### 1.1 Recalibrate overscan independently from prefetch

Evaluate symmetric render overscan of 8 (control), 6, and 4 rows. Keep
`prefetchRows` independently tuned for data availability. Exercise slow wheel,
trackpad-like bursts, scrollbar jumps, Page Up/Down, Home/End, keyboard focus, and
desktop/mobile resize transitions.

At the recorded 900 px viewport, overscan 4 should theoretically reduce the mounted
window from roughly 37 to 29 desktop rows and from 21 to 13 mobile cards. Theory is
not acceptance evidence.

Retain a lower value only if:

- maximum mounted items or nodes falls by at least 10%;
- no screenshot/geometry assertion detects blank space during fast traversal;
- focus never lands on a removed or unreachable row;
- all 5,000 identities remain reachable once;
- traversal and point timings meet the general non-regression rule.

### 1.2 Separate scroll updates from geometry measurement

Profile `session-table.svelte`. The current scroll handler enters a path that can
read style, `innerHeight`, `clientHeight`, and `scrollTop`, although resize handling
already owns most geometry changes.

If the trace confirms repeated layout reads during scrolling:

- keep geometry calculation in initialization and `ResizeObserver` paths;
- make the scroll handler update only `scrollTop`;
- coalesce at most once per animation frame if event pressure remains material;
- flush/cancel safely on teardown and before correctness-sensitive reads.

Retain this sub-change only if the trace/counters show fewer layout reads or scroll
updates and full traversal improves at least 5%, with no lagging window or focus
regression.

```sh
bun test apps/web/src/session-row-window.test.ts
bun test apps/web/src/lib/features/sessions
bun run --cwd apps/web check:svelte
bun run --cwd apps/web benchmark:session-scroll
```

**STOP:** do not restore unstable viewport-height math or hide blanking by inflating
the prefetch window.

**Suggested commit:** `perf(web): right-size session virtualization work`

## Wave 2 — Compare 100-row and 200-row pages

The current `SERVE_SESSION_PAGE_SIZE` is 100; the shared maximum is 200. Run a
controlled 100-versus-200 experiment using the same sort/filter matrix and complete
traversal.

For the 5,000-session fixture, a 200-row page should require 25 total pages instead
of 50. When the first page arrives in SSR, the browser should make 24 instead of 49
subsequent page requests. Record the actual counts rather than hard-coding an
assumption into production behavior.

Retain 200 only if:

- every page is at most 200 rows and below 2 MiB;
- total page count is 25 for the unfiltered 5,000-row fixture;
- full traversal or cumulative SQLite/RPC time improves at least 5%, or the exact
  request reduction is retained with timing inside normal variance;
- initial, filter, sort, heap, cumulative wire bytes, and time-to-first-usable-window
  remain within the general non-regression threshold;
- cancellation, exact-revision replacement, and the final partial-page case pass.

Keep page size as one named constant shared by the server request and tests. Do not
make it adaptive in this plan.

```sh
bun test apps/web/src/lib/query/options/session-window.test.ts
bun test packages/usage-store/src/session-query-sqlite.test.ts
bun run --cwd apps/web benchmark:session-scroll
```

**Suggested commit:** `perf(web): reduce bounded session page round trips`

## Wave 3 — Make browser projection append-aware

The infinite-query select path currently flattens all pages and deduplicates the
entire cumulative result. Destination composition then maps/clones rows again,
presentation maps again, and `session-table-model.ts` copies the input before
rebuilding TanStack Table state. Across 50 pages, each full-array layer visits
127,500 cumulative rows.

### 3.1 Define the ownership seam

Keep raw remote pages in TanStack Query. Add one query-derived, append-aware
projection that:

- reuses the previous prefix when the exact revision, filter, and sort identity are
  unchanged;
- appends only identities from newly arrived pages;
- invalidates atomically on a new exact revision, query identity, reordered page,
  removed page, or changed campaign/label inputs;
- preserves stable object identity for unchanged rows;
- has no mutable cache owned by a Svelte component.

### 3.2 Remove redundant full-array copies

Pass the canonical projected rows through destination and presentation seams without
unconditional map/spread copies. Make campaign expansion and local label overrides
explicit derived stages; cache/reuse them only when their true inputs are stable.

Inspect TanStack Table creation separately. Reuse its model only if its public API
supports the required stable data/update lifecycle. Do not depend on undocumented
internals merely to avoid a copy.

### 3.3 Prove complexity and identity

Focused tests must count row visits and assert reference identity:

- appending page N visits O(new-page-size), not O(total-loaded-rows), in the
  projection stage;
- the prior prefix keeps `===` identity;
- duplicate page delivery is idempotent;
- changed filter, sort, revision, campaign expansion, or label override recomputes
  the correct boundary;
- cancellation and out-of-order completion cannot combine revisions.

Retain the wave only if projection counters demonstrate the complexity reduction and
filter/sort/full traversal improves at least 5% or heap falls at least 5%, without a
greater-than-10% regression elsewhere.

```sh
bun test apps/web/src/lib/query/options/session-window.test.ts
bun test apps/web/src/lib/features/report/destinations
bun test apps/web/src/lib/features/sessions
bun run --cwd apps/web check:svelte
bun run --cwd apps/web benchmark:session-scroll
```

**STOP:** if append-aware reuse requires a second remote-state owner outside
TanStack Query, reject that design and retain only proven redundant-copy removals.

**Suggested commit:** `perf(web): project appended session pages incrementally`

## Wave 4 — Remove duplicate SSR hydration data

The report bootstrap currently dehydrates overlapping query results for the infinite
session query, exact destination query, and current-destination alias. JSON
serialization duplicates shared references.

### 4.1 Attribute serialized bytes

Before changing hydration, record exact JSON bytes for every dehydrated query key and
the overlap attributable to Session row payloads. Add a production test fixture that
fails if an unexpected second full Session payload is introduced later.

### 4.2 Establish one canonical serialized payload

Choose the smallest design that preserves current query identities and browser
ownership:

- dehydrate the canonical report/session query once;
- seed exact/current aliases from canonical hydrated data without issuing a browser
  business request; or
- omit an alias from dehydration only when the browser can derive it synchronously
  and atomically from the canonical query.

Do not weaken revision keys, serialize private server capabilities, or make SvelteKit
load functions become long-lived state owners.

Retain the change only if:

- duplicated Session row serialization is removed by structural assertion;
- report-query-state bytes fall by at least 20% on the Sessions deep link, unless the
  measured duplication was below that threshold;
- hydration causes zero report/session refetches before ordinary staleness policy;
- Overview, Sessions, Breakdown, current alias, exact destination, refresh, and
  revision supersession tests remain atomic and green;
- initial HTML secret sentinels and demo isolation continue to pass.

```sh
bun test apps/web/src/lib/server/report/report-bootstrap.test.ts
bun test apps/web/src/lib/server/report/report-destination.test.ts
bun test apps/web/src/lib/query
bun run test:e2e-demo
bun run test:e2e-production
bun run --cwd apps/web benchmark:session-scroll
```

**STOP:** do not trade duplicate bytes for a hydration waterfall or browser refetch.

**Suggested commit:** `perf(web): canonicalize report hydration payloads`

## Wave 5 — Remove measured SQLite repetition

Run this wave only with Wave 0 phase attribution enabled. Optimize the dominant
measured phase in small steps.

### 5.1 Stop repeating invariant totals

The current query repeats `COUNT(*)` and `COUNT(DISTINCT ...)` for every page.
Return invariant totals with the first exact-revision page and reuse them through the
same infinite query identity. Prove that a revision/filter/sort change invalidates the
reuse and that a missing first page cannot synthesize totals.

### 5.2 Evaluate projection/order materialization

Only if CTE construction or sorting remains dominant, prototype a request-scoped or
exact-revision-scoped materialized projection that keeps current SQLite ownership,
bounded memory, cleanup, and filter/sort semantics. Compare it with the current
query; delete the prototype if lifecycle/cleanup cost erases the gain.

### 5.3 Evaluate keyset pagination only behind a compatibility seam

`LIMIT/OFFSET` can rescan increasingly large prefixes. Consider internal keyset
pagination only if traces show offset work is material and every supported sort has
a deterministic, unique tie-breaker. Preserve the external bounded-page contract,
exact revision, random access assumptions used by the UI, and final-page behavior.
If this requires a public cursor or schema migration, stop and write a separate ADR
and implementation plan.

Retain SQLite work only if median total `sqliteReadMs` improves at least 15% for the
5,000-row traversal or sort path, with byte-for-byte equivalent normalized results
and no cleanup/lifecycle leak.

```sh
bun test packages/usage-store/src/session-query-sqlite.test.ts
bun test apps/web/src/lib/query/options/session-window.test.ts
bun run --cwd apps/web benchmark:session-scroll
```

**STOP:** a persistent cross-request reader is not authorized by this plan without
profiling that isolates reader construction as a material cost. If proven, document
reader lifetime, invalidation, WAL behavior, and shutdown in a separate plan.

**Suggested commits:**

- `perf(usage-store): reuse invariant session query totals`
- `perf(usage-store): reduce measured session pagination work` (only if retained)

## Wave 6 — Reduce static wire cost and initial client closure

### 6.1 Enable and verify static precompression

Evaluate Svelte adapter precompression. Verify the production server actually serves
immutable assets with `Content-Encoding: br` and `gzip` according to
`Accept-Encoding`, correct `Vary`, content type, cache headers, and byte integrity.

Report three separate numbers:

- uncompressed code bytes;
- transferred gzip/Brotli bytes;
- deployed artifact bytes including generated compressed copies.

The deployed artifact will normally grow; that is not a code-size regression. Retain
precompression only if the production serving path uses it and transferred bytes
fall. Do not double-compress dynamic responses.

### 6.2 Deepen design-system import boundaries

The shared initial chunk currently contains Drawer/Tabs/focus-trap/remove-scroll
code even though the session detail drawer is dynamically reached. Replace broad
design-system barrel imports with supported granular subpaths or deeper modules.
Keep public package ergonomics where possible, and test package export maps.

Retain a split only if the initial gzip closure falls by at least 10 KiB, the total
loaded closure for users who open the drawer does not materially grow, and no
duplicate framework/design-system runtime appears in multiple chunks.

### 6.3 Separate live and synthetic-only report code

Measure how much synthetic fixture/report code enters the ordinary live client
closure through static owner/bootstrap imports. If material, isolate it behind a
demo-only server/client boundary while preserving deterministic demo SSR and the
rule that demo mode cannot touch real local data.

Retain only a measured closure reduction with all demo isolation tests green. Do not
make the live route capable of importing synthetic fixture data accidentally.

### 6.4 Treat direct-destination SSR as optional

Sessions and Breakdown are dynamically imported from a client `$effect`, so direct
deep links may initially render a loading shell even when the server prefetched the
destination. Prototype route/server selection only if traces show this is a material
initial-render cost. The Overview route must not eagerly acquire both destination
chunks.

Keep this experiment only if direct Sessions/Breakdown usable render improves at
least 10%, Overview's initial gzip closure does not grow by more than 5 KiB, and
hydration remains request-free. Otherwise delete the prototype and record it as a
rejected candidate.

```sh
bun run build
bun run test:web-client-manifest
bun run test:web-production
bun run test:e2e-demo
bun run test:e2e-production
bun run --cwd apps/web benchmark:session-scroll
```

Honor `docs/future-work.md`: further root report splitting is retained only while HTTP
route loading remains well covered.

**Suggested commits:**

- `perf(web): serve precompressed static assets`
- `perf(web): defer noninitial report dependencies`

## Wave 7 — Final comparison, documentation, and handoff

### 7.1 Run an isolated final benchmark

From a clean production build, run one warm-up and at least three final samples with
the same toolchain and fixture as the control. Record:

- every original PR metric;
- every new Wave 0 metric;
- raw samples, medians, percentage deltas, tool versions, commit SHA, artifact hash,
  and build closure;
- which experiments were retained or rejected and why.

If the browser/runtime version changed during implementation, rerun the control at
the original commit or state clearly that cross-version timing deltas are not
comparable. Never compare a stale control and a new browser as if only code changed.

### 7.2 Add the durable performance record

Create `docs/performance/web-session-optimization.md` containing:

- environment and reproducible commands;
- the historical migration numbers by reference, not rewritten history;
- enriched control versus final tables;
- page/RPC, traversal, DOM, heap, SQLite, hydration, and closure attribution;
- retained/rejected experiments and known variance;
- remaining candidates with evidence, not speculation.

Update `docs/future-work.md` only for candidates deliberately deferred by evidence.

### 7.3 Update the active PR description

Replace the current performance comparison with final same-machine evidence. Keep
the build artifact hash and measured commit explicit. Do not claim a win for a
metric outside the retention gates, and distinguish wire bytes from deployed
artifact bytes after precompression.

PR editing/pushing is an external action and requires explicit user authorization at
execution time, even though preparing the Markdown locally is part of this plan.

**Suggested commit:** `docs(performance): record session pipeline optimization`

## Verification matrix

Run focused checks after each wave. Before declaring the plan complete, run the full
clean gate:

```sh
bun x ultracite fix
git diff --check
bun run check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:web-client-manifest
bun run test:web-production
bun run test:web-dev-build-isolation
bun run test:setup-loopback
bun run test:e2e-demo
bun run test:e2e-production
bun run test:e2e
bun run --cwd apps/web benchmark:session-scroll
```

Also run the focused suites while iterating:

```sh
bun test apps/web/src apps/web/*.test.ts
bun test packages/usage-store/src/session-query-sqlite.test.ts
bun run --cwd apps/web check:svelte
bun run --cwd apps/web typecheck
```

Expected final invariants:

- 5,000 unique sessions, no missing/duplicate identities;
- exact revision and fingerprint semantics unchanged;
- page size at most 200 and serialized page at most 2 MiB;
- desktop DOM at most 300 nodes and mobile DOM at most 600 nodes, with the retained
  candidate also meeting its relative-improvement gate;
- no blank virtualization frames or focus loss;
- no browser business refetch caused by hydration;
- demo isolation and the four initial-HTML secret sentinels pass;
- client manifest contains no server/private capability;
- temporary databases, browser profiles, servers, and performance diagnostics clean
  up on success and failure;
- documentation and PR figures point to the exact measured commit and artifact.

## Program STOP conditions

Stop the affected wave and report the blocker when any of the following occurs:

- the candidate changes product semantics, exact-revision atomicity, or query
  ownership to obtain a performance result;
- an optimization needs a new public cursor/schema/control-plane contract not covered
  by this plan;
- the benchmark cannot distinguish instrumentation overhead from the claimed gain;
- timing variance remains larger than the claimed improvement after additional
  samples;
- a lower DOM count produces blank space, inaccessible focus, missing content, or
  reduced information;
- hydration byte reduction causes a browser waterfall/refetch;
- static compression is generated but not served by the production path;
- a bundle split lowers one chunk while increasing the total initial closure or
  duplicating runtime code;
- SQLite lifecycle or cleanup becomes cross-request and ambiguous;
- unrelated dirty work prevents an isolated diff.

Rejected experiments remain out of the final source diff. Record their measurements
in the performance document so the next audit does not repeat them without new
evidence.

## Done when

- Wave 0 produces stable, reproducible end-to-end attribution;
- every retained optimization passes its quantitative and correctness gates;
- failed experiments are reverted and documented with their measured reason;
- the enriched final benchmark and production artifact are recorded against an exact
  commit and toolchain;
- the full validation matrix is green from a clean build;
- `docs/performance/web-session-optimization.md` is self-contained and preserves the
  migration baseline as history;
- the PR performance section can be regenerated directly from the recorded data;
- no unrelated Plan 068/069 or user work is included.

## Maintenance notes

- Update this plan's status to `IN PROGRESS` only when implementation starts, and to
  `DONE` only after the full final gate and durable performance record pass.
- Append an implementation record with retained/rejected experiment commits and
  measurements; do not rewrite the planned baseline.
- When future code changes the fixture, browser version, page contract, or benchmark
  methodology, record the discontinuity before comparing numbers.
- Prefer adding a new performance record over mutating historical measurements.

## Implementation record

Executed on `agent/migrate-web-sveltekit-orpc` (PR #27) rather than
`perf/web-session-pipeline` so retained commits join the active migration PR.

| Commit | Wave | Result |
| --- | --- | --- |
| `f7d143f5` | 0 instrumentation | retained |
| `250416ca` | 0 control | retained |
| `42b40bb7` | 1 overscan 4 | retained (scroll-path rejected) |
| `7eba6336` | 2 page size 200 | retained |
| `eabdb0f5` | 3 append projection | retained |
| `438c89a6` | 4 hydration canonicalize | retained (−64% hydration vs Wave 3) |
| `63e78224` | 5.1 totals reuse | retained with 5.2 |
| `1b2f7245` | 5.2 projection cache | retained (−99% sqlite vs Wave 4) |
| `04e88d3b` | 6.1 precompress | retained |

Rejected without remaining source: Wave 1.2 scroll rAF path; Wave 6.2 design-system
split (+2.13 KiB gzip); Wave 6.3 synthetic isolation (immaterial); Wave 6.4 destination
SSR (unmeasured materiality); Wave 5.3 keyset (STOP / ADR).

Durable record: `docs/performance/web-session-optimization.md`.
