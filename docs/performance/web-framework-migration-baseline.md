# Web framework migration performance baseline

This is the Wave-0 Solid baseline for Plan 068. It is a comparison ledger, not
a composite score and not a claim that the Svelte application is faster.

## Identity and safety

- Baseline commit: `2183270ebfbb886fafa7e6268893122db9b364c0`
- Recorded: 2026-08-02, Europe/Paris
- Runtime: Bun 1.3.13 and the pinned repository/browser dependencies
- Source of retained results:
  [`plans/068-execution-state.md`](../../plans/068-execution-state.md)
- Fixtures: deterministic E2E/demo data and isolated temporary production
  homes, stores, ports, logs, rendezvous, and build outputs only

No command in this document may be pointed at a maintainer home, database,
Skills directory, engine rendezvous, or ordinary development server. Browser,
production, lifecycle, SSE, heap, timing, and startup commands use the
coordinator's exclusive process-test token.

## Retained Session scale measurements

The authoritative command is:

```sh
bun run --cwd apps/web benchmark:session-scroll
```

It warms the 5,000-session production fixture and records three samples. B0
passed four tests and retained these medians:

| Metric | Solid median | Greater-than-10% investigation trigger |
| --- | ---: | ---: |
| Initial settled load | 1535.192 ms | 1688.712 ms |
| Filter response | 332.803 ms | 366.084 ms |
| Sort response | 1409.614 ms | 1550.576 ms |
| Heap delta after full desktop traversal | 32,452,828 bytes | 35,698,111 bytes |
| Maximum Session page payload | 321,397 bytes | 353,537 bytes |
| Desktop maximum rendered items | 33 | 36 items |
| Desktop maximum Session DOM nodes | 624 | 687 nodes |
| Mobile maximum rendered items | 17 | 19 items |
| Mobile maximum Session DOM nodes | 258 | 284 nodes |

The final build must still satisfy the scale suite's reachability, row identity,
network, geometry, and memory assertions. Crossing a trigger requires
investigation and a reviewed explanation; the arithmetic is not an automatic
waiver for a failing absolute gate.

The smaller deterministic DOM audit is reproduced by the functional suite:

```sh
bun run test:e2e -- e2e/audit-performance.spec.ts
```

It emits the desktop/mobile Session surface and Overview advanced-analysis DOM
measurements from the synthetic fixture. B0 retained the green result but did
not retain those emitted node counts, so the coordinator must capture their
JSON at the next measured checkpoint rather than inventing values here.

## Production artifact closure and bytes

Build the current artifact with the repository's locked, isolated output
owner:

```sh
bun run build
find apps/web/.output-build/nitro -type f -printf '%s %p\n' | LC_ALL=C sort -k2
du -sb apps/web/.output-build/nitro
```

For the final Svelte adapter, run the same file-size listing against its selected
production output directory and classify closure changes by module and asset.
The final client manifest scan is the authority for retired Solid/Nitro and
server-module reachability; total bytes alone cannot prove the boundary.

B0 proved an uncached production build and all workspace builds green. It did
not retain a normalized closure byte total, so Wave 1/F0 must capture the
selected adapter's equivalent output and X1 must compare both explicit file
lists. No baseline byte total is fabricated in this record.

## Initial HTML, hydration, and requests

The production fixture and SSR assertions are exercised by:

```sh
bun run test:e2e-production
```

The seven production-report tests passed at B0, including initial Overview SSR,
focused refresh stability, exact-revision Session paging, chronology/VCS, source
control, and mobile paging. The initial response must continue to contain the
bounded support-backed report content required by ADR 0007.

Wave 7 must add and retain per-run instrumentation for:

- initial response bytes and meaningful settled HTML markers;
- server render duration and browser hydration-settle duration;
- bootstrap acquisition count (exactly one);
- already-prefetched exact request count (zero duplicates);
- total initial request count by bounded response class; and
- server queries still running after response settlement (zero).

Those numeric values were not emitted by the B0 harness, so they remain
explicit coordinator-run measurements rather than zero-valued placeholders.
The same production command, plus the new counter assertions, is the
reproduction gate.

## Startup, shutdown, SSE, and output isolation

The operational baseline is reproduced by these existing commands:

```sh
bun run test:web-production
bun run test:web-dev-build-isolation
bun run test:setup-loopback
```

B0 passed all three. The lifecycle gate proved engine/Web start and clean stop;
the concurrent dev/build gate observed 79 healthy requests, no HMR failure, no
deleted development descriptors, and the expected rejected competing build;
the setup gate proved numeric IPv4 loopback. B0 did not retain cold/warm startup
milliseconds or a production output byte total.

Packet B2 owns the reusable adapter lifecycle fixture that records cold/warm
startup, SSR, assets, abort propagation, a greater-than-30-second SSE, signal
shutdown, descendant/port exit, explicit `bun --no-env-file`, and isolated
outputs. Those process measurements require the coordinator token when
integrated. X1 compares the selected Svelte adapter with this Solid operational
baseline and investigates every regression over 10% without combining unlike
metrics.

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

The retained counts were 585 focused Web tests, 90 functional browser tests,
one destructive-negative demo test, seven production-report tests, two scale
tests, and four benchmark tests. The parity ledger separately freezes all 104
individual browser titles, including demo, production, scale, and benchmark
configurations.
