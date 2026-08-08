# Plan 072 — Deferred web Session optimizations

## Result

Plan 072 retained no new product optimization. It retained the benchmark and
attribution improvements needed to make that decision. Keyset pagination stops
at A1, deeper Ark splitting cannot meet its byte gate with the current shared
Overview dependencies, and a direct-destination SSR experiment does not produce
a stable 10% first-usable-render improvement.

The direct destination prefetch already existed at the planned-against commit.
Temporarily disabling it caused the exhaustive Sessions benchmark to fail its
zero-refetch invariant, so the pre-existing behavior remains unchanged.

## Environment

- Branch: `agent/migrate-web-sveltekit-orpc`
- Planned-against commit: `67ca9b0e060c0359628a8c2721401bd973c8ce4f`
- Measurement base before the final review fixes: `1a48962995ac5a203cd41cc6324d04b6402379aa`
- Bun: `1.3.13`
- Playwright: `1.61.1`
- Browser: Playwright Chromium from the repository lockfile
- Date: 2026-08-09
- Samples: one warm-up followed by three recorded samples; medians are reported

The committed JSON files contain every raw sample. Timing comparisons remain
machine-local and are not cross-host performance claims.

## Reproduction

```sh
bun tools/plan072-keyset-a1.ts
bun run --cwd apps/web benchmark:plan072-destination-render
cd apps/web
AI_USAGE_SESSION_BENCHMARK_OUTPUT=../../docs/performance/artifacts/plan072-final.json \
  bun --bun playwright test --config playwright.session-scroll.config.ts \
  e2e/session-scroll-benchmark.scale.ts
```

`tools/plan072-bundle-map.ts` runs after a production web build and writes both
the JSON and Markdown bundle maps.

## A — Keyset pagination

The corrected A1 probe publishes real 5,000- and 20,000-row SQLite revisions,
opens the same revision-scoped reader used in production for every page, and
calls `executeMaterializedSessionQuery(..., 'sessions', ...)`. It covers date
ascending/descending, project-rank ties, zero matches, Codex harness selection,
classifier origin selection, and a real revision transition. It records cache
checks/hits/misses, every SQLite phase, serialization time, response bytes,
identity completeness, and raw samples.

| Date-desc traversal | 5,000 rows | 20,000 rows |
| --- | ---: | ---: |
| Pages | 19 | 75 |
| Median traversal | 153.090 ms | 615.458 ms |
| Projection slice | 0.037 ms | 0.060 ms |
| Slice / residual SQLite | 0.0267% | 0.0108% |
| Serialization | 5.262 ms | 23.069 ms |
| Serialized transfer | 6,845,646 B | 27,462,633 B |
| Projection cache hit / miss | 18 / 1 | 74 / 1 |
| Totals cache hit / miss | 18 / 1 | 74 / 1 |

Slice growth is 1.62× for a 4× fixture increase. Duplicate and missing
identities are zero, and both exact revisions incur their own projection miss.

**Decision: rejected at STOP A1.** JavaScript slicing is far below the 10%
threshold and is not superlinear. No cursor contract or ADR is justified.

## B — Design-system and Ark splitting

The bundle map now reports explicit Overview, Sessions, Breakdown, and
Sessions-after-Drawer closures, including raw/gzip/Brotli sizes, Ark/Zag module
occurrences, and design-system modules co-located with those runtimes.

| Closure | Assets | Raw | Gzip | Brotli |
| --- | ---: | ---: | ---: | ---: |
| Overview | 36 | 891,161 B | 279,250 B | 241,574 B |
| Sessions | 39 | 975,032 B | 304,842 B | 264,152 B |
| Breakdown | 37 | 920,275 B | 289,762 B | 250,705 B |
| Sessions after Drawer | 40 | 1,016,329 B | 318,005 B | 275,537 B |

There are no duplicated Ark/Zag modules between chunks. The Overview closure
already contains the shared Ark/Zag runtime because Overview itself uses
Tooltip and Popover. Sessions adds 25,592 B gzip over Overview, while opening
the Drawer adds 13,163 B gzip statically and 41,297 B of raw JavaScript at
runtime. Median Drawer open time is 84.738 ms.

The earlier isolated Drawer/Tabs subpath trial increased initial gzip by
2.13 KiB. The deeper trials cannot remove the shared runtime from Sessions
without also replacing active Overview and table primitives, and the table and
Drawer content are required for their respective first-usable states.

**Decision: rejected.** The evidence provides no path to the required 10 KiB
target reduction without duplicating runtime code or replacing accessible Ark
primitives. No subpath or local overlay prototype remains in the final source.

