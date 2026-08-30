# ADR 0024: Separate usage, Memory, and shared data authorities

- **Status**: Accepted
- **Date**: 2026-08-29
- **Amends**: [ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
  only by limiting its database and direct-reader clauses to the existing usage
  SQLite data plane

## Context

ADR 0009 gives the usage engine sole write ownership of the usage SQLite
database while Web and CLI query it directly through read-only connections.
Agent Memory and Work handoffs need different lifecycle, schema, search, and
replication semantics, and connected shared state needs tenant-aware
PostgreSQL. Folding those concerns into the usage database or replacing local
SQLite with PostgreSQL would blur authority and weaken offline operation.

## Decision

Use three explicit durable authorities:

- the existing usage SQLite database remains the usage data plane;
- a dedicated Memory SQLite database owns local Memory, Work Threads, Work
  handoffs, local FTS5 projections, and its outbox;
- PostgreSQL owns connected identity, authorization, published/shared Memory,
  shared search, Work handoffs, replication projections, and opt-in archives.

`apps/usage-engine` remains the only production usage SQLite writer and may
compose the sole Memory SQLite writer by default. The databases retain separate
transactions, schemas, and backup meaning. Web, CLI, and MCP do not open
independent write-capable connections; they use readers or application services
appropriate to each authority. The shared server has one PostgreSQL write
composition root.

Markdown and JSONL are Memory import/export/projection formats. A replicated
server projection is not authority over its source harness file or unpublished
local Memory, and no logical row has two mutation authorities.

## Consequences

- ADR 0009's direct read-only usage path and report-less control plane remain
  unchanged.
- Memory can evolve and replicate without coupling report migrations to its
  schema.
- Backup, recovery, locks, and availability must name the exact database.

## Rejected alternative

One combined local SQLite database was rejected because it would couple two
write domains and make report readers, Memory services, migrations, and backup
claims share authority they do not need.

## Reversal condition

A separate Memory process may replace default in-process composition only when
a measured lifecycle requirement is documented with concrete lock, startup,
shutdown, recovery, authentication, and IPC ownership in a new ADR.

## Evidence

- [Platform data ownership](../architecture.md#platform-data-ownership)
- [ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
- [Plan 100](../../plans/100-platform-topology-capabilities-data-ownership.md)
