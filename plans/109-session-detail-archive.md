# Plan 109: Archive Session Detail Safely for Cross-Machine Read-Only Continuity

> **Executor instructions**: Add an opt-in normalized archive, not raw provider
> backup or native session synchronization. The complete shared security
> boundary—organization authorization, GitHub authentication, Device
> enrollment, replication, and connected WorkHandoff—must pass before any
> prompt or turn leaves its source Device.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- packages/local-machine packages/report-core packages/report-data packages/usage-store packages/replication packages/authorization packages/project-registry packages/memory packages/mcp-adapter packages/work-threads apps/usage-engine apps/server apps/web apps/cli docs/architecture.md docs/adr`

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: CRITICAL — prompts, chronology, paths, and outputs may contain code,
  personal data, credentials, or organization-confidential content
- **Depends on**: 103, 104, 107, 108 connected phase
- **Category**: sensitive session archive and cross-machine read continuity
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Existing boundary

Today, report facts may be persisted/ported while detailed session chronology is
read only from an authorized local harness artifact on the source machine.
`packages/local-machine/src/session-detail.ts` and per-harness analyzers own that
bounded local interpretation; `docs/session-analysis-sources.md` owns its
Recorded/Derived/Partial/Estimated/Unavailable quality vocabulary.

This plan deliberately introduces a third authority produced by the source
Device. A server-retrieved path remains opaque and never authorizes local
filesystem access on another Device.

## Authority states

```text
local-observed
  parsed now from an authorized local harness artifact

archived-observed
  bounded normalized detail captured by the source Device under explicit policy

portable-opaque
  metadata exists but no authorized detail authority is available
```

Contracts/UI/MCP expose authority, captured time, parser/archive version,
completeness, redaction/truncation, and limitations. There is no silent fallback
between states and no synthetic reconstruction labeled observed.

## Data classes

### Class A: portable metadata

May replicate under plan 107 policy: Session/Device/harness/Project IDs,
timestamps, usage/model/tool counts, partial flags, authorized branch/commit/PR
metadata, and bounded title under current privacy rules.

### Class B: normalized archive detail

Opt-in: allowed prompt/user-turn text or summaries, normalized turns/phases,
model transitions, tool names/categories and bounded status, token/timing detail,
WorkHandoff-relevant chronology, coverage, truncation, parser warnings, and
source authority. Policy decides each included field.

### Class C: raw local artifacts

Never uploaded by this plan: native JSONL/rollout files, harness SQLite DBs,
terminal/tool output, source file bytes, environment/credentials, full diffs,
provider auth/session state, attachments, or arbitrary binary blobs.

## Archive policy

```ts
interface SessionArchivePolicy {
  readonly mode: "disabled" | "metadata-only" | "normalized-detail";
  readonly includePrompts: "none" | "user-only" | "bounded";
  readonly includeToolNames: boolean;
  readonly includeToolOutputs: "none";
  readonly retentionDays: number | null;
  readonly sensitivity: Sensitivity;
  readonly requireUserConfirmation: boolean;
}
```

- no policy row means no detail capture;
- enabling detail and enabling prompt capture are separate acts; prompts default
  to `none`;
- Project policy may be stricter than Space policy, never broader;
- organization capture requires authorized organization policy;
- Device owner alone cannot opt in organization content;
- policy changes affect future captures; historical deletion is explicit and
  previewed;
- raw tool outputs remain excluded in V1.

## Normalized archive contract

```ts
interface ArchivedSessionDetail {
  readonly archiveVersion: number;
  readonly parserVersion: string;
  readonly sessionFactId: SessionFactId;
  readonly deviceId: DeviceId;
  readonly harnessKey: string;
  readonly sourceSessionId: string | null;
  readonly owningSpaceId: SpaceId;
  readonly projectId: ProjectId;
  readonly capturedAt: Instant;
  readonly sourceObservedAt: Instant | null;
  readonly authority: "archived-observed";
  readonly completeness: "complete" | "partial";
  readonly contentHash: string;
  readonly sensitivity: Sensitivity;
  readonly policyId: SessionArchivePolicyId;
  readonly detail: BoundedNormalizedSessionDetail;
  readonly limitations: readonly ArchivedDetailLimitation[];
}
```

Strict runtime validation enforces turn/prompt/phase/tool counts, per-text and
total decoded bytes, timestamp/model segment counts, decompression ratio/output,
explicit truncation, version compatibility, and exact keys. Capture accepts
only this normalized structure; no raw path content/byte-buffer/native row type
can enter the archive service.

## Capture flow

```text
source Session reaches checkpoint
  ↓ local policy + Authorizer check
