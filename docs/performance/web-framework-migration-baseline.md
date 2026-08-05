# Web framework migration performance baseline and final comparison

This is the Wave-0 Solid baseline for Plan 068. It is a comparison ledger, not
a composite score or a claim that the Svelte application is faster.

## Identity and safety

- Reviewed B0 checkpoint: `2051c4887894e42f31b309adf8446869d2e1b566`
- Measured B1-C checkpoint: `7d1ff6e54cfc89f8e619d3409c474ccf506c412c`
- Recorded: 2026-08-02, Europe/Paris
- Runtime: Bun 1.3.13 and the pinned repository/browser dependencies
- Fixtures: deterministic E2E/demo data and isolated temporary production
  homes, stores, ports, logs, rendezvous, and build outputs only

No command here may target a maintainer home, database, Skills directory,
engine rendezvous, or ordinary development server. Browser, production,
lifecycle, SSE, heap, timing, and startup commands require the coordinator's
exclusive process-test token.

## Session scale measurements

Reproduce the 5,000-session production fixture, warm-up, and three recorded
samples with:

```sh
bun run --cwd apps/web benchmark:session-scroll
```

The B1-C run passed all four tests and emitted these medians:

| Metric | Solid median | Greater-than-10% investigation trigger |
| --- | ---: | ---: |
| Initial settled load | 1526.194 ms | 1678.813 ms |
| Filter response | 225.676 ms | 248.244 ms |
| Sort response | 1390.970 ms | 1530.067 ms |
| Heap delta after full desktop traversal | 32,059,716 bytes | 35,265,688 bytes |
| Maximum Session page payload | 321,397 bytes | 353,537 bytes |
| Desktop maximum rendered items | 33 | 36 items |
| Desktop maximum Session DOM nodes | 624 | 687 nodes |
| Mobile maximum rendered items | 17 | 19 items |
| Mobile maximum Session DOM nodes | 258 | 284 nodes |

One mobile sample reached 18 rendered items and 273 Session nodes; the table
records the median. The final build must still satisfy the suite's reachability,
row-identity, network, geometry, and memory assertions. Crossing a trigger
requires investigation and a reviewed explanation; it cannot waive a failing
absolute gate.

The run emitted bounded `wide-event:file` lock-timeout telemetry from its
synthetic log sink. Playwright exited zero, all four assertions passed, the
server shut down, and the post-suite process/listener audit was empty. This is
classified as nonfatal fixture telemetry, not a product or benchmark failure.

The smaller deterministic audit is reproduced with:

```sh
bun run test:e2e -- e2e/audit-performance.spec.ts
```

It passed and emitted 262 nodes for Overview advanced analysis. The desktop
Session surface/table contained 80/79 nodes at 1024 px. The 361 px mobile
surface contained 45 summary nodes, 45 total Session nodes, and no table.

## Production artifact closure and bytes

Build and enumerate the selected artifact in stable path order:

```sh
bun run build
find apps/web/.output-build/nitro -type f -printf '%s %p\n' | LC_ALL=C sort -k2
du -sb apps/web/.output-build/nitro
```

The recursive Bun `stat` inventory contained 118 files and 4,931,722 bytes:
1,200,533 public bytes and 3,730,859 server bytes. The canonical sorted
`path:size` manifest SHA-256 was
`495de210cb7051c7415d5ac506f255f5e68c7fd74d0a6005d718d0d12f564a7c`.
The final Svelte adapter must use its selected output directory and classify
closure changes by module and asset. Total bytes alone do not prove retired
Solid/Nitro or server-module reachability.

## Initial HTML, hydration, and requests

The seven-test production suite is reproduced with:

```sh
bun run test:e2e-production
```

The B1-C production probe launched `apps/web/e2e/production-server.ts` on an
isolated port and attached Playwright request listeners before `page.goto`.
It waited for `main[data-hydrated="true"]`, then for network settlement, and
asserted the exact bootstrap URL count, duplicate URLs, and pending requests.
It closed the browser and terminated the fixture with the production config's
15-second graceful-shutdown bound.

| Measurement | Solid result |
| --- | ---: |
| Initial HTML bytes | 36,995 |
| Server render TTFB | 9.5 ms |
| Server response complete | 10.1 ms |
| Hydration marker settled | 117.5 ms |
| Total initial requests | 15 |
| Bootstrap acquisitions | 1 |
| Duplicate already-prefetched exact URLs | 0 |
| Server queries pending after settlement | 0 |

