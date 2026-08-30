# ADR 0023: One product with local and shared compositions

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

ai-usage is a complete local product with deliberate SQLite, process, privacy,
and browser boundaries. Cross-device Memory and continuity need a shared
runtime, but making the current product a thin client would remove its offline
value and couple collection to account and network availability.

## Decision

Keep one monorepo and one product with two explicit runtime compositions:

- local/offline composes Usage, Skills, DB-native Memory, FTS5 search, MCP, and
  Work handoffs without an account, login, network, server, or PostgreSQL;
- connected mode adds a shared server application, PostgreSQL authority,
  organization authorization, replication, shared search and Work handoffs,
  and opt-in normalized session archives;
- both modes use the same domain and application-service contracts where they
  implement the same capability;
- the server never reads machine-local harness files, and local collection
  never waits for the connected composition.

Implementation remains dependency-ordered by plans 100–110. Recording the
composition does not make an unimplemented connected capability available.

## Consequences

- Offline behavior is a product gate, not a degraded cache mode.
- Shared features can add tenant and authorization requirements without
  leaking them into local collection.
- One codebase must keep transport, storage, and composition adapters explicit.

## Rejected alternative

A server-required thin client was rejected because login, network, or server
failure would disable local collection, Memory, search, and continuity.

## Reversal condition

Reconsider one product only if release, legal, or isolation requirements force
independently governed products and a reviewed migration can preserve the
offline contracts without introducing a hidden network dependency.

## Evidence

- [Platform topology](../architecture.md#accepted-platform-topology)
- [Program plan](../../plans/099-ai-operations-memory-platform-program.md)
- [Plan 100](../../plans/100-platform-topology-capabilities-data-ownership.md)
