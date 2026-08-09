# Plan 072 — Deferred web Session optimizations

## Result

The second review rejects every new optimization candidate:

- A stops at A1 because OFFSET slicing remains far below 10% of residual
  SQLite work at both corrected fixture sizes and does not grow superlinearly.
- B stops at its composite feasibility gate after failing the initial-gzip and
  Drawer-latency thresholds once the global Ark
  Popover and Tooltip are restored. Its granular exports and local column
  disclosure are removed from the final source.
- C remains rejected because the existing direct-destination prefetch does not
  provide a stable 10% first-usable-render gain when compared with the
  no-prefetch trial, while removing it violates the existing no-refetch
  invariant.

The Plan is `DONE`: the complete final validation matrix and post-rejection
Session benchmark are current and green.

## Environment and source identity

- Branch: `agent/migrate-web-sveltekit-orpc`
- Measurement baseline: `dfa5b66ed02f2fe25fa14764faa7b874e3cde8f7`
- Reviewed retained-source checkpoint: `1060c2d58a88d9f43573ea89deb4c0c57ba86a27`
- B control product source: `9bbcc90d2e7edf8ccdfcda327b566208466c34c7`
- Bun: `1.3.13`
- Playwright: `1.61.1`
- Chrome: `Google Chrome 151.0.7922.75`
- Svelte: `5.56.8`
- SvelteKit: `2.70.2`
- Vite: `8.2.0`
- Date and timezone: 2026-08-09, Europe/Paris

The measurement and rejection record was committed after confirmation at the
reviewed retained-source checkpoint above. The B artifact records
`worktreeDirty: true`; its product-source composition is HEAD plus the review
fixes described below. The control is the pinned commit above. Both production
outputs were deleted and rebuilt by `sveltekit-production-build.ts` immediately
before their measurements. The rejected trial source was then removed, while
its raw samples and bundle map were retained as evidence.

## Reproduction

```sh
bun test tools/plan072-keyset-a1.test.ts
bun tools/plan072-keyset-a1.ts

# Dedicated discovery proof
cd apps/web
bun --bun playwright test --config playwright.plan072.config.ts --list
bun --bun playwright test --list

# Control: pinned worktree, clean production build, then bundle map and seven samples
cd /tmp/plan072-control-build/apps/web
bun run build
AI_USAGE_PLAN072_CONTROL=1 \
AI_USAGE_PLAN072_OUTPUT=/home/nathan/Projects/Github/ai-usage/docs/performance/artifacts/plan072-ark-control-7.json \
  bun --bun playwright test --config playwright.plan072.config.ts \
  e2e/plan072-destination-render.benchmark.ts

# Candidate: same build and browser protocol
cd /home/nathan/Projects/Github/ai-usage/apps/web
bun run build
AI_USAGE_PLAN072_OUTPUT=../../docs/performance/artifacts/plan072-destination-render.json \
  bun --bun playwright test --config playwright.plan072.config.ts \
  e2e/plan072-destination-render.benchmark.ts

cd /home/nathan/Projects/Github/ai-usage
AI_USAGE_PLAN072_CONTROL_CLIENT_DIR=/tmp/plan072-control-build/apps/web/.output-build/sveltekit/client \
  bun tools/plan072-ark-split.ts
```

The committed benchmark filename no longer matches the ordinary Playwright
inventory. The dedicated config discovers 43 tests: one warm-up, 35 route
samples, and seven Drawer samples. The ordinary config discovers 112 tests in
18 files and does not include the benchmark.

## A — Keyset pagination

The corrected fixture uses production campaign density:

| Fixture | Sessions | Classifier sessions | Campaigns | Pages at 200 |
| --- | ---: | ---: | ---: | ---: |
| 5k | 5,000 | 1 | 4,999 | 25 |
| 20k | 20,000 | 4 | 19,996 | 100 |

The probe covers date ascending and descending, project-rank ties, zero
matches, Codex filtering, classifier filtering, cache counters, serialization,
response bytes, and an actual revision change.

| Date-desc traversal | 5k | 20k |
| --- | ---: | ---: |
| Unique top-level campaign identities | 4,999 | 19,996 |
| Missing / duplicate identities | 0 / 0 | 0 / 0 |
| Median traversal | 190.807 ms | 814.772 ms |
| Projection slice | 0.050 ms | 0.105 ms |
| Slice / residual SQLite | 0.0298% | 0.0147% |
| Serialization | 8.207 ms | 27.366 ms |
| Serialized transfer | 9,125,414 B | 36,608,564 B |
| Projection cache hit / miss | 24 / 1 | 99 / 1 |
| Totals cache hit / miss | 24 / 1 | 99 / 1 |

