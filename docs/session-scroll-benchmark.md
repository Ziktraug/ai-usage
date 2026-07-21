# 5,000-session scroll benchmark

Measured on 2026-07-21 with deterministic synthetic Codex fixtures only. The
production build ran on Linux x86_64 with Playwright 1.61.1 and Google Chrome
150.0.7871.124. Each result below is the median after one warmup and three
recorded runs at 1024 × 900 (desktop) and 390 × 844 (mobile).

## Decision

The bounded-paging branch of Plan 031 is required. A 5,000-row full query
violates the existing 200-row response limit even though heap and interaction
timings pass. The previous mobile list also exceeded the 600-card DOM bound and
its sentinel did not observe the list's real scroll root.

The implementation therefore keeps 100-row server pages, assigns generation,
cancellation, deduplication, and ordering to one query coordinator, retains the
desktop window, and adds a fixed 188 px mobile window. The mobile sentinel now
lives in and observes the scrolling list. Scroll anchoring is disabled on that
virtualized surface so an appended page cannot skip rows.

## Comparable results

| Signal | Before | After | Plan condition |
| --- | ---: | ---: | --- |
| Desktop maximum rendered rows | 32 | 32 | ≤ 300 |
| Desktop session DOM descendants | 670 | 670 | diagnostic |
| Mobile maximum rendered cards | 5,000 | 20 | ≤ 600 |
| Mobile session DOM descendants | 70,000 | 283 | diagnostic |
| Maximum serialized page | 267,005 B | 267,001 B | ≤ 2 MiB and ≤ 200 rows |
| Chromium heap delta | 26,598,508 B | 28,563,604 B | ≤ 100 MiB |
| Initial render | 408.786 ms | 420.849 ms | ≤ 1.5 s, diagnostic |
| Sort interaction | 223.558 ms | 308.794 ms | ≤ 1.5 s, diagnostic |
| Filter interaction | 192.327 ms | 177.116 ms | ≤ 1.5 s, diagnostic |
| Initial gzip closure | 251,597 B | 252,255 B | ≤ 276,757 B |

Before the fix, the real mobile scroll root stopped after the first 100 rows;
the 5,000-card before measurement used the benchmark's temporary legacy
sentinel activation only to quantify the unbounded DOM. After the fix, the
permanent production-mode test reaches stable indexes 0 through 4,999 exactly
once on both viewports, compares their ordered ID sequence, revisits both ends,
and enforces the row, DOM, and response-byte bounds.

## Reproduction

Build first with `bun run build`. Run the hard correctness gates with
`bun run --cwd apps/web test:e2e-production`; run the diagnostic timing and heap
samples with `bun run --cwd apps/web benchmark:session-scroll`. Timing and heap
figures are local evidence, not cross-machine CI thresholds.
