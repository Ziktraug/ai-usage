# Plan 107: Replicate Local Machine Facts to the Server With an Idempotent Outbox Protocol

> **Executor instructions**: Replication is asynchronous publication from local
> database authorities, never network I/O inside a collection/Memory mutation.
> Clients initiate every connection. Preserve logical fact identity,
> publication event identity, and exact content identity separately. Start with
> metadata and policy-selected Memory, not session archives.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- apps/usage-engine packages/usage-engine-runtime packages/usage-engine-control packages/usage-store packages/report-core packages/usage-merge apps/server packages/postgres-store packages/platform-core packages/identity packages/authorization packages/memory apps/web apps/cli docs/architecture.md docs/adr`

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — identity, tenant, replay, retry, or correction defects can
  corrupt the shared projection or disclose personal data
- **Depends on**: 101, 102, 103, 104, 105
- **Category**: connected multi-device replication and shared read model
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Plan status**: IN PROGRESS — partial implementation exists outside `main`,
  pending integration and the remaining done criteria

## Topology and ownership

```text
usage SQLite authority ── usage outbox stream ──┐
                                                ├─ outbound HTTPS ── server/PostgreSQL
Memory SQLite authority ─ Memory outbox stream ─┘
```

The existing usage-engine remains the sole writer of usage SQLite. The local
Memory writer selected in plans 100/105 is the sole writer of Memory SQLite.
Prefer one supervised local process composing both writers, while preserving
separate database transactions and ownership.

Each authoritative local store writes its outbox event atomically with the fact
or exact immutable revision it publishes. A protocol `streamId` distinguishes
usage and Memory streams; generation is monotonic per Device/stream. The common
outbox schema below may exist in both SQLite stores. The worker reads both
through bounded store ports and performs network I/O only after local
transactions close.

Server projections are authoritative for acknowledged shared/published facts,
not for source harness files or unpublished local Memory. The manual merge
bundle remains a bootstrap/recovery/air-gapped fallback.

## Replication principles

1. local collection, report publication, Memory, search, MCP, and local Work
   handoffs never wait for network;
2. Device initiates TLS connections; no inbound Device port or LAN discovery;
3. transport is at-least-once; server apply is idempotent;
4. generation demand advances monotonically; only durable server apply is ACKed;
5. envelopes carry validated domain facts, never SQLite/Drizzle rows or DB files;
6. Capture Context/Space/Project is explicit and authorized before storage;
7. provenance and exact content hash remain queryable;
8. deletion/supersession is an explicit event, never inferred from absence;
9. server never executes local commands or fetches arbitrary files;
10. idempotency limits duplicate application but does not neutralize a stolen
    Device credential.

## Three identities

Every publication distinguishes:

```text
fact_key
  stable logical fact identity used by the server projection

event_id
  one publication/version event; stable across retries of that event

content_hash
  exact canonical content version carried by the event
```

Enrichment or correction creates a **new event** with the same `fact_key` and a
new `content_hash`. It never mutates the acknowledged event and never changes an
acknowledged row back to pending. Re-sending the same event retains `event_id`
and `content_hash`.

Examples:

| Situation | `fact_key` | `event_id` | `content_hash` |
| --- | --- | --- | --- |
| initial session fact | stable session fact key | E1 | H1 |
| retry before ACK | same | E1 | H1 |
| acknowledged retry after lost local ACK | same | E1 | H1 |
| enrichment/correction | same | E2 | H2 |
| explicit tombstone | same | E3 | H3 for tombstone payload |
| distinct session | different | E4 | any |

`fact_key` derives from stable domain facts such as Device, harness, source
session/fingerprint, and fact kind—not rowid, insert order, batch, or timestamp.

## Pure protocol package

Create a runtime-validated, IO-free protocol package with versions, branded
Device/stream/generation/event/batch IDs, canonical serialization/hash, bounds,
change unions, ACK/errors, and no SQLite/PostgreSQL/HTTP/auth implementation.

```ts
interface ReplicationBatch {
  readonly protocolVersion: 1;
  readonly batchId: ReplicationBatchId;
  readonly idempotencyKey: string;
  readonly deviceId: DeviceId;
  readonly streamId: ReplicationStreamId;
  readonly fromGenerationExclusive: ReplicationGeneration;
  readonly toGenerationInclusive: ReplicationGeneration;
  readonly captureContexts: readonly CaptureContextSnapshot[];
  readonly events: readonly ReplicationEvent[];
  readonly previousAckProof?: string;
}