Slice cost grows 2.10x for a 4x fixture increase. Each exact revision incurs
its own projection miss and the sampled first/last identities do not overlap.

Raw date-desc samples (the table above reports their medians) are:

| Metric | 5k samples | 20k samples |
| --- | --- | --- |
| Traversal | 190.807, 196.507, 188.991 ms | 824.448, 814.772, 776.258 ms |
| Projection slice | 0.050, 0.023, 0.020 ms | 0.101, 0.105, 0.104 ms |
| Serialization | 8.207, 9.752, 6.845 ms | 26.539, 34.337, 27.366 ms |
| Serialized transfer | 9,125,414, 9,125,414, 9,125,414 B | 36,608,564, 36,608,564, 36,608,564 B |

**Decision A: rejected at STOP A1.** Both slice shares are far below 10% and
no superlinear growth is present. No cursor contract or ADR is introduced.

## B — Design-system and Ark splitting

The measured candidate is a disposable composite feasibility spike, not an
isolated-trial result. It combines several proposed boundaries; individual
effects cannot be attributed and none are claimed. The reviewed version
restores the global Ark Popover and Tooltip. The only no-Ark overlay in the
spike is the local column-visibility disclosure; it does not introduce a
generic overlay component. Control and candidate use the same machine, build
script, Bun, Chrome, fixture, one unrecorded warm-up, and seven recorded
samples.

| Metric | Control | Candidate | Delta | Gate |
| --- | ---: | ---: | ---: | --- |
| Initial raw | 891,161 B | 837,039 B | -54,122 B | informational |
| Initial gzip | 279,246 B | 271,935 B | -7,311 B | decrease at least 10 KiB: **fail** |
| Initial Brotli | 241,604 B | 239,047 B | -2,557 B | informational |
| Incremental Drawer gzip | 13,163 B | 25,559 B | +12,396 B | informational |
| Total through Drawer gzip | 292,409 B | 297,494 B | +1.739% | growth at most 5%: pass |
| Drawer-open median | 97.021 ms | 122.689 ms | +26.46% | regression at most 10%: **fail** |
| Duplicated Ark/Zag modules | 0 | 0 | 0 | pass |

Raw Drawer samples are:

- control: 94.436, 92.413, 99.023, 91.653, 105.542, 97.021,
  108.947 ms;
- candidate: 122.689, 140.879, 122.293, 462.740, 133.305, 119.434,
  120.014 ms.

**Decision B: rejected at STOP B0.** The feasibility spike misses both stop
conditions, so the five isolated B2 trials were not entered. The granular
design-system subpaths, passive façade, and local disclosure are removed. The
final product uses the established Ark Popover and Tooltip with their single
portal/positioning implementation. The rejected spike bundle map is preserved
separately from the canonical final bundle map.

## Final bundle cartography

The final cartography explicitly records disjoint `initialChunkFileNames` and
`lazyChunkFileNames`; every lazy chunk has `isInitial: false`, and the overlap
test is empty. There are zero duplicated Ark/Zag modules.

| Final closure | Chunks | Raw | Gzip | Brotli |
| --- | ---: | ---: | ---: | ---: |
| Overview | 36 | 883,153 B | 275,879 B | 238,948 B |
| Sessions | 39 | 967,024 B | 301,470 B | 261,528 B |
| Breakdown | 37 | 912,341 B | 286,410 B | 248,115 B |
| Sessions after Drawer | 40 | 1,008,330 B | 314,642 B | 272,902 B |

## C — Direct destination SSR

The earlier C experiment remains valid because this review does not change
route prefetch or TanStack Query ownership. The no-prefetch trial produced
overlapping first-usable distributions and no stable improvement of at least
10%. It also introduced a browser Session RPC before first scroll. The existing
direct-destination prefetch is therefore preserved, with no new C optimization.

**Decision C: rejected; existing behavior retained.** Reconsider only with a
streaming design that improves first usable render without the measured
TTFB/HTML and refetch trade-offs.

## Boundary and byte terminology

`@ai-usage/usage-store/performance-testing` is a benchmark-only, server-only
façade. It is active only under `AI_USAGE_PERF=1`; production Web use is limited
to `apps/web/src/hooks.server.ts`, the client-manifest gate rejects it, and the
package-boundary tests reject every general Web consumer.

- **Code bytes:** raw generated client files in a closure.
- **Compressed code bytes:** deterministic gzip-9 or default Brotli over those
  exact files.
- **Transfer bytes:** serialized RPC or navigation response bodies.
- **Deployed artifact bytes:** files under
  `apps/web/.output-build/sveltekit/client`; they are not response bytes.

