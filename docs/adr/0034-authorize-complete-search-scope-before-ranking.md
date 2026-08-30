# ADR 0034: Authorize the complete search scope before ranking

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

Memory and WorkHandoff search can leak forbidden content even when returned rows
are filtered: unauthorized candidates may alter counts, snippets, cursors,
rank, IDF/statistics, trigram thresholds, or semantic scores. An arbitrary
pre-ranking authorization cap can also hide allowed results and make absence
claims false.

## Decision

Materialize the complete authorized candidate relation for the principal,
permission, and active Space before lexical or semantic ranking. The search
query joins against that relation and only then applies PostgreSQL FTS/
`pg_trgm`, SQLite FTS5, result limits, and cursors.

Pagination limits returned results, never the authorization graph. There is no
application-side post-filter and no arbitrary scope cap. If complete authorized
scope cannot be represented within documented query/time bounds, search fails
closed.

Local and shared search use one evaluation corpus and result contract. Lexical
search lands first; `pgvector` remains gated by measured semantic-recall
failure. Any future external authorization adapter must materialize all pages
into a relation the ranking query can join under documented consistency.

## Consequences

- Forbidden content has no influence on observable search behavior.
- Absence and ranking semantics remain explainable and testable.
- Authorization-listing performance becomes a first-class benchmark and may
  cause a closed failure rather than a partial answer.

## Rejected alternative

Ranking a broad corpus and filtering the top results afterward was rejected
because forbidden documents would affect ordering, statistics, snippets, and
whether authorized results are reachable.

## Reversal condition

Change this order only if a formally equivalent algorithm proves through the
shared leakage/evaluation corpus that forbidden candidates influence no output,
metadata, score, cursor, timing class, or absence verdict.

## Evidence

- [Authorizer decision](0029-application-owned-authorizer.md)
- [Plan 103](../../plans/103-rebac-authorization-content-boundaries.md)
- [Plan 106](../../plans/106-authorized-memory-search-mcp.md)
