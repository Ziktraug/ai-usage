# ADR 0020: A bundle ceiling and a drift guard, not a per-feature ledger

- **Status**: Accepted
- **Date**: 2026-08-25 (records the decision merged as PR #41, commit
  `fb5b0048`, 2026-08-23)

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

- a round **300 000 B ceiling** that states what the report should cost to
  open;
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

## Consequences

- No per-feature byte accounting returns without revisiting this ADR.
- The drift baseline updates only alongside the change that moves it.

## Evidence

- [Bundle guard](../../apps/web/bundle/client-bundle.test.ts)
- [Plan 072 evaluation](../../plans/072-evaluate-deferred-web-session-optimizations.md)
- [Deferred optimizations record](../performance/web-session-deferred-optimizations.md)