## Final exhaustive Session proof

The retained post-rejection artifact was measured with one warm-up followed by
three production samples. The fixture contains 5,000 sessions and 4,999
top-level campaigns. Every retained sample traverses exactly 25 desktop pages
and observes all 4,999 campaign identities without a campaign gap or duplicate.
The current executable scale and benchmark gates additionally expand the fixture
child and compute 5,000 unique session identities with zero missing or duplicate
identities.

| Metric | Control | Final | Delta |
| --- | ---: | ---: | ---: |
| Initial static closure gzip | 279,246 B | 275,879 B | -3,367 B |
| Initial hydration | 579.901 ms | 459.544 ms | -20.75% |
| Desktop full traversal | 4,654.428 ms | 3,528.125 ms | -24.20% |
| Mobile full traversal | 93.224 ms | 59.170 ms | -36.53% |
| Filter | 217.300 ms | 208.343 ms | -4.12% |
| Sort | 271.265 ms | 252.950 ms | -6.75% |
| Cumulative Session responses | 11,026,467 B | 11,026,467 B | 0 B |
| Maximum page | 441,050 B | 441,050 B | 0 B |

Raw control/final samples (the table above reports their medians) are:

| Metric | Control samples | Final samples |
| --- | --- | --- |
| Initial hydration | 579.901, 567.847, 624.196 ms | 459.544, 446.180, 461.457 ms |
| Desktop full traversal | 4,654.428, 4,185.914, 5,055.611 ms | 3,441.557, 3,698.990, 3,528.125 ms |
| Mobile full traversal | 68.272, 94.789, 93.224 ms | 62.541, 55.393, 59.170 ms |
| Filter | 214.000, 252.533, 217.300 ms | 226.069, 208.343, 138.872 ms |
| Sort | 233.741, 271.265, 326.097 ms | 252.950, 230.794, 260.729 ms |
| Cumulative Session responses | 11,026,467, 11,026,467, 11,026,467 B | 11,026,467, 11,026,467, 11,026,467 B |
| Maximum page | 441,050, 441,050, 441,050 B | 441,050, 441,050, 441,050 B |

The complete final validation is not claimed green. The exact review command
`git diff --check origin/main...HEAD` reads only the committed comparison and
therefore still reports the five Plan 070 trailing spaces present in the
starting HEAD. The repaired working tree passes `git diff --check` and
`git diff --check origin/main`, but making the triple-dot proof green requires
a commit, which was not authorized.

## Current artifact hashes

| Artifact | SHA-256 |
| --- | --- |
| `plan072-keyset-a1.json` | `e954a059333747f7d205a9461f61c0d9d657761383235439b061efdfa8156a99` |
| `plan072-control-bundle-map.json` | `5cc6f0e07a232b19ad15edbd83d58607d2057aeaa8ce8b2c339b803069b4d3b2` |
| `plan072-control-bundle-map.md` | `f6ff98ff82cd6b15ad5c5843f685e08967a383bb6998dcf5010b2f7f9b27ad3a` |
| `plan072-ark-control-7.json` | `59adc5f5bf0e7d24fb2f78a8e1b6e40b9a003248a729d340570c03ddb733b548` |
| `plan072-bundle-map-rejected-b.json` | `75b87401110a85ddd8636bf96115948f914bce386fb45674d4db5e57f23efa6f` |
| `plan072-bundle-map-rejected-b.md` | `bf78920eb817e7879c970db5258a235818cf0227f04d9fc5da44578613284bbf` |
| `plan072-destination-render.json` | `4b70563ca858c80c7bfadc9d358a7b9e1e59473e225a4269f45cdef56f296bd3` |
| `plan072-ark-split.json` | `4eb7831972b9198765e7029242c37b8b94f29e4a2461c61bb6626ddcfbd89e3a` |
| `plan072-bundle-map.json` | `51a21e8d7b0e864ee7b4c825343a99e7b56b211918a44dee85a9b86f6d36675c` |
| `plan072-bundle-map.md` | `8c296c5a24c781a24b353e5fa02d12e78d097730b9a512c3a64aa935335a35b0` |
| `plan072-final-control.json` | `47a940d4cf8f2942adbf7c1cba0e3e0ee33ca7fe6689e2f5546bd2bc5babea77` |
| `plan072-final.json` | `c96505d4c6d2150d51922565814180be4aacc4c441e4aea946dee932da2ee4cc` |

These hashes cover the corrected A evidence, both paired B builds, the rejected
B candidate, the final post-rejection cartography, and the final exhaustive
Session run.
