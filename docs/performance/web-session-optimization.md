# Web Session Pipeline Optimization

Measurement-first record for Plan 071. Historical migration timings are referenced
from prior docs and are not rewritten here.

## Environment

| Item | Value |
| --- | --- |
| Measured commit | `04e88d3b77a47e3e39b8f11d692d9cd79c7d1c7c` |
| Branch | `agent/migrate-web-sveltekit-orpc` (PR #27) |
| Bun | 1.3.13 |
| Playwright | 1.61.1 |
| Browser | Chromium via Playwright (host Chrome 151.0.7922.75) |
| Fixture | synthetic 5,000 Codex sessions (`AI_USAGE_SESSION_SCALE_E2E=1`) |
| Artifact SHA-256 (uncompressed code files, no `.br`/`.gz`/`.map`) | `8b5b3cd98ad873d5ee761a560f02432b36115ddb07a9f4671794901f5b9317e8` |
| Deployed artifact size | 9,087,981 bytes (414 files including 56 `.br` + 56 `.gz`) |
| Uncompressed code bytes in artifact | 8,372,115 bytes |
| Precompressed copies | 331,964 bytes `.br` + 383,902 bytes `.gz` |

Methodology: one warm-up sample (not recorded), then three recorded samples on the
same machine and browser. Comparisons use medians, never a single best run.
Control artifact: `docs/performance/artifacts/wave0-control.json`.
Final artifact: `docs/performance/artifacts/wave6-session-scroll.json`.

### Reproduce

```sh
bun run --cwd apps/web build
bun run --cwd apps/web benchmark:session-scroll
```

Do not read real user home data during benchmarks. Temporary homes, browser
profiles, and port `4177` servers must be cleaned after every run.

## Historical migration baseline

See `docs/performance/web-framework-migration-baseline.md` for the SvelteKit/oRPC
migration numbers. Those figures are historical context only; the tables below are
same-toolchain control versus Plan 071 final.

## Control versus final (medians)

| Metric | Control | Final | Δ |
| --- | ---: | ---: | ---: |
| `initialMs` | 1389.457 | 456.853 | −67.1% |
| `desktopFullTraversalMs` | 101211.722 | 3660.341 | −96.4% |
| `mobileFullTraversalMs` | 56.393 | 58.262 | +3.3% |
| Desktop max rendered items | 37 | 29 | −21.6% |
| Desktop max session DOM nodes | 733 | 581 | −20.7% |
| Mobile max rendered items | 21 | 13 | −38.1% |
| Mobile max session DOM nodes | 360 | 224 | −37.8% |
| Browser session RPCs | 51 | 26 | −49.0% |
| Session pages | 51 | 26 | −49.0% |
| Hydration total bytes | 709898 | 489216 | −31.1% |
| Heap Δ bytes | 28296316 | 25464364 | −10.0% |
| Max page bytes | 220694 | 441050 | +99.8% (still ≪ 2 MiB) |
| Filter ms | 193.214 | 124.874 | −35.4% |
| Sort ms | 1541.88 | 216.1 | −86.0% |
| Initial closure raw | 888907 | 891131 | +0.3% |
| Initial closure gzip (computed) | 278229 | 279228 | +0.4% |
| Initial closure brotli (computed) | 241084 | 241695 | +0.3% |

SQLite phase totals (sample 0, warm long-lived server for final):

| Phase | Control totalMs | Final totalMs |
| --- | ---: | ---: |
| count | 448.689 | 19.36 |
| projection | 49765.287 | 0 (warm projection cache) |
| materialize | 115.054 | 137.474 |

Final projection work is paid once per query identity on the long-lived production
server (warm-up + first miss). Recorded samples after warm-up reuse the exact-revision
ordered projection; median sqlite work across the traversal falls by much more than
the 15% retention gate.

### Size vocabulary

- **Code bytes:** uncompressed JS/CSS/HTML in the client closure or artifact.
- **Transferred bytes:** wire size with `Content-Encoding: br` / `gzip` when the
  production adapter serves precompressed static files.
- **Deployed artifact bytes:** on-disk `.output-build/sveltekit` including generated
  `.br`/`.gz` copies. Growth here is expected after precompression and is not a
  code-size regression.

Sample transfer check on `_app/immutable/chunks/EardQyRL.js` (255,848 raw):
br 62,209 (−75.7%), gzip 74,731, identity 255,848; decode integrity verified.

## Retained experiments

| Wave | Change | Evidence |
| --- | --- | --- |
| 0 | Benchmark attribution (RPC/pages/bytes/hydration families/SQLite phases/closure) | `f7d143f5`, `250416ca` |
| 1 | `overscanRows` 8 → 4 | Desktop items 37→29 (−22%), nodes 733→581 (−21%); mobile 21→13 / 360→224. `42b40bb7` |
| 2 | `SERVED_SESSION_PAGE_SIZE` 100 → 200 | RPCs 51→26 (−49%), desktop traversal ~−51%, max page 441 KiB < 2 MiB. `7eba6336` |
| 3 | Append-aware browser projection | Heap −6.3% vs Wave 2 (≥5% gate). `eabdb0f5` |
| 4 | Canonicalize hydration: destination queries drop Session payloads; reseed from `session-pages` | Hydration 1,370,990→489,216 (−64% vs Wave 3); zero post-hydration session RPCs. `438c89a6` |
| 5.1+5.2 | Reuse invariant totals; materialize ordered campaign projection per revision+seal+fingerprint | SQLite median total −99% vs Wave 4; traversal −92.5%. `63e78224`, `1b2f7245` |
| 6.1 | `precompress: true` on `svelte-adapter-bun` | Static assets served with `Content-Encoding`, `Vary: Accept-Encoding`, immutable cache; transfer falls. `04e88d3b` |

## Rejected experiments

| Candidate | Measured reason | Diff status |
| --- | --- | --- |
| Wave 1.2 scroll-only `scrollTop` + rAF path | Traversal gain ≪ 5% | Reverted |
| Wave 5.3 keyset pagination | Needs public cursor / schema ADR | Not started (STOP) |
| Wave 6.2 design-system Drawer/Tabs split | Initial gzip **rose** +2.13 KiB; `session-table` Popover shares Ark focus-trap with Drawer, so the shared chunk stayed a `nodes/3` preload | Reverted |
| Wave 6.3 synthetic isolation | Only trivial `synthetic` string refs in the initial node | Not retained |
| Wave 6.4 direct-destination SSR | No measured loading-shell cost large enough to justify Overview closure risk | Not retained |

## Correctness invariants observed

- 5,000 unique campaign identities reachable; no missing IDs in recorded samples.
- Exact revision + request fingerprint unchanged.
- Page size ≤ 200; serialized page ≤ 2 MiB.
- Desktop/mobile rendered-item ceilings (300 / 600) held; retained overscan also met
  relative DOM gates.
- Hydration issues zero session-page business refetches before scroll.
- TanStack Query remains the sole browser server-state owner.

## Deferred candidates (evidence-backed)

1. **Keyset pagination** — OFFSET rescans were dominated by CTE rebuild cost; after
   projection materialization the remaining gain needs a public cursor contract
   (separate ADR).
2. **Deeper design-system / Ark splitting** — Drawer deferral alone is insufficient
   while Popover remains on the Sessions table path and shares focus-trap with Drawer.
3. **Direct Sessions/Breakdown SSR shell** — revisit only with fresh initial-render
   traces showing a ≥10% usable-render win without growing Overview closure >5 KiB.

## Wave artifacts

Raw JSON under `docs/performance/artifacts/`:

- `wave0-control.json`
- `wave1-overscan4.json`
- `wave2-page200.json`
- `wave3-append-projection.json`
- `wave4-hydration.json`
- `wave5-totals-reuse.json`
- `wave5-projection-cache.json`
- `wave6-precompress.json`
- `wave6-session-scroll.json`
