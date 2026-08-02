# Web framework migration performance baseline

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
