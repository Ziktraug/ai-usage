# Plan 107: Replicate Local Machine Facts to the Server With an Idempotent Outbox Protocol

> **Executor instructions**: Preserve local collection as the authoritative
> machine process. Replication is asynchronous publication of typed facts, never
> a network call inside the local collection transaction. Clients initiate every
> connection; do not revive LAN discovery, peer servers, or inbound machine
> ports. Start with metadata/facts, not sensitive transcript archives.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- apps/usage-engine packages/usage-engine-runtime packages/usage-engine-control packages/usage-store packages/report-core packages/usage-merge apps/server packages/postgres-store packages/platform-core packages/identity packages/authorization apps/web apps/cli docs/architecture.md docs/adr`
> Re-read the removed LAN-sync history and current manual merge semantics when
> these files drift. Do not copy the old topology merely because some transport
> code once existed.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — duplication, deletion, identity drift, or tenant mistakes can
  corrupt the shared view or disclose personal data
- **Depends on**: 101–104
- **Category**: multi-machine synchronization and shared read model
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

The current manual transfer flow is safe but operationally expensive: export a
bounded JSON bundle, move it to another machine, preview, confirm, and repeat.
The earlier LAN experiment solved some friction but required machines to expose
ports, discover peers, exchange credentials, and be online simultaneously.

The target topology is different:

```text
Device A ── outbound HTTPS ──┐
                             ├── shared server + PostgreSQL
Device B ── outbound HTTPS ──┘
```

Each local engine continues collecting and serving its own SQLite state. A
durable outbox publishes changes whenever the server is reachable. The server
persists acknowledged device facts so any authorized browser/device can inspect
the shared state while the source Device is offline.

## Replication principles

1. **Local-first**: collection, local report publication, and local Memory do not
   wait for replication.
2. **Outbound-only**: the Device initiates HTTPS; server never dials the machine.
3. **At-least-once transport, idempotent apply**: retries are expected and safe.
4. **Monotonic per-device generation**: server acknowledges exactly what it has
   durably applied.
5. **Typed deltas, not database copying**: SQLite and PostgreSQL schemas may
   differ; the protocol carries validated domain facts.
6. **Explicit tenant/capture context**: the server rejects ambiguous or
   unauthorized Space/Project assignments.
7. **Provenance retained**: Device, harness, source session, parser/protocol
   version, capture time, and content hash remain queryable.
8. **Deletion is a fact**: supersession/tombstone semantics are explicit; missing
   rows in a later batch are not interpreted as deletion.
9. **Manual transfer remains a fallback** through the initial connected release.
10. **No remote commands**: the server does not execute local collection or shell
    work in this plan.

## Protocol package

Create a pure `packages/replication` (or accepted equivalent) owning:

- protocol version and compatibility negotiation;
- branded Device/generation/batch/idempotency identifiers;
- typed envelopes and strict runtime validation;
- batch/row/byte limits;
- compression/content encoding rules;
- acknowledgment/error contracts;
- deterministic hashes and canonical serialization;
- no HTTP server, SQLite, PostgreSQL, or auth implementation.

### Envelope

Conceptual contract:

```ts
interface ReplicationBatch {
  protocolVersion: number;
  batchId: ReplicationBatchId;
  deviceId: DeviceId;
  fromGenerationExclusive: ReplicationGeneration;
  toGenerationInclusive: ReplicationGeneration;
  createdAt: Instant;
  captureContexts: CaptureContextReference[];
  changes: ReplicationChange[];
  previousAckProof?: string;
}
```

```ts
type ReplicationChange =
  | { kind: "session-fact-upsert"; value: ReplicatedSessionFact }
  | { kind: "session-fact-tombstone"; value: SessionFactTombstone }
  | { kind: "quota-observation"; value: ReplicatedQuotaObservation }
  | { kind: "checkout-observation"; value: ReplicatedCheckoutObservation }
  | { kind: "memory-observation"; value: ReplicatedMemoryObservation }
  | { kind: "handoff-upsert"; value: ReplicatedHandoff }
  | { kind: "device-status"; value: ReplicatedDeviceStatus };
```

Only include change kinds whose owner plan is implemented. The initial vertical
slice should be `session-fact-upsert` plus checkout/device status; do not block
the protocol on every future kind.

### Acknowledgment

```ts
interface ReplicationAck {
  protocolVersion: number;
  deviceId: DeviceId;
  acceptedThroughGeneration: ReplicationGeneration;
  appliedBatchId: ReplicationBatchId;
  appliedAt: Instant;
  counts: BoundedApplyCounts;
  warnings: BoundedReplicationWarning[];
}
```

The acknowledgment is returned only after the PostgreSQL transaction and any
required authorization/identity resolution state are durable.

## Local outbox

Extend the local SQLite domain through `usage-store`/`usage-engine-runtime`
without allowing another writer.

Suggested tables/owners:

```text
replication_generations
  current local semantic publication generation