The response contained both the hydration marker and usage-report content.
Request classes were one document, seven scripts, one stylesheet, one
EventSource, four fetches, and one other request. The exact bootstrap response
SHA-256 was
`c6234ffc648ce32eff6545c823eea8c3f3bead4a3a0e77d5e2a06a5f2303b8c4`.

## Startup, shutdown, SSE, and output isolation

Three isolated cold/warm pairs used direct Vite, `VITE_AI_USAGE_E2E=1`,
`NITRO_DEV_RUNNER=self`, `BROWSER=none`, unique loopback ports, and fresh
temporary HOME/TMP/XDG roots. Cold runs removed only the explicit ignored
`apps/web/.output-dev`; warm runs preserved it. Each child received SIGTERM
with a 15-second SIGKILL fallback, and every child exited before cleanup.

| Run | Cold | Warm |
| --- | ---: | ---: |
| 1 | 3552.362 ms | 3376.101 ms |
| 2 | 3606.445 ms | 3438.394 ms |
| 3 | 3491.509 ms | 3499.788 ms |
| Median | 3552.362 ms | 3438.394 ms |

The operational gates are:

```sh
bun run test:web-production
bun run test:web-dev-build-isolation
bun run test:setup-loopback
```

All passed. The isolation gate observed 80 healthy requests, unchanged dev
process count (2 before and after), zero HMR messages, zero deleted dev-output
descriptors, a 21,566.405 ms build, and the expected rejected competing build.
The final process audit found no browser/server fixture processes and no
listeners on the suite or measurement ports.

## Full reproducibility gate

The complete unchanged Solid baseline passed:

```sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run typecheck
bun test apps/web/src apps/web/*.test.ts
bun run test
bun run build
bun run test:e2e
bun run test:e2e-demo
bun run test:e2e-production
bun run --cwd apps/web benchmark:session-scroll
bun run test:web-production
bun run test:web-dev-build-isolation
bun run test:setup-loopback
git diff --check
```

Retained counts are 585 focused Web tests, 90 functional browser tests, one
destructive-negative demo test, seven production-report tests, two scale tests,
and four benchmark tests. The parity ledger separately freezes all 104 browser
titles across demo, production, scale, and benchmark configurations.


## Final SvelteKit comparison

The retained client/session/startup measurements use Svelte checkpoint
`aa992c6c864be6e7087b414dbfd8e83eb548dd92`; final artifact, SSR, lifecycle and
clean-gate closure use implementation checkpoints
`c733f797fc441e72b835527641c4f609de82bfe9` and deterministic-artifact correction
`6d0f35f3a893c0cb349c8f14c9d7aab700c2e883`. All use Bun 1.3.13, the pinned
repository/browser dependencies, clean worktrees, deterministic fixtures and
isolated runtime roots.
A delta is `(Svelte - Solid) / Solid * 100`; lower is better for time,
bytes, heap, payload, and DOM counts. This remains a per-metric ledger, not a
composite score or a claim that either application is uniformly faster.

### Final Session scale

The final benchmark passed its warm-up and three samples.

| Session metric | Solid B1-C median | Svelte median | Delta | Classification |
| --- | ---: | ---: | ---: | --- |
| Initial settled load | 1526.194 ms | 1525.805 ms | -0.025% | Within trigger |
| Filter response | 225.676 ms | 300.274 ms | +33.055% | Reviewed deviation |
| Sort response | 1390.970 ms | 1510.573 ms | +8.599% | Within trigger |
| Heap delta after desktop traversal | 32,059,716 B | 27,639,644 B | -13.787% | Lower |
| Maximum Session page payload | 321,397 B | 220,694 B | -31.333% | Lower |
| Desktop rendered items / nodes | 33 / 624 | 33 / 624 | 0% / 0% | Equal |
| Mobile rendered items / nodes | 17 / 258 | 18 / 291 | +5.882% / +12.791% | Nodes reviewed |

| Sample | Initial | Filter | Sort | Heap | Page | Desktop items/nodes | Mobile items/nodes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1525.805 ms | 300.274 ms | 1479.236 ms | 27,639,644 B | 220,694 B | 33 / 624 | 18 / 291 |
| 2 | 1556.740 ms | 316.921 ms | 1510.573 ms | 27,636,988 B | 220,694 B | 33 / 624 | 19 / 307 |
| 3 | 1508.989 ms | 298.268 ms | 1510.580 ms | 27,643,676 B | 220,694 B | 33 / 624 | 12 / 194 |

