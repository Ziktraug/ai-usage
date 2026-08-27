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

## Current state

### A monotonic generation counter already exists — reuse its semantics

`packages/usage-store/src/index.ts:1100-1101` seeds two counters in
`usage_store_metadata`:

```sql
INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('generation', 0);
INSERT OR IGNORE INTO usage_store_metadata (key, value) VALUES ('machine_fleet_generation', 0);
```

incremented at `:1399`, `:2073`, `:2084`, and `:2222` with
`UPDATE … SET value = value + 1`. `CONTEXT.md:19-22` (**Source publication**)
already defines the acknowledgement discipline this plan needs:

> "Requests advance monotonic demand even while publication is queued or running;
> only a successful attempt acknowledges the generations it captured."

That is the outbox contract, already in the ubiquitous language and already
implemented locally. **Replication generation** must mean the same thing:
demand advances freely, acknowledgement happens only on success. Do not invent
a second cursor concept alongside it — reuse the vocabulary, and where a new
counter is genuinely needed, name it as a sibling (`replication_generation`) in
the same metadata table.

### The manual merge bundle is the fallback this plan must not break

`packages/usage-merge/src/index.ts` implements the existing multi-machine path:

- `:12` `ManualMergeDocumentInput`, `:17` `ManualMergePreviewResult extends
  ImportResult, MergePreviewProof`, `:26` `ManualMergeConfirmInput`;
- `:36` `UsageMergeErrorReason = 'invalid-input' | 'invalid-json' |
  'preview-stale' | 'self-merge' | 'store-failed'`.

Two things to carry forward:

- **`preview-stale`** — an optimistic-concurrency proof already exists here. The
  ingest protocol should reuse the idea, not reinvent it under a new name.
- **`self-merge`** — the system already refuses to merge a machine's data into
  itself. Ingest needs the same guard, and it is easy to forget once devices are
  authenticated.

`CONTEXT.md:88-95` defines **Merge bundle** and **Manual transfer**, with
_Avoid_: "pairing, replication, automatic transfer". The program keeps the merge
bundle as a bootstrap/recovery/air-gapped fallback, so **both** vocabularies now
exist and must stay distinguishable. Plan 100 added **Replication generation**;
verify its `_Avoid_` list includes "manual transfer".

### `lan-pairing` is a retired package — read that as a constraint

`tools/check-package-boundaries.ts:52`:

```ts
const retiredPackages = [`${workspacePackageScope}lan-pairing`, `${workspacePackageScope}sync`] as const;
```

Two packages were removed for building the shape this plan must not rebuild:
peer discovery and inbound listeners (plan 008, "Remove Legacy LAN Sync"). They
are permanently forbidden imports for `apps/web`
(`check-package-boundaries.ts:104-108`).

**Cite this in ADR 0029's evidence.** "Clients initiate all traffic" is not a
new preference here; it is a decision this repository already made once and
enforced mechanically.

### The engine is the only local writer

ADR 0009 and `CONTEXT.md:23-29`: `apps/usage-engine` owns all usage-domain
writes. The outbox is a **local write**, so it belongs to the engine — not to
the CLI, not to the web app, not to a new daemon. Adding a second local writer
to produce outbox rows would break the repository's central invariant.

`tools/check-package-boundaries.ts:153-162`
(`engineRuntimeAllowedWorkspaceDependencies`) is the allowlist that must gain
the protocol package, and it is the check that will catch the mistake.

### Prerequisites