replication_outbox
  generation
  change_kind
  stable change key
  canonical payload/hash or reference to immutable local fact
  state: pending | in_flight | acknowledged | blocked
  attempts / next_attempt_at / last_error_code

replication_remote_state
  server identity
  device identity
  last acknowledged generation
  protocol version
  connection status
```

Requirements:

- outbox entries are created in the same local transaction that commits the
  relevant durable fact or from an exact immutable revision immediately after
  publication under the sole writer;
- network work never runs while holding the main SQLite write transaction;
- crash after server apply but before local ACK persistence is safe through
  idempotent retry;
- outbox compaction occurs only after acknowledged generations are safely beyond
  retention/rebuild needs;
- backpressure is bounded and visible;
- failed/blocked tenant assignment does not drop the fact;
- no secret or raw harness file enters the outbox by default.

## Stable change identity

Reuse existing stable source identity where valid:

```text
Device ID
Harness key
Source session ID
Row/source fingerprint
Content hash
```

But define protocol-level IDs explicitly. A local report row and a shared
session fact are not necessarily the same storage object.

For a session fact:

```ts
interface ReplicatedSessionFact {
  factId: SessionFactId;
  deviceId: DeviceId;
  harnessKey: string;
  sourceSessionId: string | null;
  sourceFingerprint: string;
  contentHash: string;
  captureContextId: CaptureContextId;
  projectResolution: ProjectResolutionReference;
  observedAt: Instant;
  payload: PortableSessionFactPayload;
}
```

Server uniqueness/idempotency should use stable fact identity and content hash,
not batch order.

## Shared ingest service

`apps/server` exposes a versioned authenticated endpoint, conceptually:

```text
POST /api/device-replication/v1/batches
```

The handler:

1. authenticates the Device credential from plan 104;
2. validates protocol/version/body/decompression limits before allocation;
3. loads Device status and expected generation;
4. authorizes each referenced Capture Context/Space/Project;
5. resolves repository/project identities through plan 102 without implicit
   organization assignment;
6. applies the batch transactionally and idempotently;
7. records provenance and audit metadata;
8. advances acknowledged generation exactly once;
9. returns bounded ACK/warnings;
10. emits structured operational metrics without payload content.

HTTP handlers call a replication application service; they do not implement SQL
or authorization loops inline.

## Generation and ordering semantics

Choose and document behavior for:

- exact next generation;
- duplicate already-acknowledged batch;
- overlapping range;
- gap ahead of expected generation;
- local database reset/new Device identity;
- Device credential rotation;
- protocol downgrade/upgrade;
- batch split due to byte limits.

Recommended initial rule:

- batches for one Device apply in generation order;
- exact duplicates return the original/equivalent ACK;
- gaps return `generation-gap` with expected generation;
- old overlapping batches are acknowledged only if every change key/hash agrees
  with durable history; otherwise return a conflict requiring resync;
- a full bootstrap snapshot is a separate bounded protocol operation, not a
  silent generation reset.

## Bootstrap and recovery

### Initial bootstrap

A new Device with existing history needs a bounded initial upload. Options:

- split immutable local facts into ordered generation batches;
- import the current bounded manual merge bundle into the server through an
  authenticated preview/confirm flow, then set the replication baseline;
- generate a dedicated bootstrap manifest plus chunks.

Select through measurement. Preserve row/byte bounds and preview identity.

### Resynchronization

Provide a safe diagnostic flow:

```text
status → compare expected/local generation → preview repair → confirm
```

Do not support “delete server device data and re-upload” as an invisible
fallback. Repair shows affected facts, Space/Project scope, and tombstone impact.

### Manual bundle fallback

Keep the current manual JSON transfer for:

- air-gapped use;
- server bootstrap/recovery;
- migration from non-connected versions;
- explicit user-controlled backup exchange.

Document how manual import and connected replication avoid duplicate facts.

## Data included by phase

### Phase A — metadata/facts

- normalized session usage facts;
- Device/machine provenance and freshness;
- Project/checkout resolution evidence;
- provider quota observations only when account-scope semantics are correct;
- no prompts or detailed tool output.

### Phase B — Memory/Handoff facts

After plan 105/108:

- explicit Memory Observations/Proposals/accepted changes according to ownership;
- Handoffs and Work Threads;
- no raw transcript unless plan 109 archive policy opts in.

### Phase C — sensitive archive

Owned exclusively by plan 109 through separate payload/permission/retention
rules. Do not add a generic binary blob change kind in this plan.

## Quota account scope

A subscription quota may be shared across several Devices. Do not present each
Device observation as a separate independent quota.

Before replicating quota observations, define a `SubscriptionProfile` or accepted
account-scope identity:

```text
OpenAI Pro personal
Claude Max personal
organization API account
```

Device/harness installations reference that scope without storing provider
credentials in the server. Server projections deduplicate/confidence-rank
observations for the same scope/window. If this identity is not ready, defer
quota replication rather than publishing misleading duplicates.

## Connected Web read model

Add a shared read model behind existing contract-first boundaries:

- global Overview/Sessions/Analysis over authorized replicated facts;
- Device/freshness provenance;
- unresolved Project/Capture Context state;
- connected status and last ACK;
- source Device may be offline;
- shared data timestamp is server acknowledgment/observation time, not current
  browser time.

Do not fork the frontend into a second application. Local and connected adapters
may implement a common report contract where semantics truly match, but local
management capabilities (Sources/Skills) remain visibly local.

## Retry, backoff, and operational state

Local replication worker:

- runs independently of collection cadence;
- bounded exponential backoff with jitter;
- respects server `Retry-After` where safe;
- distinguishes auth revoked, authorization blocked, protocol incompatible,
  generation conflict, transient network, and server unavailable;
- no tight retry loop;
- manual “retry now” is a control command, not a second worker;
- exposes pending counts/oldest age/last ACK without payload content;
- cannot grow disk indefinitely without an alert/retention strategy.

Server:

- idempotency data retention long enough for expected offline/retry windows;
- rate and byte limits per Device/Space;
- transactional apply metrics;
- dead-letter/reconciliation jobs are explicit service principals;
- no silent partial batch acceptance unless the protocol defines per-change
  results and safe replay; prefer all-or-nothing first.

## Security and privacy

- TLS required outside local test;
- Device credential never in URL/query/logs;
- compression bomb and oversized JSON defenses before deep parsing;
- strict exact-key/version validation;
- no local source paths displayed outside authorized context;
- Capture Context authorization before storage;
- rejected tenant assignment returns bounded identifiers/reasons only;
- no server endpoint to fetch arbitrary local files or trigger a shell command;
- revocation blocks new batches immediately according to documented consistency;
- audit batch identity/count/scope/result, never full payload.

## Testing requirements

### Protocol tests

- canonical serialization/hash stability;
- exact keys/version and forward-incompatible rejection;
- row/batch/byte/decompression limits;
- every change kind parser;
- malformed IDs/timestamps/context;
- ACK parser and bounded warnings;
- protocol upgrade fixture.

### Local outbox tests

- fact + outbox atomicity;
- collection succeeds while network fails;
- crash after send before ACK causes safe duplicate retry;
- acknowledgment/compaction;
- backoff and restart persistence;
- blocked authorization retained visibly;
- no raw prompt/secret in outbox fixture;
- sole-writer boundary remains enforced.

### Server ingest tests

- Device auth/revocation;
- authorized personal and organization Capture Context;
- ambiguous/forbidden context rejected with no partial rows;
- duplicate batch idempotency;
- generation gap/overlap/conflict;
- transactional all-or-nothing apply;
- repository rename/project resolution;
- concurrent duplicate requests;
- rate/size/decompression controls;
- audit/observability contains no payload.

### End-to-end tests

- two synthetic Devices publish different sessions to one personal Space;
- one Device goes offline and shared Web still displays acknowledged data;
- one physical Device fixture publishes personal and organization contexts
  without cross-visibility;
- organization auditor sees aggregate only;
- manual bootstrap plus later deltas does not duplicate;
- server unavailable for an extended window then recovers in order;
- local Web remains fully usable throughout.

## Done criteria

- [ ] A pure versioned protocol and strict bounds exist.
- [ ] Local SQLite outbox is written only by the usage-engine owner and never
      performs network I/O inside the fact transaction.
- [ ] Device-initiated HTTPS is the only normal replication topology.
- [ ] Server ingest authenticates Device, authorizes Capture Context, resolves
      Project identity, and applies atomically/idempotently.
- [ ] Generation duplicate/gap/overlap/reset semantics are documented and tested.
- [ ] Bootstrap/resync has previewed bounded behavior.
- [ ] Manual merge bundle remains a compatible fallback and does not duplicate
      connected facts.
- [ ] Shared Web can read acknowledged facts while source Devices are offline.
- [ ] Local product remains independent of server availability.
- [ ] Sensitive session content is absent from the initial protocol.
- [ ] Operational status/retry/revocation is visible without leaking payloads.

## STOP conditions

Stop and report when:

- collection must wait for an HTTP response;
- a Device must bind a non-loopback/inbound port;
- the protocol copies SQLite files or Drizzle rows directly;
- server infers organization ownership from Device, remote URL, or SCM account;
- duplicate retry can create a second logical fact;
- deletion is inferred from absence rather than an explicit tombstone;
- partial batch apply cannot be replayed deterministically;
- outbox can grow without bound or loses blocked facts;
- server can execute arbitrary local commands or request arbitrary files;
- initial replication requires prompts/raw harness archives;
- quota replication proceeds without shared account-scope semantics.

## Out of scope

- sensitive session archive payloads (plan 109);
- native session import/resume (plan 110);
- remote execution or fleet management;
- peer-to-peer/LAN mode;
- real-time collaborative editing;
- cross-region active-active server replication;
- organization billing and provider credential synchronization.