The filter trigger is real because the Svelte samples are clustered. It remains
below the 1.5-second absolute interaction budget, is 9.774% below the retained
Solid B0 median of 332.803 ms, and preserves exactly one report bootstrap plus
zero route `__data.json` requests per filter or sort transition. The cost
includes the layout rerun required for correct live URL, back/forward, input,
focus, and scroll synchronization. Two independent reviewers accepted this
deviation; it is not a performance win.

The mobile-node trigger combines a one-item median virtual-window difference
with one additional semantic element per card. At the same 18-card count, Solid
recorded 273 nodes and Svelte records 291, a 6.59% structural delta. The extra
element keeps fresh/cache/duration explanations separate. The worst final
sample remains 19 items and 307 nodes, far below the 600-item absolute cap.
Reachability, row identity, wire, geometry, memory, and cleanup assertions all
pass. Two independent reviewers accepted this deviation.

The final deterministic audit emitted 261 nodes for Overview advanced analysis,
80/79 nodes for the 1024 px desktop Session surface/table, and 48 summary and
surface nodes with no table at 361 px. The benchmark's bounded synthetic-log
lock-timeout messages reported `dropped=0`; all four tests passed and every
measured listener was reaped.

### Final artifact closure

```sh
bun run build
find apps/web/.output-build/sveltekit -type f -printf '%P:%s\n' | LC_ALL=C sort | sha256sum
du -sb apps/web/.output-build/sveltekit
du -sb apps/web/.output-build/sveltekit/client
du -sb apps/web/.output-build/sveltekit/server
```

| Artifact | Solid | Svelte | Delta / classification |
| --- | ---: | ---: | --- |
| Selected output | `.output-build/nitro` | `.output-build/sveltekit` | Adapter cutover |
| File count | 118 | 292 | +147.458%; reviewed topology |
| Total bytes | 4,931,722 | 7,999,079 | +62.196%; reviewed topology |
| Public/client bytes | 1,200,533 | 1,178,718 | -1.817% |
| Server bytes | 3,730,859 | 6,795,687 | +82.148%; reviewed topology |
| Sorted `path:size` SHA-256 | `495de210cb7051c7415d5ac506f255f5e68c7fd74d0a6005d718d0d12f564a7c` | `7ab9de1edcd79b2ce3017cd16ef75cf0ecf159177ba9e3e2ceb16c5e146034c1` | Reproduced twice at `6d0f35f` |

The Svelte server contains 112 source maps totaling 4,375,416 bytes, or 64.4%
of server bytes; 176 JavaScript files plus those maps explain most of the
file-count increase. Client bytes are lower. The source, emitted-retired-stack,
and client-manifest scanners are green, so this is server/debug chunk topology,
not client shipping or retired/server leakage. Both independent reviewers
accepted the artifact deviations without claiming non-map superiority because
the Solid source-map split was not retained.

### Final SSR, hydration, and requests

The rebuilt final artifact passed the eight production report tests and both
5,000-session scale tests in one serialized gate.

| Measurement | Solid | Svelte | Delta / classification |
| --- | ---: | ---: | --- |
| Initial HTML | 36,995 B | 11,602 B | -68.639% |
| TTFB | 9.5 ms | 5.788 ms | -39.074% |
| Response complete | 10.1 ms | 8.677 ms | -14.089% |
| Hydration marker | 117.5 ms | 155.059 ms | +31.965%; reviewed |
| Initial requests | 15 | 40 | +166.667%; reviewed chunking |
| Dehydrated bootstrap | 1 | 1 | Exact gate |
| Bootstrap after hydration | 0 | 0 | Exact gate |
| Pending server queries | 0 | 0 | Exact gate |
| Filter/sort route-data reloads | not measured | 0 | Exact gate |

Svelte request classes were one document, one EventSource, four fetches, one
other request, 31 scripts, and two stylesheets. The extra requests are asset
splitting, not data duplication; client bytes are 1.817% lower. Hydration is
37.559 ms slower while HTML and server response measurements are lower. All
exact SSR, dehydration, settlement, and browser-failure gates pass. Reviewers
accepted the hydration/request deviations; no overall performance claim is
made.