## C — Direct destination SSR

The route benchmark uses canonical URLs (`/?tab=models`, not the invalid
`/?tab=breakdown`) and requires destination content plus interactive controls.
It records TTFB, HTML and hydration bytes, first useful/usable render, all
browser RPCs, JS/CSS counts, raw/gzip/Brotli closure sizes, loading-shell
observation, layout shift, and Drawer loading.

The planned-against source already prefetched direct destinations. The control
temporarily disabled that prefetch for non-Overview URLs:

| Route | No direct prefetch | Existing direct prefetch | Change |
| --- | ---: | ---: | ---: |
| Sessions usable | 480.6 ms | 525.5 ms | +9.3% |
| Filtered Sessions usable | 480.6 ms | 531.3 ms | +10.5% |
| Models usable | 415.0 ms | 407.5 ms | -1.8% |
| Projects usable | 418.2 ms | 459.6 ms | +9.9% |

The distributions overlap for Breakdown, and no destination demonstrates a
stable improvement of at least 10%. Direct prefetch also grows the Sessions
HTML from 25,755 B to 482,613 B and raises its median TTFB from 26.610 ms to
183.905 ms. Conversely, disabling the existing Sessions prefetch introduces a
browser Session RPC before the first scroll and fails the exhaustive benchmark
contract.

A second no-direct-prefetch run is retained as
`plan072-destination-final.json`. Its wider timing spread, notably on Models,
confirms that the small route-level differences are ordinary run variance and
not a stable candidate gain.

**Decision: no new C optimization retained.** The experiment is rejected on
its performance gate, while the planned-against prefetch is preserved because
removing it violates an existing no-refetch invariant. There is no second query
owner and no additional post-hydration business RPC.

## Final regression comparison

| Metric | Control | Final | Delta |
| --- | ---: | ---: | ---: |
| Initial | 481.794 ms | 443.396 ms | -8.0% |
| Desktop traversal | 3,752.577 ms | 3,632.960 ms | -3.2% |
| Mobile traversal | 78.668 ms | 61.788 ms | -21.5% |
| Filter | 200.315 ms | 120.280 ms | -40.0% |
| Sort | 234.733 ms | 238.050 ms | +1.4% |
| Heap delta | 25,485,104 B | 25,489,952 B | +0.02% |
| Hydration | 489,216 B | 489,216 B | 0% |
| Session RPCs | 26 | 26 | 0% |
| Desktop items / nodes | 29 / 581 | 29 / 581 | 0% |

The timing improvements are treated as run variance because the final product
path is intentionally unchanged. The +1.4% sort and +0.02% heap changes are
below the 10% regression threshold.

## Byte terminology

- **Code bytes:** raw files in the generated client closure.
- **Compressed code bytes:** deterministic gzip-9/Brotli compression of those
  generated files for same-build comparison.
- **Transfer bytes:** serialized RPC response bodies recorded by the browser or
  A1 traversal.
- **Deployed artifact bytes:** the files under
  `apps/web/.output-build/sveltekit/client`; they are not the same as HTTP
  transfer bytes.

## Artifacts

| Artifact | SHA-256 |
| --- | --- |
| `plan072-control.json` | `bb9023df3c78573151197a4e30d1f7825a048404ae3141966ac7082852dcc5e8` |
| `plan072-keyset-a1.json` | `9f20ef78382080db148d00b7d7cdbbeb07507cd02677f6034c1eff6a3e472610` |
| `plan072-bundle-map.json` | `20528f67f307952562ae0353fc9020ee1774a8ae9bacce6997479db9d871856c` |
| `plan072-destination-render.json` | `ff9f231a5717620105155cbe519a733851f9a7dd64e8461b013334e458439044` |
| `plan072-destination-ssr-control.json` | `dff84030317861d8aab2474f6c8ccb38870af7529d64fa0386a063f77414ae26` |
| `plan072-destination-final.json` | `72fdb5d007930935ce599407f0548cca39d0be2ff8344f8a74a270dc8799becd` |
| `plan072-final.json` | `1c926b28f1dc1d04e557f5b263894cd152daa55ba4abcf7f2f55d1b47b1ae463` |

## Remaining candidates

- A public keyset cursor remains unjustified unless future data changes the A1
  ratios materially.
- Ark splitting should be reconsidered only after Overview no longer requires
  the shared Popover/Tooltip runtime or a framework upgrade changes chunking.
- Direct destination SSR should be reconsidered only with a streaming design
  that improves first usable render without the current TTFB/HTML tradeoff.
