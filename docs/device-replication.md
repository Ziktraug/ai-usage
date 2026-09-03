# Device replication

> **Implementation status:** Accepted target specification. The replication
> runtime, protocol packages, routes, commands, and verification evidence below
> are pending integration and are not available on `main`; plan 107 remains
> `IN PROGRESS` with additional done criteria still open.

Device replication will publish selected local facts to the connected platform.
It is an asynchronous publication path, not a remote-control channel and not a
replacement for either local SQLite authority.

## Runtime topology

The supervised usage engine owns both local write authorities and the outbound
worker:

```text
usage SQLite authority  -> usage-v1 outbox  --+
                                               +-> outbound HTTPS -> apps/server -> PostgreSQL
Memory SQLite authority -> memory-v1 outbox --+
```

No replication listener, peer discovery, LAN protocol, server callback, file
fetch, or remote command endpoint exists. The existing usage control and Memory
service listeners remain authenticated numeric-loopback surfaces with their own
contracts; replication does not use them.

Local mode does not construct the connector. Connected publication is enabled
only when `AI_USAGE_PLATFORM_BASE_URL` is present. The usage engine then loads
the owner-only Device credential from `device-credential.json` below its owned
state directory. HTTPS is mandatory except for an explicitly permitted
loopback HTTP origin in non-production execution. A missing/unsafe credential,
invalid endpoint, revoked Device, or unavailable server produces only a bounded
content-free replication diagnostic and a later retry; engine startup,
collection, Memory, search, MCP, and local reads continue.

The worker is started after the usage writer lease, Memory kernel, and local
Memory service. Shutdown aborts an active outbound request and waits for the
worker before closing the Memory service, Memory database, or usage writer.

## Explicit publication identity

The local bootstrap Person, Space, and Device are offline identities. They are
never presented as shared identities. After the Device credential is verified,
the server returns its explicit shared Device, owner Person, and owning Space.
The local Memory database records a publication-context mapping from the local
Space/Project to that shared Capture Context. No Space is inferred from a path,
remote, SCM installation, or local Device row.

The initial runtime uses one deterministic personal-fallback Capture Context
with no Project. Project-scoped Memory remains local until an explicit shared
Project mapping exists. Usage publication omits raw local paths and assigns the
same explicit personal context. The server may create an absent Capture Context
row only from the complete authenticated snapshot in the request, in the same
transaction that rechecks the active credential, Device owner, Space, optional
Project, and SCM bindings.

## Protocol identities and payload policy

`@ai-usage/replication-protocol` is a strict, IO-free version-1 contract. Every
publication keeps three identities separate:

- `fact_key` is the stable logical projection key;
- `event_id` identifies one immutable publication version and remains stable
  across its retries;
- `content_hash` identifies the exact canonical payload version.

A correction or enrichment retains `fact_key` but creates a new `event_id` and
`content_hash`. An exact retry retains all three. Supersession, a privacy purge,
or a change from normal to sensitive Memory creates an explicit tombstone; the
server never infers deletion from absence.

The closed V1 payload union contains normalized Device and usage-session facts
plus policy-selected normal Memory facts and tombstones. It has no generic
blob, prompt, tool output, raw transcript, SQLite row/database, local path,
native session archive, WorkHandoff, or arbitrary file payload. Work handoffs
and archives remain separate later contracts.

## Local outboxes and recovery

Each SQLite authority has its own `replication_outbox_state` and
`replication_outbox_events` tables. Generation is monotonic per shared
Device/stream (`usage-v1` or `memory-v1`). Source mutations enqueue in the same
owning transaction when a shared publication context is available. Usage also
has a deterministic paginated recovery scan because existing exact immutable
rows may predate connected enrollment; Memory enrollment performs the same
bounded paginated backfill. Repeating either scan reuses the exact event
identity and does not duplicate content.

The durable state machine is:

```text
pending -> in-flight -> acknowledged
   ^          |
   +----------+ retryable failure with bounded backoff/jitter
              +-> blocked for permanent/auth/policy conflicts
```