bounded local session-detail resolver
  ↓
classification/redaction on source Device
  ↓ optional state-bound preview/confirmation
compress + envelope-encrypt Class B
  ↓ separate archive outbox event
outbound TLS upload
  ↓ Device auth + archive_session_content authorization
PostgreSQL metadata + ciphertext + event receipt transaction
  ↓ ACK exact event/content hash
```

Capture and upload run outside local usage/Memory transactions. Failure never
blocks collection, local detail, Memory, or metadata replication. Archive events
use plan 107's fact/event/content identity and retry semantics, not a generic
blob bypass.

## Redaction and minimization

Before encryption/persistence, remove or block environment values, credential
shapes, bearer headers, `.env` content, connection-string passwords, private
keys, configured project secrets, raw tool output, and unapproved paths/prompts.
Record only redaction rule-set version and content-free findings.

High-confidence secret detection or redaction failure blocks capture locally and
writes no outbox event. Heuristic redaction is not claimed to make arbitrary
transcripts safe.

## V1 encryption model

Use application-level envelope encryption for Class B payloads:

```text
per Space:
  one active data-encryption key (DEK), versioned

deployment:
  key-encryption key (KEK), versioned, supplied outside PostgreSQL
  through typed redacted secret configuration

PostgreSQL:
  wrapped DEKs may be stored
  ciphertext and non-sensitive authorization/listing metadata stay separate