### Final startup and lifecycle

Three isolated direct-Vite pairs used `VITE_AI_USAGE_E2E=1`, unique ports,
fresh HOME/TMP/XDG roots, an absent phase-specific
`apps/web/.svelte-kit/dev` tree for cold runs, and the generated tree for warm
runs. Every listener returned HTTP 200 and its exact process group was reaped.

| Run | Solid cold | Solid warm | Svelte cold | Svelte warm |
| --- | ---: | ---: | ---: | ---: |
| 1 | 3552.362 ms | 3376.101 ms | 4612 ms | 4293 ms |
| 2 | 3606.445 ms | 3438.394 ms | 4202 ms | 4163 ms |
| 3 | 3491.509 ms | 3499.788 ms | 4258 ms | 4211 ms |
| Median | 3552.362 ms | 3438.394 ms | 4258 ms | 4211 ms |
| Delta | — | — | +19.864% | +22.470% |

The stable cold/warm deltas show fixed SvelteKit/Vite plugin and module-graph
startup cost rather than a cache miss. Absolute startup remains about 4.2
seconds and no readiness budget fails. Removing phase graph generation or
sharing check/dev/build output would violate the accepted output-isolation
seam. Both independent reviewers accepted the startup deviations.

The final isolation gate emitted `devReadyDurationMs=8017.215`,
`buildDurationMs=21639.521`, 78 healthy requests, zero HMR messages, zero
deleted output descriptors, process count 2 to 2, and the expected rejected
competing build. Production lifecycle, long SSE, port collision, root
supervision, loopback, and cleanup gates passed.

### Required clean reproducibility gate

The final candidate must pass this complete sequence from a clean worktree:

```sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run typecheck
bun test apps/web/src apps/web/*.test.ts
bun run test
bun run build
bun run test:web-migration-parity
bun run test:web-client-manifest
bun run test:web-retired-stack-build
bun run test:e2e
bun run test:e2e-demo
bun run test:e2e-production
bun run --cwd apps/web benchmark:session-scroll
bun run test:web-production
bun run test:web-dev-build-isolation
bun run test:setup-loopback
git diff --check
```

Every greater-than-10% delta is separately explained and independently
approved. No individual metric is used to claim an overall win.

The final detached clean gate at `a161860` passed all four Session benchmark
tests, the eight production tests plus both scale tests, and every lifecycle
gate. A coordinator context compaction discarded only the last benchmark
terminal stream; Playwright retained a durable `passed` result with no failed
tests and the process/listener audit was empty. The preceding clean checkpoint
captured medians of 1563.288 ms initial, 291.831 ms filter, 1489.281 ms sort,
27,639,784 bytes heap, 220,694 bytes maximum page, desktop 33/624 and mobile
17/275. No client or Session implementation changed between that captured run
and the final clean gate.

The cold X2 audit found that SvelteKit default timestamp app version changed
72 content-hashed manifest paths across same-SHA builds even though file counts
and aggregate bytes were stable. Correction `6d0f35f` pins `kit.version.name`
to the complete Git revision through an argument-array subprocess, preserving
SvelteKit deployment-version semantics without shell interpolation. Two
consecutive committed-checkpoint builds produced byte-identical sorted
`path:size` manifests with the `7ab9de1e…` digest above. The earlier observed
`b7bd2d9b…` digest remains an honest pre-correction sample, not final identity.

## Hosted implementation-PR release evidence

The local Solid/Svelte comparison above remains the controlled comparative
record. Hosted GitHub runner timings are recorded separately because runner
hardware and scheduling are not controlled; no cross-environment percentage
delta is calculated.

