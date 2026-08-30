# ADR 0027: MCP is an edge adapter

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

Claude, Codex, OpenCode, Cursor, and future clients need a harness-neutral way
to retrieve Memory and continuation context. Using MCP as the platform's
internal bus or storage abstraction would couple domain behavior to one edge
protocol and tempt tools to own authorization or persistence.

## Decision

MCP is an edge adapter over application services. Its adapter owns MCP protocol
schemas, bounded serialization, principal-context conversion, cancellation,
sanitized errors, and safe registration. It does not own storage, ranking,
permission policy, Memory acceptance, WorkHandoff generation, or harness
parsing.

Local MCP calls local application services and works without a shared server,
account, network, or PostgreSQL. Connected MCP calls the same domain services
through an authenticated, authorized composition. MCP tools never open
write-capable SQLite/PostgreSQL connections and never become the internal
service-to-service bus.

Registration follows the existing identity-checked, cooperating-process Skills
projection discipline and does not overwrite unmanaged runtime entries.

## Consequences

- Domain behavior and tests are transport-independent.
- Other edges such as oRPC, CLI, and jobs reuse services instead of reusing MCP
  handlers.
- MCP-specific limits and failures stay explicit at the edge.

## Rejected alternative

Using MCP as the internal application bus was rejected because domain services,
jobs, and storage adapters would inherit a harness-facing transport contract.

## Reversal condition

If two or more edge protocols duplicate bounded transport concerns, extract a
protocol-neutral edge toolkit only after measuring the duplication; application
services and authorization still remain below every adapter.

## Evidence

- [Application-service architecture](../architecture.md#application-services-and-trusted-capabilities)
- [Plan 106](../../plans/106-authorized-memory-search-mcp.md)