interface ReplicationEvent {
  readonly eventId: ReplicationEventId;
  readonly generation: ReplicationGeneration;
  readonly factKey: string;
  readonly contentHash: string;
  readonly changeKind: ReplicationChangeKind;
  readonly captureContextId: CaptureContextId;
  readonly payload: ReplicationPayload;
}
```

Initial change kinds cover normalized session/checkout/Device facts and
policy-selected Memory Observations, Proposals, Items/Revisions, relations, and
tombstones. Plan 108's connected extension adds `work-handoff-upsert`,
`work-handoff-status`, `work-thread-upsert`, and related tombstones using
`WorkHandoff*` terminology. Imported Memory `kind: "handoff"` remains a Memory
payload value, not a WorkHandoff change kind.

No generic blob/raw transcript change exists; session archives are plan 109.

ACK:

```ts
interface ReplicationAck {
  readonly protocolVersion: 1;
  readonly deviceId: DeviceId;
  readonly streamId: ReplicationStreamId;
  readonly acceptedThroughGeneration: ReplicationGeneration;
  readonly appliedBatchId: ReplicationBatchId;
  readonly appliedEventIds: readonly ReplicationEventId[];
  readonly appliedAt: Instant;
  readonly counts: BoundedApplyCounts;
  readonly warnings: readonly BoundedReplicationWarning[];
}
```

ACK is returned only after the PostgreSQL fact projections, event receipts, and
generation state commit.

## Local outbox schema

Use this schema (table naming may follow package conventions without changing
the contract):

```sql
CREATE TABLE replication_outbox_events (
  event_id             TEXT PRIMARY KEY,
  generation           INTEGER NOT NULL,
  fact_key             TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  change_kind          TEXT NOT NULL,
  payload              TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (
    state IN ('pending', 'in-flight', 'acknowledged', 'blocked')
  ),
  enqueued_at          TEXT NOT NULL,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TEXT,
  last_error_code      TEXT,
  acknowledged_at      TEXT,
  UNIQUE (generation, fact_key, content_hash)
);

CREATE INDEX idx_replication_outbox_ready
  ON replication_outbox_events(state, next_attempt_at, generation);
CREATE INDEX idx_replication_outbox_fact_history
  ON replication_outbox_events(fact_key, generation);
```

The migration includes `next_attempt_at`, `last_error_code`, and every state
before retry tests or worker code refer to them.

State semantics:

```text
pending → in-flight → acknowledged
   ↑          │
   └ retryable failure
              └ permanent/auth/policy failure → blocked
