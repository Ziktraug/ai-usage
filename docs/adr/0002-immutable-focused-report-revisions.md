# ADR 0002: Read immutable focused report revisions

## Context

A large report cannot be fetched and recomputed atomically in the browser while collection may publish a replacement.

## Decision

The served app bootstraps bounded support metadata, then requests Overview, Breakdown, or paged Sessions against one named immutable revision. One dashboard lifecycle coordinates destination refresh, expiry recovery, supersession, and atomic commit.

## Consequences

Every visible destination is internally consistent. Publication refreshes the active destination instead of mixing results from different revisions.

## Rejected alternative

A monolithic payload was rejected because its cost grows with history and it cannot preserve exact-revision paging cleanly.

## Evidence

- [Dashboard lifecycle](../../apps/web/src/dashboard-report-lifecycle.ts)
- [Served report session](../../apps/web/src/dashboard-served-report-session.ts)
- [Coordinator regression coverage](../../apps/web/src/served-report-session.test.ts)
- [Production protocol coverage](../../apps/web/e2e/production-report.spec.ts)