Only a contiguous prefix after the last ACK can be claimed. A process restart
deterministically returns every abandoned `in-flight` row to `pending` before
new claims. Network errors, server unavailability, and rate limiting schedule a
bounded retry; authentication, revocation, Capture Context, version, generation,
and identity conflicts remain visibly blocked. Acknowledged events never return
to pending and their payload or identity is never rewritten.

The local status model contains pending/in-flight/acknowledged/blocked counts,
oldest unacknowledged time, next retry, last bounded error code, last ACK time,
and acknowledged generation. It contains no payload, title, path, token, URL,
or database error. The usage-engine exposes the same closed model through its
version-3 control contract, and the CLI renders both streams together:

```sh
bun run cli -- replication status
bun run cli -- replication status --json
```

With no configured platform origin, the exact result is `local-only` /
`disabled` with both stream states absent; the command does not construct a
platform client. In connected mode it reports the runtime state, last closed
diagnostic, and content-free stream counters. The Sources page reads that same
closed output through `replication.status`, one browser-only bounded-control-
plane Query identity. Its This Device panel labels local-only/connected state,
Usage and Memory published/queue/block counts, server-confirmed generation,
last server confirmation, oldest queued event, and next retry. It never receives payload, title, path, token,
origin URL, or database error content.

Privacy purge removes Memory source content, revisions, evidence, relations,
and search projections. In disconnected mode there was never an outbox event,
so no replication derivative remains. In connected mode the immutable
publication history is retained and a new `privacy-purged` tombstone is queued;
this preserves generation continuity and allows the shared projection to be
deleted. Payload pruning for acknowledged history would require the explicit
metadata/history design described in plan 107 and is not performed silently.

## Server apply and replay boundary

`POST /api/replication/batches` accepts exact `application/json`, identity
encoding, a bounded body, and protocol/count/string bounds. A Bearer Device
credential is resolved by public token ID and constant-time HMAC comparison.
The request Device must equal the authenticated active Device.

One PostgreSQL transaction:

1. locks and rechecks the active Device credential and Device;
2. validates every explicit Capture Context and current identity/Project/SCM
   binding;
3. serializes a Device/stream with an advisory transaction lock;
4. checks batch/event identity, previous ACK proof, overlap, and generation;
5. inserts immutable batch and event receipts;
6. upserts or tombstones the current projection by `fact_key`;
7. advances stream state and stores the reconstructible bounded ACK.

An owner-Space event-identity registry keeps Device/stream event IDs visible to
the ingest transaction even when event receipts are fenced into different
Spaces. Every problem result rolls the transaction back, including any Capture
Contexts materialized while validating the batch.

The ACK is returned only after commit. An exact duplicate returns the stored
ACK. Reusing an event or batch identity with different canonical content is a
conflict and writes nothing. Gaps and disagreeing overlap write nothing. A
commit followed by a lost response is safe because the client retries the same
batch. Content-free metrics expose only outcome, stream, event count, and a
closed problem code.

Generation, active credential state, Capture Context authorization, immutable
identities, and idempotency bound replay. They do not make a copied live Device
credential harmless; rotate or revoke it after suspected disclosure.

## Operations and fallback

The PostgreSQL migration is ordinal 8. Its stream state, immutable batch/event
receipts, and fact projections are protected by forced Space RLS and immutable
receipt triggers. Back up and restore them with the complete PostgreSQL database
and migration ledger, never as isolated tables.

The existing preview/confirm manual usage merge and deterministic Memory
export/import remain the offline and air-gapped fallback. They do not perform
network work. A connected server-side bootstrap that maps a transferred bundle
to the same replication fact keys, plus preview/confirm repair controls for a
blocked stream, is not exposed yet; plan 107 therefore remains in progress.

Focused verification:

```sh
bun test packages/replication-protocol packages/replication-outbox packages/replication-client
bun test packages/usage-store/src/replication.test.ts packages/usage-engine-runtime/src/replication.test.ts
bun test packages/memory-sqlite apps/usage-engine/src/replication-runtime.test.ts
nix develop --command bun run test:postgres
bun run test:local-platform
```

The PostgreSQL suite covers exact and concurrent duplicates, correction,
tombstone, gap/overlap/conflict, all-or-nothing apply, revocation, bounded HTTP,
SQLite-to-HTTP-to-PostgreSQL ACK, and continuity while another Device is
offline.
