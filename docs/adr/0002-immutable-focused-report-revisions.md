# ADR 0002: Read immutable focused report revisions

## Context

A large report cannot be fetched and recomputed atomically in the browser while collection may publish a replacement.

## Decision

The served app bootstraps bounded support metadata, then requests Overview,
Breakdown, or paged Sessions against one named immutable revision. One composite
TanStack Query destination coordinates refresh, expiry recovery, supersession, and atomic publication.

### Plan 066 amendment

[ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
supersedes only the artifact transport: immutable projection content now lives
under revision keys in durable SQLite and Web queries it read-only/query-only.
Copied revision databases, filesystem leases, and Bun query runners are
removed. The named-revision browser lifecycle and consistency decision remain
unchanged; unchanged current metadata may be renewed without rewriting
projection content.

## Consequences

Every visible destination is internally consistent. Publication refreshes the active destination instead of mixing results from different revisions.

## Rejected alternative

A monolithic payload was rejected because its cost grows with history and it cannot preserve exact-revision paging cleanly.

## Evidence

- [Composite report destination](../../apps/web/src/lib/query/options/report-destination.ts)
- [Exact Session window](../../apps/web/src/lib/query/options/session-window.ts)
- [Query lifecycle coverage](../../apps/web/src/lib/features/report/composition/report-destination.test.ts)
- [Production protocol coverage](../../apps/web/e2e/production-report.spec.ts)