At implementation checkpoint
`ac63cf8bb2e4623d62f949d2991a853b3e4826f7`, Actions run
[`30947971788`](https://github.com/Ziktraug/ai-usage/actions/runs/30947971788)
passed the complete performance lane with a 5,000-Session synthetic fixture,
four of four benchmark tests, and three retained samples.

| Hosted metric | Median |
| --- | ---: |
| Initial settled load | 2160.883 ms |
| Filter response | 313.722 ms |
| Sort response | 1562.129 ms |
| Heap delta after desktop traversal | 27,746,240 B |
| Maximum Session page payload | 227,094 B |
| Desktop rendered items / nodes | 33 / 624 |
| Mobile rendered items / nodes | 19 / 307 |

The hosted traversal keeps the 180-second outer benchmark cap and the existing
20-second assertion timeout. Each page step must make observable progress by
advancing either the Session index or scroll height, and completion still
requires final index `4998`. This prevents a fixed 120-second driver deadline
from expiring while a large but progressing traversal is inside the approved
product budget; it does not increase a timeout, weaken the final assertion, or
accept a stalled traversal. Production scale, process cleanup, listener cleanup,
payload and DOM limits all remained green.

## Session surface scroll correction, 2026-08-05

`calculateSessionViewportHeight` sized the surface from its own
`getBoundingClientRect().top`. That is circular: the height is part of the
document, so each pixel scrolled moved the surface up a pixel, grew it a pixel,
grew the document a pixel, and the reader gained nothing. Measured on the
deterministic fixture at 1440x900, asking for scroll position 400 landed at 163
and asking for 1000 landed at 235, while the document walked 1063 to 1231 px. The
retired Solid table did the same and was worse — 400 landed at 35, 1000 at 99 —
so this was pre-existing rather than a migration regression.

The height now follows the viewport alone. The same probe honours every requested
position and holds the document at 1810 px and the surface at 876 px throughout.

| Session metric | Recorded Svelte | Corrected | Delta | Classification |
| --- | ---: | ---: | ---: | --- |
| Initial settled load | 1525.805 ms | 1519.008 ms | -0.445% | Within trigger |
| Filter response | 300.274 ms | 177.933 ms | -40.743% | Lower |
| Sort response | 1510.573 ms | 1487.344 ms | -1.538% | Within trigger |
| Heap delta after desktop traversal | 27,639,644 B | 27,538,740 B | -0.365% | Lower |
| Maximum Session page payload | 220,694 B | 220,694 B | 0% | Equal |
| Desktop rendered items / nodes | 33 / 624 | 37 / 696 | +12.121% / +11.538% | Reviewed deviation |
| Mobile rendered items / nodes | 19 / 307 | 21 / 339 | +10.526% / +10.423% | Reviewed deviation |

The DOM triggers are explained by the correction rather than by new work. The
recorded maxima were artificially low: under the treadmill the surface was still
growing while the benchmark traversed, so it never reached the height it was
converging on. It now starts at that height — 876 px for a 900 px viewport less
the 24 px inset, the same value the old formula saturated at — so the virtual
window reaches its maximum on the first frame. Four extra desktop rows and two
extra mobile cards follow directly from a surface that is finally the size it
always intended to be. Both remain far below the 600-item absolute cap, and the
scale suite's reachability, row-identity, wire, geometry and memory assertions all
pass.

The 40.743% filter improvement is the same cause seen from the other side:
removing the window `scroll` listener removes a style write and a forced layout
from every scroll event, so the filter path no longer competes with it. This is a
measured consequence of deleting work, not a tuning claim.

## Presentation-parity audit benchmark, 2026-08-05

The final presentation-parity tree passed the four-test benchmark with these
medians: 1534.222 ms initial, 346.492 ms filter, 1484.558 ms sort, 27,942,532
bytes heap, 220,694 bytes maximum page, desktop 37/733 and mobile 21/360. All
metrics remain within 10% of the corrected baseline above except filter response,
which is +94.7% against 177.933 ms.

The filter samples were 346.492, 189.778 and 357.743 ms rather than a uniformly
shifted cluster. A controlled detached run at `92a35624`, immediately before the
filter-only stale-range correction, used the same warm-up and production fixture
and recorded 205.118 ms. The low final sample therefore overlaps the predecessor;
the median trigger is transition variance amplified by the presentation-parity
work, not evidence of a transport or pagination regression.

The timing boundary starts when text is entered and ends one animation frame
after both the 1/5,000 count and new Session fingerprint are visible. Commit
`d4460595131aacbbcd093cd39c72f22ccf008e58` must remove the stale Activity range
during that filter request to match Solid and the browser contract, then rebuild
the timeline when the committed response arrives. That unmount/remount and its
layout now fall inside the measured frame. Initial load, sort, heap, page bytes,
rendered items and DOM-node counts did not cross their corrected triggers, and
the benchmark's four tests and absolute budgets passed unchanged. This records
the cost as a reviewed parity consequence; it is not a performance improvement.
