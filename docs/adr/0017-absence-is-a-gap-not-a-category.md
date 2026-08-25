# ADR 0017: Absence is a gap, not a category, and defaults never hide it

- **Status**: Accepted
- **Date**: 2026-08-25 (records the invariant established by plans 048 and 049,
  implemented 2026-07-27)

## Context

Plan 045's origin dimension initially shipped with a filter default that
excluded sessions whose origin was undeclared. Multi-harness visibility dropped
silently: the data existed, the default hid it. Plan 048 restored visibility by
configuration; plan 049 removed the root cause.

## Decision

Two coupled rules:

- **A filter default must never exclude a value that exists only because the
  underlying data is incomplete.** Defaults may express preference among
  declared values, never subtract undeclared ones.
- **When a classification was not declared, the row carries no classification
  at all.** Absence is unfilterable by construction and is explained through
  per-metric provenance (which collector could not declare it), not modeled as
  an `unknown` enum member that a filter could exclude again.

## Consequences

- Regressions of this kind become structurally impossible instead of being one
  configuration edit away.
- New dimensions must decide at design time what absence means and how its
  reason is surfaced.
- The report can say *why* a session is unclassified, which points at the
  collector to improve.

## Rejected alternative

Keeping `unknown` in the default filter set (plan 048's transitional fix) was
rejected as the end state because configuration can be narrowed again by
anyone; the invariant must hold by construction.

## Evidence

- [Plan 049 — make undeclared origin a gap](../../plans/049-make-undeclared-origin-a-gap-not-a-category.md)
- [Plan 048 — restore multi-harness visibility](../../plans/048-restore-multi-harness-visibility.md)
- [Filter bar](../../apps/web/src/lib/features/report/breakdown/filter-bar.svelte)