Plans 101–104: `postgres-store`, identity, `Authorizer`, and device credentials.
Ingest without device authentication is an open write endpoint; there is no
partial version of this plan that ships earlier.

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

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite: devices authenticate | `grep -c "credential_verifier" packages/postgres-store/src/migrations.ts` | ≥ 1 |
| Protocol tests | `bun test packages/replication-protocol` | all pass |
| Outbox tests (local) | `bun test packages/usage-engine-runtime/src/outbox.test.ts` | all pass |
| Ingest tests (server) | `bun test apps/server/src/ingest.test.ts` | all pass |
| Two-device scenario | `bun test apps/server/src/two-device.test.ts` | all pass |
| No inbound port proof | `bun test packages/replication-protocol/src/outbound-only.test.ts` | all pass |
| Idempotency under retry | `bun test apps/server/src/ingest-idempotency.test.ts` | all pass |
| Sole-writer check | `grep -rn "usage-store/writer" apps packages --include='*.ts' \| grep -v test` | only engine-runtime and its app root |
| Local regression, no cluster | `! pgrep -x postgres && bun run test:packages` | all pass |
| Merge bundle still works | `bun test packages/usage-merge` | all pass |
| Full verification | `bun run check && bun run lint && bun run typecheck && bun run test` | exit 0 |

## Git workflow

- Branch `plan/107-device-replication`, cut from plan 104's branch (this plan is
  parallel to 105/106 — coordinate migration numbers with whoever holds them).
- **Migration-number coordination**: 105 takes `0005_memory`; this plan takes
  `0006_replication`. If both land independently, the second to merge renumbers.
  Check `packages/postgres-store/src/migrations.ts` before choosing.
- Stage by explicit path. Never `git add -A`.
- Four commits:
  1. `feat(replication-protocol): define the envelope, change identity, and generation semantics`
  2. `feat(usage-engine): produce durable outbox entries inside the writer transaction`
  3. `feat(server): add authenticated idempotent ingest`
  4. `feat(web): show replication provenance and freshness`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: The protocol package, depended on by both sides

`packages/replication-protocol` — pure types and validation, no IO, no Drizzle.
It is the one module the local engine and the server both import, so it must be
fully closed:

```ts
{
  packageName: '@ai-usage/replication-protocol',
  forbiddenDependencies: ['@ai-usage/*'],
  forbiddenImports: ['@ai-usage/*'],
  reason: 'the replication protocol is a pure contract shared by the local engine and the server; it must not depend on either side.',
}
```

The envelope:

```ts
export interface ReplicationEnvelope {
  readonly protocolVersion: 1;
  readonly batchId: ReplicationBatchId;
  readonly deviceId: DeviceId;
  readonly fromGenerationExclusive: ReplicationGeneration;
  readonly toGenerationInclusive: ReplicationGeneration;
  readonly captureContexts: readonly CaptureContextSnapshot[];
  readonly changes: readonly ReplicationChange[];
  readonly previousAckProof?: string;
  readonly idempotencyKey: string;           // stable across retries of the same batch
}
```

Every change kind carries a `captureContextId`. Every referenced context must
appear exactly once in `captureContexts`, and the server verifies that snapshot
against the durable `capture_contexts` row from plan 102 before applying any
change. A missing, cross-Space, changed, or `unassigned` context is a typed batch
rejection; it is never defaulted. This reconciles the executable envelope with
the range/batch contract and permits several explicit contexts in one bounded
batch without inferring tenancy.

Define `canonicalBatchHash(envelope)` over the normalized protocol version,
Device, generation range, contexts, and changes, excluding transport encoding.
Retries of the same logical batch must produce the same hash even if compression
or HTTP framing differs.

Per the "Contracts do not become ORM row types" rule, these are explicitly
validated types (same discipline as `packages/web-contract`, whose
`schema-conventions.test.ts` is the precedent), never inferred from Drizzle.

**Verify**: `bun test packages/replication-protocol` → all pass, including the
missing-capture-context rejection.

### Step 2: Stable change identity

The identity must be stable across re-collection of the same underlying fact,
or the server accumulates duplicates every time a device re-reads local history.

```ts
/** Stable across re-collection: derived from the fact, never from row order, insert time, or rowid. */
export const changeIdentity = (change: ReplicationChange): string => …;
```

Tests:

- re-collecting the same session yields the same identity;
- an **enriched** row (plan's enrichment contribution, `CONTEXT.md:47-50`) keeps
  the base identity and does not become a new change;
- two different sessions never collide;
- identity is stable across a local database rebuild — assert by computing it
  from a fixture, wiping the store, re-importing, and recomputing.

That last test is the one that matters. A local rebuild is the realistic event,
and an identity derived from anything ambient (rowid, insert order) passes the
first three tests and fails this one.

**Verify**: `bun test packages/replication-protocol/src/identity.test.ts`
→ all pass.

### Step 3: The outbox, written inside the engine's existing transaction

The outbox lives in the **local SQLite** store and is written by the usage
engine — the only local writer (ADR 0009).

```sql
CREATE TABLE IF NOT EXISTS replication_outbox (
  change_id     TEXT PRIMARY KEY,
  generation    INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  enqueued_at   TEXT NOT NULL,
  acknowledged_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_replication_outbox_pending
  ON replication_outbox(generation) WHERE acknowledged_at IS NULL;
```

Add it to `packages/usage-store/src/index.ts`'s `migrate()` (`:1035-1210`) with
the existing `CREATE TABLE IF NOT EXISTS` idiom, and bump
`USAGE_STORE_SCHEMA_VERSION`. Follow the forward-migration test precedent in
`packages/usage-store/src/migration.test.ts`.

Rules:

- The outbox row is written **in the same transaction** as the fact it
  describes. A separate write introduces a window where a fact exists and its
  outbox row does not — silent permanent divergence.
- `acknowledged_at` is set only on a successful server acknowledgement, matching
  `CONTEXT.md:19-22`.
- Reads for publication are bounded — the store already has bounded-read
  conventions throughout.
- **Nothing outside the engine writes this table.** Verify with the sole-writer
  grep in Commands; it is the check ADR 0009 is enforced by.

**Verify**: `bun test packages/usage-store/src/migration.test.ts` → forward
migration preserves existing data. `bun test packages/usage-engine-runtime/src/outbox.test.ts`
→ includes a crash-between-fact-and-outbox test (simulate by failing the
transaction) asserting neither is written.

### Step 4: Ingest, idempotent by construction

`apps/server` gains one authenticated endpoint. It authenticates the **device**
principal (plan 104), then authorizes the capture context through `Authorizer`
(plan 103). Both, in that order, before any write.

Idempotency:

```sql
CREATE TABLE ingest_receipts (
  device_id       uuid NOT NULL,
  idempotency_key text NOT NULL,
  batch_id         text NOT NULL,
  content_hash     text NOT NULL,
  accepted_through_generation bigint NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  counts           jsonb NOT NULL,
  warnings         jsonb NOT NULL,
  PRIMARY KEY (device_id, idempotency_key)
);
CREATE UNIQUE INDEX ingest_receipts_device_batch
  ON ingest_receipts(device_id, batch_id);
```

Compute `content_hash` before the transaction. If
`INSERT … ON CONFLICT DO NOTHING RETURNING` returns no row, load the prior
receipt and compare `batch_id`, `content_hash`, and accepted generation:

- exact match → return the stored bounded ACK fields; do not re-apply;
- any mismatch → return typed `idempotency-conflict`; apply and acknowledge
  nothing.

`counts` and `warnings` use the same bounded runtime schemas as
`ReplicationAck`, so the original/equivalent ACK is reconstructible. The whole
batch — receipt and changes — is one transaction.

`ingest-idempotency.test.ts`:

- the same envelope twice → one set of changes, the same acknowledgement;
- the same envelope **concurrently** → one applied, the other returns the prior
  receipt, no duplicates;
- the same idempotency key with a changed batch ID, generation range, or payload
  hash → `idempotency-conflict`, no changed facts, original receipt untouched;
- a **partially overlapping** batch (some changes already present, some new) →
  new changes applied, existing untouched, no duplicates;
- a revoked device → rejected, and distinguishably from a malformed envelope;
- a capture context naming a Space the device may not publish to → denied, and
  **nothing** written — assert by querying the tables, not by reading the
  response;
- the `self-merge` guard from `usage-merge` (`:36`): a device cannot ingest data
  attributed to another device's identity.

**Verify**: `bun test apps/server/src/ingest-idempotency.test.ts` → all pass.

### Step 5: The outbound-only proof

The program's gate #3 needs a test, not an assertion.

`packages/replication-protocol/src/outbound-only.test.ts`:

- start the local engine composition in a test harness;
- enumerate listening sockets for the process;
- assert the only listener is the existing numeric-loopback control plane
  (`CONTEXT.md:42-46`), and that no listener was added by replication;
- assert the replication client makes only outbound requests, by driving it
  against a stub server and asserting the stub received them.

Also add a static check to `tools/check-package-boundaries.ts`: the retired
`lan-pairing` and `sync` packages (`:52`) are already permanently forbidden —
extend that forbidden list to `apps/server` and the new protocol package so no
future plan can reintroduce peer discovery through a side door.

**Verify**: `bun test packages/replication-protocol/src/outbound-only.test.ts`
→ all pass. `bun run lint` → exit 0.

### Step 6: Two devices, one offline — the program gate

`apps/server/src/two-device.test.ts` is program gate #2, written here because
this is the first plan that can express it:

1. enroll two synthetic devices in one Space;
2. device A publishes generation 1–3, all acknowledged;
3. device A goes offline (stop its client entirely, do not just pause it);
4. device B publishes generation 1–2;
5. the shared read model shows **both** devices' acknowledged data, with
   per-device provenance and freshness;
6. device A's data is labeled with its last-acknowledged time, not hidden and
   not silently presented as current;
7. device A returns and publishes generation 4 → no duplicates, no gap.

Step 6 is the one to get right. ADR 0016/0017 apply directly: stale data is a
**gap with provenance**, never a category and never hidden by a filter default.

**Verify**: `bun test apps/server/src/two-device.test.ts` → all pass.

### Step 7: Retry, backoff, and visible failure

- Exponential backoff with jitter, bounded. A device that has been offline for a
  week must not stampede on reconnect.
- Retries are visible: `attempt_count` and `last_error` on the outbox row, and a
  wide event per publication attempt per `docs/adr/0008-*` and
  `CONTEXT.md:132-135` — one sanitized bounded record at the end of the
  execution, not per-step logging.
- **A permanently failing change is surfaced, never dropped.** Add a
  `blocked` state after N attempts, and show it. Silent drop is the failure mode
  that produces a report which is wrong and looks fine.
- Errors are typed and distinguishable: unreachable, unauthenticated, revoked,
  malformed, rejected-by-policy. The operator's remedy differs for each.

**Verify**: `bun test packages/usage-engine-runtime/src/outbox-retry.test.ts`
→ includes a permanently-failing change reaching `blocked` and appearing in the
status surface.

### Step 8: Connected read model and phased payload

Implement **only phase 1** of the "Data included by phase" section below:
machine facts, usage rows, and provenance. Session content is plan 109 and is
opt-in there.

The connected read shows, per device: last acknowledged generation, last
contact, and pending count. One named TanStack Query policy for
`replication-status` (ADR 0012).

**Verify**: `bun run test:e2e -- e2e/<new-spec>.spec.ts` → passes, axe clean.

### Step 9: Documentation

- `packages/replication-protocol/README.md` — envelope, identity, generation
  semantics, and their relationship to `CONTEXT.md`'s **Source publication**.
- `docs/architecture.md` — the shared data flow gains the outbox → ingest path;
  extend the `apps/usage-engine` ownership block with outbox production.
- ADR 0029's evidence section — cite `check-package-boundaries.ts:52` and this
  plan's outbound-only test.
- `CONTEXT.md` — verify **Replication generation** matches what shipped, and
  that its `_Avoid_` list includes "manual transfer" and "sync cursor".
- `plans/README.md:66` row → `DONE`.

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
