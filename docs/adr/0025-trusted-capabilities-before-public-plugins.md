# ADR 0025: Trusted capabilities before public plugins

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

The platform direction introduces Usage, Sources, Skills, replication, Memory,
Work handoffs, and organization governance. A speculative plugin system would
add third-party code loading, versioning, permission, migration, and isolation
contracts before there is more than one product composition that needs them.

## Decision

Build trusted internal capability modules inside the monorepo before designing
a public plugin SDK. Capabilities may contribute routes, local/server jobs, MCP
tools, navigation, and permission requirements through reviewed composition.
They share one ordered migration history and never load arbitrary user code into
trusted processes.

The conceptual capability IDs are `usage`, `sources`, `skills`, `replication`,
`memory`, `work-handoff`, and `organization-governance`. Do not implement a
generic registry until two real consumers would otherwise duplicate
composition logic. Disabled means no navigation, public route, tool, or job
execution and a typed capability-disabled command result; it does not skip
migrations or delete historical data.

Only real packages are registered in the TypeScript project list, dependency
boundaries, and public exports. Architecture diagrams do not justify empty
packages.

## Consequences

- Capability seams deepen around actual application services instead of a
  premature extension API.
- All executable code remains reviewed with the product and its migration
  sequence.
- A future public SDK must solve isolation and compatibility explicitly.

## Rejected alternative

A generic runtime plugin registry now was rejected because it would turn
unproven composition needs into a security- and compatibility-sensitive public
contract.

## Reversal condition

Reconsider a public SDK only after independent third-party capability demand is
demonstrated and a proposal specifies sandboxing, signatures/provenance,
permissions, version negotiation, migration ownership, revocation, and failure
isolation.

## Evidence

- [Trusted capability architecture](../architecture.md#application-services-and-trusted-capabilities)
- [Plan 100](../../plans/100-platform-topology-capabilities-data-ownership.md)
