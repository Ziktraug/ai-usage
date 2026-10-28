# ADR 0027: MCP is an edge adapter

- **Status**: Accepted; amended by
  [ADR 0074](0074-local-only-single-operator-product.md) and [ADR 0084](0084-retire-memory-checkout-resolution-and-replication.md)
- **Date**: 2026-08-29
- **Amended by**: [ADR 0074](0074-local-only-single-operator-product.md),
  [ADR 0084](0084-retire-memory-checkout-resolution-and-replication.md)

> Amended 2026-10-27 (ADR 0084): the `memory.*` tools are removed with accepted
> Memory. The local stdio server serves `work.context` (ADR 0058) and the
> delegation tools (ADR 0077); the edge rule below is unchanged. The registered
> server name stays `ai-usage-memory` for existing operator configurations.

> Amended 2026-10-24 (ADR 0074): the connected-MCP clause ("Connected MCP calls
> the same domain services through an authenticated, authorized composition")
> is removed from the Decision; there is only the local stdio server. The edge
> rule stands independently of Memory: PR #67 adds the read-only `work.context`
> tool (ADR 0058 on `feat/work-resume-cockpit`), and when plan 120 phase B
> removes the `memory.*` tools, MCP stays for it.

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
account, network, or PostgreSQL. MCP tools never open write-capable SQLite
connections and never become the internal service-to-service bus.

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