```

Encryption/decryption uses reviewed authenticated encryption and includes Space,
archive ID, revision/version, and key versions as authenticated context. The KEK
is never stored in PostgreSQL, logs, browser payloads, archive metadata responses,
or backups managed only as DB dumps.

### Guarantees and limitations

- envelope encryption protects a leaked database/DB backup when the separately
  managed matching KEK is not also compromised;
- database/disk encryption remains defense in depth;
- deleting active wrapped DEKs prevents current application access to payloads
  using them;
- deleting current keys does **not** guarantee cryptographic erasure of every
  historical backup;
- old backups may remain recoverable while old KEKs and wrapped DEKs are
  retained;
- historical backup deletion follows explicit backup-retention and KEK-rotation
  policy;
- a lost required KEK makes affected archives unrecoverable;
- V1 makes no end-to-end encryption claim: the server application can decrypt
  authorized content.

### Backup, restore, and rotation

Restore requires both:

1. a compatible PostgreSQL backup containing metadata, ciphertext, and wrapped
   DEKs;
2. the matching KEK version supplied through typed secret configuration.

Tests perform backup/restore into an isolated database with the matching KEK,
prove failure with missing/wrong KEK, rotate KEK wrapping without plaintext
content change, rotate a Space DEK through a versioned rewrite, and prove old/new
revisions remain readable according to retention policy.

No recovery-time SLO is claimed in this plan. The tested objective is functional
correctness and documented operator steps. If a deployment needs a time target,
it receives an owned operational objective with measured fixtures rather than an
undefined reference.

## Storage and authorization

Store listing/authorization metadata separately from ciphertext so listing does
not decrypt content. Logical records include archive identity/revision, Session
fact, Space/Project/Device, policy/sensitivity, captured/source time,
completeness/limitations summary, content hash, cipher algorithm/nonce/tag,
DEK/KEK versions, lifecycle, and ciphertext reference.

Distinct permissions remain:

```text
view_session_metadata
view_session_content
archive_session_content
manage_session_archive_policy
purge_session_archive
```

Aggregate auditor has none of the content permissions. WorkHandoff readers do
not automatically gain the source archive. `view_work_handoff` exposes only the
separately reviewed Work handoff and authorized bounded provenance metadata.
Authorization is applied before decryption/snippet generation.

## Search and Memory interaction

Normal Memory search never indexes archive prompts. Initial allowed use is exact
authorized Session retrieval, selected WorkHandoff creation/review, and an
explicit user-triggered Memory Proposal whose provenance names the exact archive
revision. Any later archive search needs separate permission, index, evaluation,
retention, and deletion propagation.

## Retention, deletion, and backups

Lifecycle:

```text
active
scheduled-for-deletion
purged
blocked/quarantined
```

- default is no automatic content deletion unless policy specifies it;
- expiry/purge uses a narrow service principal and previewed authorized action;
- purge removes current ciphertext/blob, accessible cache/snippet/search
  derivatives, and active wrapped-key references as applicable;
- a content-free tombstone may retain provenance and deletion time;
- Session metadata follows its own retention and survives archive purge;
- server replicas/backups have documented retention/deletion limitations;
- key deletion cannot be marketed as guaranteed erasure of historical backups;
- reduced/redacted re-upload cannot resurrect purged content silently.

## Versioning and WorkHandoff relationship

New parser/content hash creates an immutable archive revision or advances a
current pointer transactionally. Duplicate event/content receives idempotent
ACK. A WorkHandoff may reference the exact archive revision used, while exposing
only its separately reviewed statements to ordinary WorkHandoff readers.

The cross-machine archive remains read-only. Continuation uses
`memory.latest_work_handoff`, `work_handoff.get`, and
`work_thread.get_context`; it does not mutate/archive-native session state.

## Local/offline behavior

Local Session detail continues to read local harness history without archive
policy/server. Tests inject an archive connector that fails if called and assert
zero calls. Queued archive upload can survive offline periods; source can cancel
pending-not-ACKed events where plan 107 semantics permit. No global process
inspection is a correctness gate.

## Steps

### Step 1: Implement/test the encryption boundary first

Add typed KEK config, per-Space DEK wrapping, ciphertext/metadata separation,
authenticated context, isolated backup/restore, wrong-key failure, and rotation
tests before production archive tables/routes.

### Step 2: Make Class C unrepresentable

Define normalized classified contracts with no raw byte/file/DB row fields. Add
boundary rules excluding local collectors/private-store writers. Test all four
harness fixtures for forbidden raw substrings.

### Step 3: Add genuinely opt-in policy

Test no-row/no-detail, prompt-off default, stricter Project policy, organization
authorization, non-retroactive enable, and explicit historical deletion.

### Step 4: Redact/encrypt on the source Device

Reuse plan-105 redaction where applicable. Test secret fixtures, rule version,
fail-closed capture, ciphertext-only outbox, and no local collection coupling.

### Step 5: Add transactional upload/retrieval

Use plan 107 event identities and Device auth. Store metadata/ciphertext/wrapped
DEK separately, authorize before decryption, and test exact duplicate/revision,
aggregate denial, metadata-only access, and opaque paths.

### Step 6: Add retention/purge/backup behavior

Prove current payload and derivatives are removed, metadata survives, key
deletion current-access behavior is accurate, and historical-backup limitations
are documented/tested through retained/removed KEK fixtures.

### Step 7: Add cross-machine read UX and docs

Label source Device, capture/source time, authority, completeness,
redaction/truncation, parser/archive/key version, and unavailable/purged states
without existence leakage. Update the session-analysis boundary and encryption
ADR with honest guarantees.

## Verification

- complete plans 103/104/107/108 security gates pass first;
- no Class C raw artifact can enter a contract/outbox/store;
- default policy writes no detail and prompt capture is separately opt-in;
- backup + matching KEK restores; missing/wrong KEK fails; rotations pass;
- tests do not claim current key deletion erases all historical backups;
- no end-to-end encryption or undefined time-to-recover claim remains;
- archive authorization happens before decrypt/snippet/existence response;
- local mode records zero archive/platform calls;
- lint, typecheck, classification/redaction/encryption/lifecycle/e2e pass.

## Done criteria

- [ ] Local, archived, and opaque authority states are explicit.
- [ ] Metadata remains default; normalized detail and prompts are separate opt-in
      decisions.
- [ ] Class C/raw harness artifacts are excluded structurally and by tests.
- [ ] One per-Space DEK is wrapped by an external-config deployment KEK.
- [ ] Restore needs DB backup + matching KEK and rotation is tested.
- [ ] Historical backup/key-deletion limitations and no-E2E claim are explicit.
- [ ] Aggregate roles cannot access/infer content.
- [ ] Purge removes current accessible content/derivatives while metadata
      retention remains separate.
- [ ] WorkHandoff references do not make archives native resumable sessions.

## STOP conditions

Stop and report when:

- raw history/database/tool output is uploaded;
- prompt capture precedes policy/auth/redaction/encryption;
- capture/upload can fail local collection;
- organization content can be enabled by Device owner alone;
- KEK is stored with ciphertext in PostgreSQL;
- docs claim deleting an active key guarantees every backup is unreadable;
- restore is not tested with DB backup + matching KEK;
- encryption is marketed end-to-end;
- authorization occurs after decrypt/snippet generation;
- archive enters normal Memory search or is presented as native resume.

## Out of scope

- raw provider backup/tool-output/file-content archives;
- semantic search across prompts;
- native session import/resume (plan 110);
- remote source-machine fetch;
- legal hold/eDiscovery;
- cross-region encrypted object-store design.
