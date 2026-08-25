# ADR 0018: One canonical number per concept

- **Status**: Accepted
- **Date**: 2026-08-25 (records the rule settled by plan 088, merged in the
  086 program on 2026-08-25)

## Context

The 2026-08-23 fresh-eyes audit found the same concept reported with different
values on different surfaces: Overview and breakdown disagreed on API value by
harness (partial lower bounds dropped on one side), `/sync` summed stored rows
where the report counts reportable sessions, and a campaign root opened a drawer
that aggregated its children twice. Each surface had derived its own
aggregation.

## Decision

Each measurable concept has exactly one canonical aggregation, defined once in
`report-core` and mirrored byte-for-byte by the SQLite projection; every
surface reuses it. Where two legitimately different concepts share a label, the
label changes, not the number: `/sync` names its figure as stored rows instead
of pretending it is the session count.

Aggregation asymmetries are bugs, not presentation choices: if the Overview
keeps partial lower bounds, breakdown groups keep them too. Parity between the
pure and SQLite engines is pinned by tests.

## Consequences

- A new surface may not derive its own sum, share, or duration; it consumes the
  canonical query result.
- Cross-surface value equality is asserted in e2e coverage; a mismatch fails
  the gate rather than shipping as a "different view".
- Renaming a figure is the accepted resolution when two concepts genuinely
  differ.

## Rejected alternative

Documenting the per-surface differences was rejected: a reader comparing two
screens has no reason to suspect the same words mean different aggregations.

## Evidence

- [Plan 088](../../plans/088-one-canonical-number-per-concept.md)
- [Canonical focused query](../../packages/report-core/src/focused-report-query.ts)
