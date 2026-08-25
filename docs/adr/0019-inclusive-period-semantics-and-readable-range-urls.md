# ADR 0019: Inclusive period semantics and readable range URLs

- **Status**: Accepted
- **Date**: 2026-08-25 (records the semantics settled by plan 089, merged in
  the 086 program on 2026-08-25)

## Context

Period arithmetic disagreed across surfaces: day counts were sometimes
exclusive, campaign date ranges could claim days outside their sessions, the
timeline interval did not adapt to the selected span, and range URLs encoded
state a human could not read or edit.

## Decision

- A period of `[start, end]` calendar days counts both endpoints: Mon–Wed is
  three days everywhere a day count appears.
- Campaign dates derive from their member sessions; a campaign never claims
  activity on days its sessions do not cover.
- The timeline interval (day/week/month) derives automatically from the
  selected span; the reader does not pick an interval that renders one bar.
- Range state lives in the URL as readable calendar dates. Open-ended ranges
  are valid with either bound missing, and both open directions order
  correctly against complete ranges.
- The three engines that evaluate periods (pure model, SQLite projection,
  browser range model) are kept in parity by tests; a semantics change lands in
  all three or not at all.

## Consequences

- Copy such as "12 days" is computable from the URL by a human.
- Shared links reproduce the exact period without a decoding step.
- Any new period-aware surface consumes the shared range model instead of
  re-deriving bounds.

## Rejected alternative

Treating day-count style per surface ("some views are exclusive, it's
documented") was rejected for the same reason as ADR 0018: identical words must
mean identical arithmetic.

## Evidence

- [Plan 089](../../plans/089-period-semantics-and-range-urls.md)
- [Range model](../../apps/web/src/lib/features/report/range/report-range-model.ts)
