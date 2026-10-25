# ADR 0020: A bundle ceiling and a drift guard, not a per-feature ledger

- **Status**: Accepted
- **Date**: 2026-08-25 (records the decision merged as PR #41, commit
  `fb5b0048`, 2026-08-23); amended 2026-10-24 (ceiling restated with a
  headroom expectation)

## Context

The former `css-bundle.test.ts` guarded the report's initial gzip closure with
21 hand-measured per-feature budget constants under a blanket 10% headroom. The
headroom allowed nearly twice the drift of the entire hand-justified ledger,
seven lines were below build nondeterminism, and across twelve commits the
answer to "over budget" was always another ledger line. The ceremony had become
a changelog with an assert attached, and the closure sat 349 B under its own
arithmetic.

## Decision

Two numbers with distinct jobs guard the emitted client bundle:

- a round **305 000 B ceiling** that states what the report should cost to
  open (300 000 B when this record was written; raised on 2026-10-20 by
  PR #63, `feff2229`; see the 2026-10-24 amendment);
- a **2% drift guard** against the last recorded measurement, which catches
  the regression a ceiling cannot — a dynamic import turning eager lands in
  kilobytes and can happen with headroom to spare.

Growth stays deliberate: it moves one number, and the reasoning lives in the
commit that moves it. The guard reads the CI build output instead of producing
a second build.

Bundle weight is reduced through configuration fixes or different primitives,
never through per-component `import()` splitting of the design system: lazy
imports trade a measured eager cost for waterfall latency and were measured to
regress (+2.13 KiB gzip for the naive Ark split, plan 071).

### 2026-10-24 amendment: the ceiling and its headroom

The ceiling is a product statement, not a running total: opening the report
costs at most 305,000 B of gzip-compressed client code and CSS (the SvelteKit
client runtime, the app entry and the report route's layouts and page nodes,
gzipped per asset and summed, as `apps/web/bundle/client-bundle.test.ts`
measures it). It does not follow the last measurement upward.

**Headroom expectation.** The recorded measurement should sit at least one
drift tolerance below the ceiling, 2 % or about 6.1 KB at today's recording, so
that an ordinary change meets the drift guard before it meets the ceiling.
While headroom is below that, the next change that grows the closure first
recovers headroom through configuration or different primitives, as above.
Raising the ceiling is a product decision: it is recorded here as an
amendment that names the measured cost and what the extra bytes buy. A
dependency upgrade's growth counts like a feature's.

**State on 2026-10-24.** The recorded closure is 304,465 B, 535 B under the
ceiling and below the expectation. The ceiling was raised to 305,000 B on
2026-10-20 with a 301,473 B recording; plan 119's framework upgrades then took
most of the remaining room (over a 298,131 B build after the in-major bumps,
SvelteKit 3 alone added 4,381 B and Panda 2 alone 1,664 B). The next change
that grows the closure therefore starts by recovering headroom.

## Consequences

- No per-feature byte accounting returns without revisiting this ADR.
- The drift baseline updates only alongside the change that moves it.

## Evidence

- [Bundle guard](../../apps/web/bundle/client-bundle.test.ts)
- [Plan 072 evaluation](../../plans/072-evaluate-deferred-web-session-optimizations.md)
- [Deferred optimizations record](../performance/web-session-deferred-optimizations.md)
