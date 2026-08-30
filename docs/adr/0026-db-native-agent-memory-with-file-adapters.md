# ADR 0026: DB-native Agent Memory with file adapters

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

The existing NixOS Agent Memory uses Markdown/JSONL and a monolithic tool as
its durable implementation. The platform needs atomic proposals, acceptance,
immutable revisions, relations, search projections, authorization, and
replication in local and connected modes without creating two mutation paths.

## Decision

Agent Memory is database-authoritative in both modes: dedicated SQLite locally
and PostgreSQL for published/shared Memory. Both adapters implement the same
domain and application-service contracts.

The domain separates immutable Memory observations, reviewable proposals,
stable accepted items, and immutable revisions. Generated or harvested content
cannot become accepted guidance without Person review. Revision changes append
and atomically advance a current pointer; exact history remains addressable.

The NixOS implementation is the pinned migration source and temporary
compatibility implementation until parity is demonstrated. Markdown, JSONL,
and `.agent-memory/` then remain import, export, projection, and working-note
surfaces only. They never become a second mutation authority.

## Consequences

- Local Memory remains available without PostgreSQL, an account, or a network.
- Imports require idempotency, provenance, trust, and legacy-semantic tests.
- File-friendly workflows remain possible without weakening transactions or
  authorization.

## Rejected alternative

Keeping files canonical and mirroring them into databases was rejected because
conflict resolution, acceptance, revision pointers, and replication would have
two competing mutation authorities.

## Reversal condition

Reconsider database authority only if a portable file engine can prove the same
atomic revision, authorization, relation, indexing, concurrent-writer, and
replication guarantees through the full conformance suite in both modes.

## Evidence

- [Memory language](../../CONTEXT.md#ai-usage-context)
- [Platform data ownership](../architecture.md#platform-data-ownership)
- [Plan 105](../../plans/105-db-native-agent-memory.md)
