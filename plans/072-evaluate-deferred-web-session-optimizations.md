# Plan 072 — Evaluate Deferred Web Session Optimizations

> **Executor instructions:** Read this document completely before changing code.
> Work in order, preserve every STOP condition, and commit each retained experiment
> separately. An experiment that misses its retention gate is reverted rather than
> rationalized. This plan authorizes local implementation, push, and PR description
> updates for the same single working branch; do not merge.

**Status:** IN PROGRESS

**Priority:** P1

**Effort:** XL

**Risk:** MEDIUM

**Planned against:** `67ca9b0e060c0359628a8c2721401bd973c8ce4f` (2026-08-08)

**Depends on:** Plan 071 (`50f283faf7d09622dca4ea4843045c5c1238d4b5`,
measured in reviewed artifact `wave7-reviewed-final.json`).

**Branch:** `agent/migrate-web-sveltekit-orpc` (PR #27). All implementation work
joins the same branch; no additional branch is created.

## Outcome

Three deferred candidates from Plan 071 are evaluated end to end:

1. **Pagination keyset/cursor** on top of the existing exact-revision
   projection cache (`packages/usage-store/src/session-query-sqlite.ts`).
2. **Deeper design-system / Ark splitting** to move non-initial Ark
   primitives (Popover / Drawer / Tabs / focus-trap / remove-scroll) out of
   the shared initial client chunk.
3. **Direct Sessions / Breakdown SSR** as a single-deep-link server-rendered
   destination, gated by the URL, without importing both destinations on
   Overview.

Each candidate is measured, kept only if it passes its quantitative gate, and
removed entirely from the final diff otherwise. The repository ends with only
the optimizations that the measurements actually justify.

## Baseline

Reviewed Plan 071 final, certified at `50f283fa`, head `dc43e6b9`. The
artifact `docs/performance/artifacts/wave7-reviewed-final.json` (SHA-256
`1cfed2e567c55e858f286fcde8cfaa545b08e5213af2b9e049aac2b85c6f7bd8`) is the
control for every comparison in this plan. The follow-up commits `f352b07a`
(await session action responses) and `67ca9b0e` (classify cancelled route data
fetches) only adjust the e2e runner's classification of cancelled fetches and
do not invalidate the Plan 071 measurements. They are re-measured where this
plan needs a fresh control.

Key reference numbers (from `wave7-reviewed-final.json`):

| Metric | Final |
| --- | ---: |
| `initialMs` | 439.268 ms |
| `desktopFullTraversalMs` | 3470.330 ms |
| `mobileFullTraversalMs` | 55.773 ms |
| `filterMs` | 126.628 ms |
| `sortMs` | 208.003 ms |
| `heapDeltaBytes` | 25,461,664 B |
| `hydrationTotalBytes` | 489,216 B |
| `sessionPageCount` | 26 |
| `desktopSessionPageCount` | 25 |
| `desktopSessionRpcCount` | 24 |
| `cumulativeSessionResponseBytes` | 11,026,467 B |
| `maximumPageBytes` | 441,050 B |
| Initial closure raw | 891,157 B |
| Initial closure gzip | 279,242 B |
| Initial closure brotli | 241,588 B |
| Desktop / Mobile items | 29 / 13 |
| Desktop / Mobile DOM nodes | 581 / 224 |
| Unique identities | 4,999 |
| Missing / Duplicates | 0 / 0 |

SQLite phase attribution (sample 0 of the reviewed run):

| Phase | count | totalMs |
| --- | ---: | ---: |
| count | 3 | 16.509 |
| identity | 27 | 1.087 |
| materialize | 27 | 124.430 |
| projection | 0 | 0 (warm projection cache) |

## Architectural constraints

Locked from Plan 071 and from the active ADRs (`0002`, `0004`, `0009`, `0010`,
`0012`):

- ADR 0004: Sessions is a continuous, bounded, virtualized 5,000-row
  interaction. Never replace it with visible pagination.
- ADR 0012: TanStack Query is the sole browser owner of remote report state.
- Exact served revision, request fingerprint, atomic visible commit, and
  200-row / 2 MiB page limits remain unchanged.
- Web and CLI continue to read revision-keyed projections directly from
  SQLite. No new control plane, REST surface, or storage layer.
- The SvelteKit / contract-first oRPC boundary is preserved.
- One canonical ownership: `packages/usage-store` keeps sole ownership of the
  exact-revision query lifecycle.
- No additional infinite-query owner, parallel component cache, or mutable
  client copy of server data.
- No weakening of timeouts, byte limits, DOM budgets, or benchmark tolerances
  to obtain a green result.
- No removal of product information, focus, semantic markup, or accessibility
  affordances to lower a metric.

## Out of scope

- Visual redesign of any destination.
- A new public cursor/schema without an ADR (keyset stays behind the
  compatibility seam unless the experiment proves it).
- A cross-request, long-lived SQLite reader.
- Manually duplicating dependencies across chunks.
- SSR of every destination on Overview.
- A new REST surface or transport alongside oRPC.
- Cleanup of unrelated Plan 068/069 work or unrelated user changes.
- Merging the PR; force-push; rewriting pushed history.

## Experiment protocol and retention rules

Every candidate must follow the Plan 071 protocol:

1. Build a clean control branch and a clean candidate branch from the same
   head.
2. Run one warm-up (not recorded) followed by at least three recorded
   samples on the same machine, same Bun, same Playwright/Chromium, same
   fixture, same build mode, same power conditions.
3. Compare medians, never a single best run.
4. Keep all raw samples.
5. If normal variance overlaps the claimed gain, increase sample count.
6. Reconstruct the production build before the final measurement.
7. Same browser/runtime version as the baseline or rerun the control at the
   same version.

Rejected experiments are not partially retained. The prototype is removed
from the final source diff, and the measurement artifact + decision live in
documentation only.

## STOP conditions (program-wide)

- The candidate changes product semantics, exact-revision atomicity, query
  ownership, or any public contract to obtain a performance result.
- A new public cursor / schema / control-plane contract would be required but
  the experiment does not justify it.
- The benchmark cannot separate instrumentation overhead from the claimed
  gain.
- Timing variance still overlaps the claimed gain after additional samples.
- A lower DOM or closure number produces blank space, inaccessible focus,
  missing content, or reduced information.
- The hydration byte reduction causes a browser waterfall or refetch.
- A bundle split lowers one chunk while duplicating runtime code or growing
  another initial chunk above the gate.
- SQLite lifecycle or cleanup becomes cross-request or ambiguous.
- A measurement relies on a single best run.
- A regression surfaces in `check`, `lint`, `typecheck`, `test`, `build`,
  client-manifest, web-production, web-dev-build-isolation,
  setup-loopback, demo-isolation, or any e2e suite and cannot be fixed
  without weakening a contract.

## Phase 0 — Orientation and plan

- [x] Verify the active branch is `agent/migrate-web-sveltekit-orpc`.
- [x] Verify the local head equals the expected head
      `67ca9b0e060c0359628a8c2721401bd973c8ce4f`.
- [x] Verify PR #27 is open, draft, and the head matches.
- [x] Verify the worktree is clean.
- [x] Confirm reviewed baseline numbers and SHA-256 of
      `wave7-reviewed-final.json`.
- [x] This plan published at
      `plans/072-evaluate-deferred-web-session-optimizations.md`.
- [x] `plans/README.md` updated with status `IN PROGRESS`.

## Phase 1 — Strengthen attribution

The Wave 0 instrumented benchmark already covers: desktop and mobile
full-traversal, page counts, browser RPC counts, cumulative bytes,
first/last/unique/missing/duplicate identities, max/settled DOM, hydration
bytes per family, initial HTML bytes, initial closure raw/gzip/brotli, and
SQLite phase attribution (count, identity, projection, materialize).

Before the candidates are evaluated, the following are added (gated by
`AI_USAGE_PERF` where relevant, free of private values, and never serialized
into a public response):

- TTFB and time-to-first-content for `/`, `/?tab=sessions`,
  `/?tab=models`, a filtered Sessions URL, and a dimensioned Breakdown
  URL.
- A "first usable render" marker for each destination, defined below.
- Bytes loaded before / after the first Drawer open.
- A module-occurrence map of `node/0` to count duplicated runtimes between
  the initial chunk and lazy chunks.

These additions are required only if the candidate cannot be evaluated from
existing data. They are committed under
`test(web): attribute deferred session optimization costs`.

## Experience A — Pagination keyset / cursor

### A1 — Measure residual OFFSET cost

Profile the existing `runSessionPage` on:

- The 5,000-session fixture.
- A 20,000-session fixture (synthesized at the same campaign density, kept
  in the temp benchmark home, cleaned after every run).
- Sort `date` ascending and descending.
- Sort `project` with equal `sort_project_rank` ties.
- Filter with zero matches.
- Highly selective filter (`harness = 'codex'`).
- Low-selectivity filter (`origin = 'classifier'`).
- Revision change during a sequence of pages (forfeit cache, get a new
  scope).

Attributes per run, summed across the 25 (or 100) pages:

- identity-cache checks (`sessionQueryPageIdentity`).
- totals-cache hits and misses.
- projection-cache hits and misses.
- OFFSET rescan cost (the `LIMIT pageSize+1 OFFSET offset` slice).
- materialize cost (root hydration + exact-cost rollup).
- serialization cost (stringify the response).
- network transfer cost.

Instrument via the existing `AI_USAGE_PERF` env var so the benchmark
fixture is not changed.

**STOP A1:** if `OFFSET` is below 10% of the residual total SQLite cost on
the 5,000-session fixture and the 20,000-session fixture shows no superlinear
growth, the experiment stops here. Document the rejection in this plan and
in `docs/performance/web-session-deferred-optimizations.md`. Do not design
or implement a keyset contract.

### A2 — Design the cursor (only if A1 is retained)

A new ADR is published at `docs/adr/0013-keyset-session-pagination.md` before
any new contract is added. The cursor must be:

- Opaque to the client (e.g. `sq2.<scope>.<composite>`).
- Versioned (`sq2.`).
- Scoped to `{revision, captureFingerprint, requestFingerprint}`.
- Bound to the current sort and direction.
- A composite key with a stable tie-breaker (identity column from the
  existing `buildSessionQuerySqlOrder`).
- Deterministic in the presence of equalities (the existing
  `item_identity_rank`, `item_ordinal` tie-breaker stays authoritative).
- Bounded in size and validated at runtime.
- Invalidated by revision, fingerprint, filter, or sort changes.

The cursor is never `date`, `project`, or `cost` alone. The composite
includes the last emitted sort column tuple plus the existing
`item_identity_rank` tie-breaker.

The contract change proposal, if any, lives in the ADR and includes:

- First call: `cursor: null`.
- Continuation: `cursor: <opaque>`.
- End of sequence: server returns `nextCursor: null`.
- Invalid cursor: throws a `SessionQueryValidationError` mapped to
  `RevisionExpired` or a new tagged error.
- Cursor from a different revision: same path.
- Cursor from a different filter/sort: same path (request fingerprint
  mismatch).
- Ascending and descending navigation: both supported by the
  composite-key order.

### A3 — Prototype and compare

Implement a keyset branch in
`packages/usage-store/src/session-query-sqlite.ts` behind a compatibility
seam (e.g. a new `mode: 'offset' | 'keyset'` parameter or a sibling
function `runKeysetSessionPage`). The original `runSessionPage` is
unchanged and remains the default path; the server wires the new mode only
when a request carries the cursor shape.

Required assertions:

- Same identity set, same order, no duplicates, no gaps.
- Same totals returned on the first page.
- Same first and last identity on a full traversal.
- Same filter / sort semantics.
- Server rejects an obsolete cursor with the tagged error.
- Server never reads from a different revision.
- Page size ≤ 200; serialized page ≤ 2 MiB.
- 5,000-session benchmark and 20,000-session benchmark both meet the
  retention gate.

### Retention gate A

Keyset is retained only if at least one of the following is true:

- Median `desktopFullTraversalMs` improves by ≥ 15% on the 5,000-session
  fixture.
- Median `desktopFullTraversalMs` improves by ≥ 25% on the 20,000-session
  fixture with no regression at 5,000.
- Median residual SQLite cost (`sqliteReadMs` minus cache work) improves
  by ≥ 20%.
- The run eliminates a measured superlinear growth pattern.

And simultaneously:

- No other median metric regresses by more than 10%.
- No significant byte growth.
- The ADR is published.
- Exact-revision test coverage is complete.
- Contract complexity is justified by the measurements.

If the gate is not met, the keyset branch is removed from the diff; the
ADR, the measurement artifact, and the rejection live in documentation
only. No public cursor type or field remains in the source.

Commit (if retained): `perf(usage-store): page exact session projections by cursor`.

## Experience B — Deeper design-system / Ark splitting

### B1 — Bundle cartography

Produce a machine-readable map of:

- All assets in the initial Overview closure, the initial Sessions closure,
  and the initial Breakdown closure.
- All assets loaded after the first Drawer open.
- Every Ark module and every `@zag-js/*` runtime per chunk.
- Modules duplicated across chunks.
- Design-system exports that pull Ark or Zag into their importer.

The cartography is committed as
`docs/performance/artifacts/plan072-bundle-map.json` and a companion
`docs/performance/artifacts/plan072-bundle-map.md`.

### STOP B0 — Composite feasibility spike

Before paying for five isolated production trials, a disposable composite
spike may exercise the proposed boundaries together. It is a feasibility gate,
not evidence for any individual trial: its deltas must never be attributed to
one of the changes below.

Stop B entirely, restore the control implementation, and do not enter B2 when
the composite spike fails either mandatory product gate:

- initial gzip decreases by less than 10 KiB; or
- median Drawer-open latency regresses by more than 10%.

This stop exists to avoid five expensive branches when the combined upper
bound is already unacceptable. Passing STOP B0 does not retain any code; it
only authorizes the isolated experiments.

### B2 — Independent, reversible experiments (only after STOP B0 passes)

When STOP B0 passes, each trial is implemented in isolation, measured, then
either kept or reverted. The trials, in order:

1. Replace the root design-system barrel with focused subpath exports for
   the `Checkbox` / `Toggle` / `Tooltip` / `SegmentedControl` /
   `HarnessBadge` paths used at node/0–3, while leaving Popover / Drawer /
   Tabs / Select / MultiSelect on the barrel. The barrel is preserved
   internally; only the public surface is split.
2. Move the Popover / Drawer / Tabs / Select / MultiSelect code into a
   subpath export (e.g. `@ai-usage/design-system/svelte/overlays`) and
   update the lazy consumers (session table, drawer, breakdown, quota
   history) to import from that subpath. The barrel still re-exports them
   for compatibility.
3. Split the lazy Session table subtree further: a dedicated subpath for
   the table content itself, so the initial closure of Sessions does not
   include the table's Popover.
4. Lazy-load the Drawer body content (drawer-detail-item) only on demand,
   so the Session Drawer chunk does not carry the Popover.
5. Replace the table column-visibility Popover with a focused local
   disclosure primitive (no Ark). Keep semantics (focus trap, escape,
   click-outside, keyboard) equal to the Popover.

Each trial is committed in its own branch
(e.g. `agent/exp-b1-overlays-subpath`), measured, then either merged or
discarded. The full validation matrix
(`build`, `test:web-client-manifest`, `test:web-production`, `test:e2e`) is
run after every trial.

Measurements per trial:

- Initial raw / gzip / brotli closure.
- Initial chunk count.
- Bytes loaded before any interaction.
- Bytes loaded after the first Drawer open.
- Duplicated runtimes between chunks.
- Drawer open time.
- Focus, Escape, focus return, scroll lock.

### Constraints B

Preserve:

- Drawer initial focus on first interactive element.
- Focus returns to the row trigger after close.
- Escape closes the drawer / popover.
- Full keyboard navigation.
- Screen-reader semantics.
- Scroll lock while the drawer is open.
- Responsive behaviour.
- No visual flash on open.
- No duplicated Svelte or Ark runtime.
- Ergonomic public exports.

No new overlay component is created merely to save bytes; if the existing
Popover or Drawer must be preserved, the trial is rejected.

### Retention gate B

A trial is retained only if:

- Initial gzip closure of the target destination falls by ≥ 10 KiB.
- Overview initial gzip closure does not grow by more than 5 KiB.
- Total bytes loaded after opening the Drawer does not grow by more than 5%.
- No Ark or Zag runtime is duplicated.
- Drawer open time does not regress by more than 10%.
- All accessibility and interaction tests pass.

When a combination of small trials crosses the gate, the individual
contribution of each is documented.

If a trial misses the gate, it is removed from the diff; the artifact
captures the trial, the measurement, and the rejection.

Commits (if retained): `refactor(design-system): expose granular overlay
boundaries` and `perf(web): defer noninitial session overlay code`.

## Experience C — Direct Sessions / Breakdown SSR

### C1 — Establish a per-route control

Measure, in order:

- `/`
- `/?tab=sessions`
- `/?tab=models`
- A Sessions URL with a non-trivial filter and a non-default sort.
- A Breakdown URL with a non-default dimension and a non-default sort.

For each:

- TTFB.
- HTML size.
- First byte of useful content.
- First usable render (see definitions below).
- Total JS / CSS request count.
- RPCs before and after hydration.
- Loading-shell state observed.
- Initial closure raw / gzip / brotli.
- Chunk count.
- Layout shift.

Definitions of "first usable render":

- **Sessions:** the Sessions surface is mounted, the first rows are
  visible, the filter control is interactive, and no misleading
  "loading" state is shown.
- **Breakdown:** the title and the first rows/visualizations are
  visible, controls are interactive, and no misleading "loading" state
  is shown.

### C2 — Targeted SSR prototype

The server can prefetch only the destination requested by the URL. It
must not prefetch Overview, Sessions, and Breakdown at once. The
following are preserved unchanged:

- The existing TanStack Query prefetch.
- The canonical `dehydratedState` shape and the
  `canonicalizeReportSessionHydration` step.
- Zero second owners of the server state.
- No import of server capabilities into the client bundle.
- No additional private data in the HTML.
- No double acquisition after hydration.

The prototype keeps the Overview closure as it stands. It only adds
per-URL destination selection inside the existing
`acquireLiveReportQueryState`.

### C3 — Verifications

Add tests for:

- Initial Sessions HTML contains the first rows.
- Initial Breakdown HTML contains the title and the first rows.
- Overview HTML is unchanged.
- Zero unexpected session RPC right after hydration.
- Zero unexpected route-data waterfall.
- Client navigation between destinations.
- Browser back / forward.
- Filter / sort change.
- Expired revision error.
- SSR error path.
- Demo isolation.
- The four HTML secret sentinels remain absent.

### Retention gate C

Direct SSR is retained only if:

- Median first-usable-render on Sessions or Breakdown improves by ≥ 10%.
- Overview initial gzip closure does not grow by more than 5 KiB.
- Overview TTFB does not grow by more than 10%.
- No additional business RPC after hydration.
- No significant duplication of SSR data.
- No change in TanStack Query ownership.
- No navigation or accessibility regression.

If only Sessions passes the gate, retain only the Sessions path. If only
Breakdown passes the gate, retain only the Breakdown path. Do not
force a unified solution.

Commit (if retained): `perf(web): server-render direct report
destinations`.

## Phase 5 — Examine the two cross-cutting numbers

The reviewed run records 489,216 B of hydration JSON and 11,026,467 B of
cumulative Session response bytes across the exhaustive traversal. The
candidates are not authorised to change these surfaces unless a measurement
shows a directly attributable optimization. Acceptable local changes:

- Remove a proven duplicate payload.
- Reduce a repeated field without changing the public contract.
- Apply a more compact representation (still JSON; no proprietary
  serialization) consistent with the existing schema.
- Avoid a response already in the browser cache.

Forbidden:

- Removing product information.
- Breaking a contract.
- Introducing a custom serializer.
- Merging this phase with a broader report-model refactor.

If the work exceeds a localized optimization, a separate plan is
spawned and this plan stays at the current state.

## Final validation matrix

Before declaring the plan complete:

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

A failure is not dismissed as "pre-existing" without proof. For a CI or
e2e failure: read the exact log, reproduce locally, distinguish regression
from race, fix the cause, do not raise a timeout without evidence, do not
widen a network allowance beyond the affected transport.

## Reviews

### Standards review

- No avoidable TypeScript assertions.
- `readonly` / `mut` discipline preserved.
- Runtime validation of every external input.
- No new barrel files.
- Deep modules with narrow interfaces.
- No generic cache cleared and recast.
- Tests isolated with cleanup in `finally` or hooks.
- No global environment left modified.

### Specification review

- Exact revision semantics unchanged.
- No duplicate / missing identities.
- Identical results between control and candidate.
- Quantitative thresholds actually met.
- Rejected experiments absent from the final source.
- Documentation faithful to artifacts.
- No number based on a single best run.
- No confusion between code bytes, transfer bytes, and deployed artifact
  bytes.

## Documentation

Create `docs/performance/web-session-deferred-optimizations.md`. It does
not rewrite the Plan 071 artifact. Required sections:

- Environment (commit, branch, tool versions).
- Control commit and final measured commit.
- Reproduction commands.
- Raw samples and medians for every metric.
- Control vs final deltas.
- Retained / rejected decision per candidate with quantitative reason.
- Variance and limits.
- Artifact hashes.
- Code bytes, transfer bytes, deployed artifact bytes (distinct).
- Candidates still deferred with measured reason.

Save JSON artifacts in `docs/performance/artifacts/`:

- `plan072-control.json`
- `plan072-keyset.json` (if A is implemented)
- `plan072-ark-split.json` (if B is implemented)
- `plan072-destination-ssr.json` (if C is implemented)
- `plan072-final.json`

## PR update

The performance comparison section in PR #27 is rewritten with the
final same-machine evidence, the measured commit, the artifact hash, and
the retained / rejected decision per candidate. No optimization that
missed its gate is announced as a gain. The PR stays draft and unmerged.

## Commit cadence

- One atomic commit per change.
- No mixing of instrumentation, keyset, design-system split, destination
  SSR, documentation, and CI fixes.
- A rejected experiment not yet pushed: removed from the working tree.
- A rejected experiment already pushed: reverted in its own commit.
- No force-push, no history rewrite.

## Done when

- Each candidate has a measured decision.
- Rejected candidates are absent from the final source.
- The full validation matrix is green from a clean build.
- The branch is pushed to `agent/migrate-web-sveltekit-orpc`.
- PR #27's performance section reflects the final measurements.
- All five CI lanes are terminal and green on the last head.
- The worktree is clean.
- The PR remains unmerged.

## Implementation record

The record below is filled as the plan executes. Raw numbers, commits,
and decisions are written here so the next auditor does not have to
recover them from `git log`.

### Wave 1 — Attribution

- Added canonical SQLite phase and counter names for identity checks,
  projection-cache hits/misses, and totals-cache hits/misses.
- Exposed benchmark-only instrumentation from the explicit
  `@ai-usage/usage-store/performance-testing` subpath instead of the reader
  barrel.
- Extended the destination harness with canonical routes, browser-native
  useful/usable markers, layout shift, complete business-RPC accounting, and
  raw/gzip/Brotli JS/CSS closure accounting.
- Extended the bundle map with recursive destination closures, Ark/Zag module
  occurrence counts, and Drawer-open attribution.

### Experience A — Keyset

Rejected at STOP A1 after correcting fixture density. The probe now publishes
5,000 sessions / 4,999 campaigns and 20,000 sessions / 19,996 campaigns. The
date-desc traversals cover exactly 25 and 100 pages and return 4,999 / 19,996
unique identities with no duplicate or gap. Their medians are 190.807 ms and
814.772 ms; projection slicing is 0.050 ms and 0.105 ms, or 0.0298% and
0.0147% of residual SQLite work. Slice growth is 2.10x for a 4x fixture
increase, with the expected revision-scoped cache forfeiture. No cursor
contract or ADR was introduced.

### Experience B — Design-system split

Rejected at STOP B0 after the second review restored the global Ark Popover
and Tooltip and limited the no-Ark prototype to the column disclosure. The
spike combined several proposed boundaries, so its deltas are deliberately not
attributed to trials 1–5 and B2 was never entered. On the same machine, both
clean builds used Bun 1.3.13 and Chrome 151.0.7922.75, then one warm-up and
seven samples. Initial gzip changes from 279,246 B to 271,935 B (-7,311 B),
which misses the required 10 KiB reduction. The exact cumulative total through
first Drawer open changes from 292,409 B to 297,494 B (+1.739%), but the Drawer
median regresses from 97.021 ms to 122.689 ms (+26.46%), above the 10% ceiling.
The bundle map reports zero duplicated Ark/Zag modules. Since both STOP B0
conditions fire, no isolated B2 branch is justified. The granular export split
and local disclosure are removed; the global Ark components and their
portal/positioning ownership are restored. The rejected feasibility spike and
its raw evidence remain only in the artifacts.

### Experience C — Destination SSR

No new optimization retained. Direct destination prefetch was already present
at the planned-against commit. The no-prefetch control did not yield a stable
10% first-usable improvement and introduced a browser Session RPC before first
scroll, violating the existing zero-refetch contract. The original query owner
and prefetch path remain unchanged.

### Final

The post-rejection Session benchmark is current: one warm-up and three recorded
samples traverse all 4,999 campaign identities in exactly 25 desktop pages,
with zero missing or duplicate identities. Median desktop traversal is
3,528.125 ms, median initial hydration is 459.544 ms, and cumulative Session
response bytes remain 11,026,467 B.

The runtime, unit, build, browser, production, and E2E checks are green. The
review's exact `git diff --check origin/main...HEAD` command still reports five
trailing-space lines already stored in the immutable starting HEAD; the
working-tree repair passes both `git diff --check` and
`git diff --check origin/main`. Because committing is explicitly prohibited
without confirmation, that triple-dot proof cannot observe the repair yet.
This plan therefore remains `IN PROGRESS` rather than claiming a fully green
auditable matrix.
