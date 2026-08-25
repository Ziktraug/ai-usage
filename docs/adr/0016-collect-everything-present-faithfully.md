# ADR 0016: Collect everything, present partial data faithfully

- **Status**: Accepted
- **Date**: 2026-08-25 (records the standing rules locked by plans 053, 059,
  and 064)

## Context

Harness histories are heterogeneous: Cursor exposes partial counters, some
sessions carry no usage data, reconciliation can be ambiguous, and imported
snapshots carry opaque provenance. A collector that filtered "bad" data would
hide real work; a presenter that merged or rewrote artefacts would fabricate
data it does not have.

## Decision

Collection stores everything it can observe. Columns are knowingly partial, and
the consumer presents that faithfully:

- presentation may classify and explain artefacts (filename-like projects,
  worktree-like basenames, missing usage), but must never delete, merge, or
  rewrite collected rows;
- data limitations are carried per metric, at the surface where the metric
  appears — never as one global "data quality" flag;
- partial aggregates present as explicit lower bounds rather than being dropped
  or silently completed.

## Consequences

- A confusing raw value gets an explanation affordance, not a transformation.
- Automated render assertions are authoritative for what a surface claims.
- Harness asymmetries (for example Claude Code's missing cross-session parent
  pointer) surface as per-metric limitations instead of pretended parity.

## Rejected alternative

A global completeness badge was rejected because it punishes every metric for
the weakest source and tells the reader nothing actionable about any specific
number.

## Evidence

- [Plan 064 — label data quality without dropping data](../../plans/064-label-data-quality-without-dropping-data.md)
- [Plan 053 — honest line measurements](../../plans/053-make-line-measurements-honest.md)
- [Session analysis source qualities](../session-analysis-sources.md)
