# Plan 072 — Deferred web Session optimizations

## Result

Plan 072 retained the design-system split from candidate B. Focused local
Popover and Tooltip primitives remove non-initial Ark overlay code from the
initial closure while the existing Drawer remains lazy. Initial gzip falls by
13,548 B and cumulative gzip through the first Drawer open grows by 1.112%, so
the candidate passes both byte gates without duplicating Ark or Zag runtimes.

Keyset pagination stops at A1, and a direct-destination SSR experiment does not
produce a stable 10% first-usable-render improvement.

The direct destination prefetch already existed at the planned-against commit.
Temporarily disabling it caused the exhaustive Sessions benchmark to fail its
zero-refetch invariant, so the pre-existing behavior remains unchanged.

## Environment

- Branch: `agent/migrate-web-sveltekit-orpc`
- Planned-against commit: `67ca9b0e060c0359628a8c2721401bd973c8ce4f`
- Candidate B control commit: `9bbcc90d2e7edf8ccdfcda327b566208466c34c7`
- Retained source commit: `88384202`
- Gate source commit: `084108fa`
- Bun: `1.3.13`
- Playwright: `1.61.1`
- Browser: Playwright Chromium from the repository lockfile
- Date: 2026-08-09
- Samples: one warm-up followed by seven Drawer samples or three exhaustive
  Session samples; medians are reported

The committed JSON files contain every raw sample. Timing comparisons remain
machine-local and are not cross-host performance claims.

## Reproduction

```sh
bun tools/plan072-keyset-a1.ts
bun run --cwd apps/web benchmark:plan072-destination-render
AI_USAGE_PLAN072_CONTROL_COMMIT=9bbcc90d2e7edf8ccdfcda327b566208466c34c7 \
AI_USAGE_PLAN072_CONTROL_CLIENT_DIR=/tmp/plan072-control-build/apps/web/.output-build/sveltekit/client \
  bun tools/plan072-ark-split.ts
cd apps/web
AI_USAGE_SESSION_BENCHMARK_OUTPUT=../../docs/performance/artifacts/plan072-final.json \
  bun --bun playwright test --config playwright.session-scroll.config.ts \
  e2e/session-scroll-benchmark.scale.ts
```

The final control uses the same Session command from the pinned `9bbcc90d`
worktree and writes `plan072-final-control.json`. It runs immediately before
the candidate to keep machine conditions comparable.

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

The retained split exposes passive and overlay-specific design-system entry
points. Overview's Tooltip and table column Popover use focused local
primitives; Ark Drawer, Tabs, Select, and MultiSelect remain on lazy boundaries.
The bundle map reports explicit Overview, Sessions, Breakdown, and
Sessions-after-Drawer closures, including raw/gzip/Brotli sizes, Ark/Zag module
occurrences, and design-system modules co-located with those runtimes.

| Closure | Assets | Raw | Gzip | Brotli |
| --- | ---: | ---: | ---: | ---: |
| Overview | 47 | 810,954 B | 265,686 B | 232,976 B |
| Sessions | 50 | 895,792 B | 291,686 B | 255,887 B |
| Breakdown | 49 | 853,776 B | 280,683 B | 246,164 B |
| Sessions after Drawer | 54 | 991,544 B | 321,805 B | 282,505 B |

The authoritative gate uses the exact initial closure plus the runtime files
loaded by opening the Drawer, rather than subtracting static destination
closures. Initial gzip changes from 279,234 B to 265,686 B (-13,548 B). The
incremental Drawer load changes from 13,163 B to 29,962 B gzip, making the
cumulative total 292,397 B control versus 295,648 B candidate (+1.112%). The
matched seven-sample Drawer medians are 105.033 ms control and 108.312 ms
candidate (+3.12%, below the 10% ceiling). There are no duplicated Ark/Zag
modules between chunks.

Behavioral tests cover keyboard focus, Escape, light dismiss, focus return,
viewport clamping, scroll positioning, Tooltip hover/focus delay, and cleanup.
The retained local primitives preserve the public interaction contracts while
avoiding the initial Ark overlay runtime.

**Decision: retained.** The initial reduction exceeds 10 KiB, cumulative bytes
through Drawer remain below the 5% growth limit, Drawer timing does not regress,
and all interaction, accessibility, and duplication gates pass.

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
| Initial | 579.901 ms | 606.573 ms | +4.6% |
| Desktop traversal | 4,654.428 ms | 4,195.681 ms | -9.9% |
| Mobile traversal | 93.224 ms | 94.318 ms | +1.2% |
| Filter | 217.300 ms | 234.474 ms | +7.9% |
| Sort | 271.265 ms | 281.780 ms | +3.9% |
| Heap delta | 25,466,132 B | 25,251,488 B | -0.8% |
| Hydration | 489,216 B | 489,216 B | 0% |
| Session RPCs | 26 | 26 | 0% |
| Desktop items / nodes | 29 / 581 | 29 / 581 | 0% |

The control and candidate were run sequentially after an unmatched rerun showed
machine-time drift. Every matched timing change remains below the 10%
regression threshold; all byte, request, identity, and DOM contracts remain
unchanged.

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
| `plan072-ark-control-7.json` | `d387ab81ad6326dcb8665ea79b82e996587ef6bc2ca256a002cfe013b6280c34` |
| `plan072-bundle-map.json` | `04353380ce1d0faa6fdf1ca3ecab55124a5450c879bbcd76efe0bb63cc5fad40` |
| `plan072-destination-render.json` | `17af1d726f3dcb5c68a45315cc30e8dae2a545183c8805813cf92d7872d6b3bd` |
| `plan072-ark-split.json` | `bc5435199ed71529488c4088491563df5b736e08f1b60666f8ad05e140aab9a3` |
| `plan072-destination-ssr-control.json` | `dff84030317861d8aab2474f6c8ccb38870af7529d64fa0386a063f77414ae26` |
| `plan072-destination-final.json` | `72fdb5d007930935ce599407f0548cca39d0be2ff8344f8a74a270dc8799becd` |
| `plan072-final-control.json` | `47a940d4cf8f2942adbf7c1cba0e3e0ee33ca7fe6689e2f5546bd2bc5babea77` |
| `plan072-final.json` | `dd182c1690092b0bf8e43e8df92675e45c65f578787de99cf0ef516acd3ef488` |

## Remaining candidates

- A public keyset cursor remains unjustified unless future data changes the A1
  ratios materially.
- Further Ark splitting is unjustified unless a framework upgrade changes the
  remaining lazy Drawer/Tabs/Select chunking materially.
- Direct destination SSR should be reconsidered only with a streaming design
  that improves first usable render without the current TTFB/HTML tradeoff.
