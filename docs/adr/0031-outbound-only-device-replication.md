# ADR 0031: Outbound-only Device replication

- **Status**: Superseded on 2026-10-24: the connected platform is deleted (plan 120)
- **Superseded by**: [ADR 0074](0074-local-only-single-operator-product.md)
- **Date**: 2026-08-29

> The replication code outlives this decision until plan 120 phase B, which
> runs after PR #67 lands: the dormant client, both stores' outbox writers and
> the `replication-status` command are then removed, and the usage store's
> outbox tables are dropped by a forward-only schema change after a backup
> (ADR 0074, [ADR 0075](0075-local-store-schema-evolution.md)). Manual merge
> bundles, which this record kept as a fallback, are the only cross-machine
> path.

## Context

Connected mode needs durable publication from usage and Memory SQLite stores to
the shared server while Devices may be offline. Inbound listeners, peer
discovery, or LAN synchronization would expand the local attack surface and
conflict with the existing explicit-file transfer boundary.

## Decision

Every replication connection is initiated by the Device over authenticated
outbound HTTPS. Devices expose no inbound replication port and perform no LAN
or peer discovery.

Each local authority writes an outbox event atomically with the fact or exact
revision it publishes. Transport is at-least-once and server application is
idempotent. A monotonic generation is scoped to Device and stream; ACK advances
only after PostgreSQL projections, event receipts, and generation state commit.
Logical `fact_key`, publication `event_id`, and exact-version `content_hash`
remain separate identities. Enrichment or correction creates a new event;
acknowledged history is not rewritten.

Replication never blocks local collection, Memory, search, MCP, or local Work
handoffs. Manual merge bundles remain an explicit bootstrap, recovery, and
air-gapped fallback.

## Consequences

- Offline work queues durably and resumes without exposing the machine.
- Retry, correction, deletion, and provenance remain observable rather than
  inferred from absence.
- Near-real-time connected updates depend on client cadence and backoff.

## Rejected alternative

Peer-to-peer or server-initiated Device connections were rejected because they
require discovery, inbound reachability, and a larger local authorization and
network-hardening surface.

## Reversal condition

Reconsider transport only if a measured product SLO cannot be met by bounded
outbound polling/streaming and a proposal preserves explicit Device consent,
credential scoping, offline independence, no arbitrary command/file access, and
the complete idempotency protocol.

## Evidence

- [Connected topology](../architecture.md#connectedshared-composition)
- [Plan 107](../../plans/107-device-outbox-replication.md)