```

Retrying the **same unacknowledged event** may move `in-flight` back to
`pending`, increment attempts, and schedule `next_attempt_at`. A changed payload
is never a retry; it is a new event. An acknowledged event remains acknowledged.

Event creation is atomic with its source fact in the owning SQLite store. If an
exact immutable usage revision is the source, creation may occur immediately
after revision publication under the same sole writer with an explicit recovery
scan that deterministically backfills missing events.

## Event history and compaction

- acknowledged events remain immutable historical publication records;
- do not coalesce distinct content versions, rewrite event IDs, or recycle an
  acknowledged row;
- V1 may retain all acknowledged event rows while applying an explicit database
  size/age alert;
- any later payload-pruning/archival design must preserve event ID, generation,
  fact key, content hash, kind, enqueue/ACK time, and server receipt proof in an
  immutable history table/backup before payload removal;
- blocked events are never compacted or dropped silently;
- pending/in-flight events are never compacted;
- server projection compaction is keyed by `fact_key` and must retain enough
  event/version receipts to answer retries/conflicts.

## Shared ingest and idempotency

The server endpoint authenticates a Device credential from plan 104 using
public token ID + constant-time HMAC verification, then:

1. validates protocol/version/decompression/body/count limits;
2. checks Device active state and expected Device/stream generation;
3. validates every Capture Context snapshot and current authorization;
4. resolves Project/Repository through plan 102 without inferred Space;
5. inserts immutable event receipts idempotently;
6. upserts current shared projections by `fact_key` using explicit event/version
   ordering and change kind;
7. advances generation and stores reconstructible bounded ACK in one transaction;
8. emits content-free operational metrics.

Server event receipt uniqueness includes Device/stream/event ID and canonical
content hash. An event ID reused with different content is an
`event-id-conflict`. Batch receipt uniqueness includes Device/stream + batch ID
and idempotency key/hash. Exact duplicate returns the prior ACK; mismatch returns
conflict and writes nothing.

Projection semantics:

- exact new event → receipt + fact-key projection update if it is the accepted
  successor;
- same event retry → no duplicate projection, same/equivalent ACK;
- same fact/new content event → immutable new receipt + projection update;
- stale/out-of-order event → receipt/conflict behavior follows explicit
  generation rules and never silently overwrites a newer projection;
- tombstone updates the fact-key projection explicitly and retains receipts.

## Generation and recovery

- batches apply in generation order per Device/stream;
- exact duplicate returns stored ACK;
- gap returns `generation-gap` with expected generation;
- overlap is ACKed only where every overlapping event ID/content hash agrees;
- reset creates a reviewed bootstrap/new stream or new Device identity, never a
  silent generation reset;
- batch splitting preserves event order and exact generation coverage;
- crash after server commit/before local ACK safely retries identical event/batch
  IDs;
- status → preview repair → confirm handles resynchronization;
- manual bundle bootstrap maps to the same `fact_key` identities to avoid
  duplicates.

## Retry and operational state

The worker runs independently from collection/Memory mutation. Use bounded
exponential backoff with jitter and safe `Retry-After`. Claim-ready selects only
`pending` rows whose `next_attempt_at` is null/due, changes them to `in-flight`,
and recovers abandoned in-flight leases after restart through explicit lease
metadata or a documented deterministic rule.

Classify unreachable, unauthenticated, revoked, forbidden Capture Context,
protocol incompatible, generation conflict, rate limited, and server unavailable.
Permanent/policy failures become visible `blocked` rows; they are not discarded.
Expose counts, oldest age, next retry, last ACK/generation, and bounded error code
without payload content.

## Security and replay model

- TLS outside tests;
- token never in URL/query/logs and verified using plan 104's HMAC design;
- body/decompression limits before deep parse;
- strict version/exact-key validation;
- Capture Context authorization before persistence;
- generation, active credential, revocation, batch/event identity, and
  idempotency all constrain replay;
- idempotency alone does not prevent a thief with a still-valid credential from
  submitting a new authorized-looking request;
- server has no endpoint to fetch files, run collection, or execute shell work.

SCM account/installation/credential are used only for repository identity flows
owned by plans 102/104. Ingest never treats an SCM installation as a Person or a
Device credential.

## Phased data

### Initial connected slice

- normalized usage/session facts;
- Device/machine provenance/freshness;
- checkout/project resolution evidence;
- accepted/reviewed policy-selected Memory facts;
- no prompts/tool outputs/raw local paths as authority.

Quota observations wait for a real account-scope identity so multiple Devices
do not appear as separate subscriptions.

### Plan 108 connected extension

Add shared Work Threads and Work handoffs using the normalized contracts and
permissions. Do not add bare `Handoff` domain types or old tool names.

### Plan 109 archive extension

Sensitive normalized archive uses a separate contract, permission, outbox
policy, encryption, and retention. No generic blob in this plan.

## Connected read model

The existing Web product gains authorized shared facts with Device provenance,
last ACK/freshness, unresolved identity/capture state, and offline source
visibility. Local Sources/Skills remain visibly local. One named Query policy
owns replication status. Stale acknowledged data is labeled, not hidden.

## Steps

### Step 1: Define pure protocol and identity tests

Implement strict envelopes/events/ACKs, canonical hashes, limits, and the three
identities. Test rebuild stability, no collision, retry stability, enrichment as
same fact/new event/content, and tombstones.

### Step 2: Add outbox schemas to owning local stores

Add the exact state/retry fields before worker tests. Write usage events with
usage facts/revisions and Memory events with Memory mutations under their sole
writers. Test transaction rollback and deterministic recovery backfill where
needed.

### Step 3: Implement worker claiming/retry/ACK

Test pending/in-flight/acknowledged/blocked transitions, restart lease recovery,
backoff scheduling, lost ACK, blocked visibility, and the invariant that changed
content creates a new event while acknowledged rows remain unchanged.

### Step 4: Implement authenticated transactional ingest

Test HMAC Device auth/revocation, Capture Context authorization, exact duplicate,
concurrent duplicate, event/batch conflicts, overlap/gap, same fact/new content,
tombstone, all-or-nothing failure, and server upsert by fact key.

### Step 5: Prove outbound-only and two-Device continuity

Assert replication adds no listener beyond existing numeric-loopback local
surfaces, drives outbound requests to a stub, and preserves acknowledged Device
A data while A is offline and Device B publishes.

### Step 6: Preserve manual bootstrap/recovery

Map bundle/import facts to the same keys, preview repairs, and prove no duplicate
projection when connected deltas follow bootstrap.

### Step 7: Add read/status surfaces and docs

Document streams, identities, state machine, receipt history, retry/compaction,
replay threat model, writer ownership, and manual fallback. Add connected UI
provenance/freshness.

## Verification

- enriched/corrected facts retain `fact_key` and create new event/content IDs;
- schema has all states/retry fields before tests;
- acknowledged rows never return to pending or change payload;
- server projections upsert by logical fact identity;
- event and batch idempotency conflict tests are concurrent and transactional;
- blocked/history/compaction rules do not drop facts;
- Device auth uses HMAC design and replay claims are bounded;
- no inbound listener or LAN package returns;
- local tests prove zero platform calls when disconnected;
- lint, typecheck, protocol/store/server/integration tests pass.

## Done criteria

- [ ] Fact, event, and content identities are separate and tested.
- [ ] Both local authorities write their outbox only through their sole writer.
- [ ] State/retry schema and transitions are complete.
- [ ] Server apply is transactional, idempotent, and fact-key based.
- [ ] Enrichment/correction never reopens an acknowledged row.
- [ ] Clients initiate all traffic; local product ignores server availability.
- [ ] Manual fallback and recovery preserve identities.
- [ ] Sensitive archives are absent; WorkHandoff extension is left to plan 108.

## STOP conditions

Stop and report when:

- publication event identity is also used as stable fact identity;
- changed content mutates/requeues an acknowledged row;
- retry fields are referenced before schema exists;
- network work occurs inside source database transactions;
- another local process writes an outbox;
- duplicate retry can create a second logical fact;
- server infers Space from Device/remote/SCM;
- idempotency is described as complete stolen-credential protection;
- blocked/pending events can be silently compacted;
- raw archives or arbitrary blobs enter the initial protocol.

## Out of scope

- session archives (plan 109);
- native session portability (plan 110);
- peer-to-peer/LAN replication;
- remote execution/fleet management;
- cross-region active-active or provider credential synchronization.
