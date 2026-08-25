# ADR 0015: The API value is a legibility proxy, not a money claim

- **Status**: Accepted
- **Date**: 2026-08-25 (records a standing product decision applied since the
  2026-07 dashboard work)

## Context

The dashboard's central figure is a dollar value computed from token counts at
published API rates. Operators pay subscriptions, mix professional and personal
use, and feed the report with knowingly lossy data, so this figure cannot be an
accounting statement. Its actual job is to make work volume legible: "if I had
to pay API rates for this, how impossible would it be."

## Decision

Frame every API-value surface around volume legibility, never around savings,
return on investment, or break-even. The leverage framing is the emotional hook
of the product and stays imprecise by construction; the product must not
over-emphasize it or build on it.

Recap and sharing surfaces keep the same framing: a period recap celebrates
volume at API rates, it does not compute what the operator "saved".

## Consequences

- No ROI, break-even, subscription-comparison, or cost-optimization feature is
  accepted without revisiting this ADR.
- Copy says "API value", never "cost", "spend", or "savings", for locally
  derived dollar figures.
- Partial token data lowers the figure honestly; the value presents as a lower
  bound where provenance is incomplete (see ADR 0016).

## Rejected alternative

A subscription-cost input plus a savings calculator was rejected: the data mixes
usage contexts and drops unknown token counts, so any savings figure would be
false precision presented as an answer.

## Evidence

- [Analytics value derivation](../../packages/report-core/src/analytics.ts)
- [Future-work guardrails](../future-work.md)
