# Plan 105: Migrate Agent Memory From NixOS Files Into a DB-Native Domain

> **Executor instructions**: Preserve the existing Agent Memory semantics, not
> its monolithic script structure. Inventory the NixOS implementation at a
> pinned source commit before designing adapters. Implement the same domain and
> application-service interfaces over dedicated local SQLite and shared
> PostgreSQL. Do not wait for full organization ReBAC or authentication to prove
> local single-user value.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- packages apps/server apps/web apps/cli apps/usage-engine docs/architecture.md docs/adr`
> Also record the exact `Ziktraug/nixos` source commit for
> `modules/devtools/ai/agent-memory/` and re-inventory it on drift.

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — Memory can encode false instructions, secrets, or stale
  decisions if provenance and trust are weakened
- **Depends on**: 100, 101, 102
- **Category**: local/shared Agent Memory domain and migration
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Plan status**: IN PROGRESS — implementation exists outside `main`, pending
  integration

## Locked topology

```text
Local/offline
  dedicated Memory SQLite authority
  same Memory application services
  SingleUserAuthorizer
  local FTS5 (plan 106)
  local MCP (plan 106)
  durable replication outbox

Connected/shared
  PostgreSQL authority for published/shared Memory
  same Memory application services
  full Authorizer when plans 103/104 are present
  shared PostgreSQL search (plan 106)
```

The database is authoritative in both modes. Markdown and JSONL are
import/export/projection formats, never mutation authority. Local Memory is
available without a server, account, network, or PostgreSQL.

One local process owns write-capable access to the dedicated Memory SQLite
store. Prefer composing it in the existing supervised local runtime. Web, CLI,
and MCP call application services and never open independent write-capable
connections. Any local Memory service/IPC seam is separately named and bounded;
it does not broaden the existing report-less usage-engine control plane.

The NixOS Agent Memory remains the migration source and temporary compatibility
implementation until parity is demonstrated. Afterwards `.agent-memory/`
remains an optional working-notes/import/export surface, not the canonical DB.

## Existing source contract to preserve

The baseline NixOS implementation lives outside this repository:

```text
modules/devtools/ai/agent-memory/
  SKILL.md
  default.nix
  references/memory-contract.md
  scripts/agent-memory.ts
```

Inventory shape only; never copy private Memory content. The current contract
contains:

- kinds: `decision`, `pattern`, `pitfall`, `command`, `constraint`, `handoff`,
  `lesson`, `preference`;
- scopes: `session`, `repo`, `global`;
- statuses: `active`, `superseded`, `rejected`;
- trust: `explicit`, `harvest-accepted`;
- provenance and guidance;
- append/harvest/distill/recall/lint/doctor/adapter behavior;
- fingerprint deduplication and a diagnostic watermark. The watermark is not a
  cursor; unseen older fingerprints remain eligible;
- locks, atomic writes, redaction, retention, dry run, and adapters.

The implementation script defines behavior where prose disagrees. Record the
source commit, command/flag schema, frontmatter/JSONL schema, fingerprint and
watermark semantics, path/layout, redaction, locks, adapter output, and synthetic
test scenarios in this plan's execution log or the Memory package README. Do
not create another numbered plan.

## Handoff vocabulary

The following remain distinct:

1. `UsageEngineHandoff*`: existing staged CLI-to-engine file transport;
2. imported Memory `kind: "handoff"`: legacy record type retained exactly for
   import fidelity;
3. `WorkHandoff*`: plan 108's cross-harness continuity domain.

Do not create a bare new `Handoff` TypeScript symbol in the Memory package. The
legacy kind is a data value, not the future Work handoff schema.

## Domain layers

```text
Observation
  append-only evidence, not active guidance
      ↓
Proposal
  candidate knowledge awaiting review
      ↓ accept/reject
Memory Item
  stable accepted logical identity
      ↓ revise/supersede
Memory Revision + relations
      ↓
Search/export/replication projections
```

Do not collapse these layers into one mutable `memories` table.

## Domain contracts

### Observation

```ts
interface MemoryObservation {
  readonly id: MemoryObservationId;
  readonly owningSpaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly captureContextId: CaptureContextId | null;
  readonly sourceKind: "user" | "agent" | "session" | "file" | "commit" | "pull-request" | "import";
  readonly sourceLocator: string | null;
  readonly fingerprint: string;
  readonly contentHash: string;
  readonly observedAt: Instant;
  readonly content: StructuredObservation;
  readonly sensitivity: Sensitivity;
  readonly createdByPrincipal: PrincipalRef;
}
```

Observations are immutable evidence. Fingerprint makes repeated import/capture
idempotent inside a Space. Raw prompt/tool/file content is never a default
Observation source.

### Proposal

```ts
interface MemoryProposal {
  readonly id: MemoryProposalId;
  readonly owningSpaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly proposedKind: MemoryKind;
  readonly title: string;
  readonly summary: string;
  readonly guidance: readonly string[];
  readonly structuredContent: unknown;
  readonly trustCandidate: "explicit" | "harvest-accepted";
  readonly status: "pending" | "accepted" | "rejected" | "superseded";
  readonly proposedByPrincipal: PrincipalRef;
  readonly reviewedByPersonId: PersonId | null;
  readonly reviewedAt: Instant | null;
}
```

Generated proposal text is labelled and links to one or more observations.
There is no autonomous acceptance.

### Item and revision

```ts
interface MemoryItem {
  readonly id: MemoryItemId;
  readonly owningSpaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly scope: "project" | "space" | "person";
  readonly kind: MemoryKind;
  readonly status: "active" | "superseded" | "rejected" | "archived";
  readonly trust: "explicit" | "harvest-accepted";
  readonly sensitivity: Sensitivity;
  readonly currentRevisionId: MemoryRevisionId;
}

interface MemoryRevision {
  readonly id: MemoryRevisionId;
  readonly memoryItemId: MemoryItemId;
  readonly revisionNumber: number;
  readonly title: string;
  readonly summary: string;
  readonly guidance: readonly string[];
  readonly structuredContent: unknown;
  readonly createdByPrincipal: PrincipalRef;
  readonly createdAt: Instant;
  readonly reason: string | null;
}
```

Updates append an immutable revision and advance the current pointer in one
transaction. Exact revisions remain addressable. `supports`, `supersedes`,
`contradicts`, `derived-from`, `related-to`, and `applies-to` relations retain
actor/time/reason and cannot cross Space.

Session-scope legacy records are imported according to the pinned source
semantics: temporary evidence becomes Observation/Proposal rather than a durable
Item unless the source proves prior acceptance. A legacy `kind: "handoff"`
record may become an accepted Memory Item for fidelity; it is never converted
silently into `WorkHandoff`.

## Persistence ports and adapters

Application services depend on explicit ports such as:

```ts
interface MemoryRepository {
  recordObservation(...): Promise<MemoryObservationId>;
  createProposal(...): Promise<MemoryProposalId>;
  acceptProposal(...): Promise<{ itemId: MemoryItemId; revisionId: MemoryRevisionId }>;
  rejectProposal(...): Promise<void>;
  reviseItem(...): Promise<MemoryRevisionId>;
  supersedeItem(...): Promise<void>;
  getItem(...): Promise<MemoryItemResult>;
  listItems(...): Promise<MemoryItemPage>;
}
```

The local SQLite and shared PostgreSQL adapters pass the same service contract
and conformance tests. Storage rows never become public/MCP/oRPC types.

Logical tables in each adapter cover:

```text
memory_observations
memory_proposals
memory_proposal_observations
memory_items
memory_revisions
memory_relations
memory_imports
replication_outbox_events      local adapter, consumed by plan 107
```

Plan 106 owns FTS/index tables. Each adapter enforces Space identity, immutable
revisions, monotonic unique revision numbers, fingerprint/import idempotency,
cross-Space relation rejection, and transactional current pointers.

The local Memory SQLite schema includes only the plan-102 local identity kernel
and these Memory/outbox tables; it does not copy organization/auth tables.

## Application services

The first service surface is:

```text
recordObservation
createProposal
acceptProposal
rejectProposal
reviseMemoryItem
supersedeMemoryItem
getMemoryItem
listMemoryItems
previewMemoryImport
confirmMemoryImport
exportMemory
```

There is no public `createMemoryItem`; acceptance is the only item-creation
path. Every command accepts a Principal, calls `Authorizer`, validates
Space/Project/sensitivity/provenance, runs transactionally, and writes a
content-free audit event.

Local services use `SingleUserAuthorizer`. Shared services compose the same port
with plan 103's adapter when available. Plan 105 does not invent provisional
route-level auth while waiting for plan 103.

MCP durable writes are not enabled here. Plan 106 may expose a proposal command
only after read tools; acceptance remains a Person/trusted workflow act.

## Import and compatibility

### Import mapping

- durable accepted Markdown creates Item + first Revision with status/trust;
- rejected legacy knowledge creates a rejected Proposal, never an active Item;
- inbox/harvest records become Observations or pending Proposals unless the
  source proves the existing acceptance path;
- `harvest-accepted` remains distinct from `explicit`;
- file path is provenance, never identity;
- fingerprint/content/import ledger makes repeated scans idempotent;
- superseded/rejected relationships are preserved;
- invalid/ambiguous entries are quarantined in a bounded report without partial
  related mutations;
- Project resolution uses plan 102 and never guesses organization ownership.

### Preview/confirm

Import is `scan → preview exact effects → confirm with state-bound proof`.
Preview contains counts, conflicts, invalid records, destination Space/Project,
sensitivity, duplicate and supersession effects. Confirmation fails stale when
source or destination state changes.

### Source preservation and parity

- never delete or rewrite the NixOS/global/repository source during import;
- write a machine-readable mapping report without private content in repo;
- reruns are idempotent;
- keep the NixOS implementation active/available until local SQLite and shared
  PostgreSQL adapters, export, search/MCP, and representative command parity
  pass;
- switching NixOS adapters is a separate coordinated action after parity.

## Files after migration

- deterministic bounded Markdown/JSONL export includes stable IDs, revisions,
  status, trust, sensitivity, and bounded provenance;
- export is never watched as an implicit write-back source;
- `.agent-memory/` stays gitignored and usable for optional working notes and
  explicit import/export;
- optional harness projections are derived/replaceable and respect existing
  projection locks/unmanaged entries;
- SQLite backup is local Memory recovery; PostgreSQL backup is shared recovery;
  Markdown export is portability/review, not a relational backup.

## Replication policy boundary

Plan 105 writes durable local outbox events for policy-eligible local changes,
but does not transmit them. Plan 107 owns transport, authentication, server
apply, ACK, retry, and compaction.

Eligible categories may include accepted Items/revisions, reviewed Proposals,
policy-selected Observations, relations, and later Work handoffs. Raw prompts,
unreviewed harvests, secrets, and arbitrary files are excluded. The outbox
preserves logical fact identity, publication event identity, and content hash as
specified by plan 107.

## Redaction, retention, and deletion

- redaction/classification occurs before persistence when feasible and records
  rule-set version;
- secrets never enter search text, snippets, audit events, or normal exports;
- heuristic redaction is not claimed safe for arbitrary transcripts;
- pending evidence/proposals may use explicit policy retention;
- accepted Items default to no automatic deletion;
- privacy deletion purges content/search/export/replication derivatives and
  leaves only a content-free audit tombstone where permitted;
- immutable history is not used as an excuse to retain forbidden content.

## Product vertical

Deliver one proposal-review workflow through the same services in local mode
first: list pending, inspect source/provenance/trust/sensitivity, accept,
edit-then-accept, or reject with reason. A connected adapter can render the same
contract later. Follow oRPC/Query/accessibility/presentation boundaries.

## Steps

### Step 0: Inventory the NixOS source

Record the pinned commit and schema/behavior inventory without content. Compare
script help/dispatch, contract prose, adapters, and tests. Resolve discrepancies
before schema work.

### Step 1: Define domain contracts and adapter conformance

Define Observation/Proposal/Item/Revision/relation/import contracts and one
adapter-independent conformance suite. Include `SingleUserAuthorizer` cases and
the three handoff meanings.

### Step 2: Implement the dedicated local SQLite adapter

Add the local identity kernel, Memory schema, sole-writer lock/lifecycle,
application-service composition, outbox event schema, and backup behavior. Prove
local use with no platform/account/network call.

### Step 3: Implement the shared PostgreSQL adapter

Add equivalent shared tables/mappings behind the same ports. Tenant constraints
and adapter validation are present even though the local product proof does not
wait for full organization/auth rollout.

### Step 4: Implement services and review workflow

Make acceptance the only Item creation path. Test deny/error before mutation,
concurrency, revision/supersession, content-free audit, and local review UI.

### Step 5: Implement import, preview/confirm, and round-trip export

Use synthetic fixtures for every legacy kind/status/trust/scope, including
legacy `kind: "handoff"`. Import twice, test stale preview, no source mutation,
and a documented short list of intentional round-trip losses.

### Step 6: Prove compatibility and migration exit

Compare representative NixOS commands/adapters with new services. Keep the
source implementation until parity gates pass. Document `.agent-memory/` as
optional notes/import/export afterward.

## Verification

- source inventory pins a NixOS commit and contains no private values;
- identical service conformance passes SQLite and PostgreSQL adapters;
- local Memory records zero platform connection calls;
- no second local writer connection exists;
- import is idempotent, preview-bound, non-destructive, and preserves trust;
- no bare cross-harness `Handoff` type appears;
- redaction/deletion propagates to projections/outbox;
- `bun run lint`, typecheck, package tests, and review-surface e2e pass.

## Done criteria

- [ ] Local SQLite and shared PostgreSQL are authoritative in their respective
      modes behind the same domain/services.
- [ ] Local Memory works without server/account/network/PostgreSQL.
- [ ] Observation, Proposal, Item, Revision, relation, import, and outbox
      ownership is explicit.
- [ ] Existing kinds/status/trust/provenance/guidance semantics are preserved.
- [ ] Automatic harvest never becomes durable guidance without acceptance.
- [ ] Import/export is previewed, idempotent, non-destructive, and synthetic-test
      backed.
- [ ] NixOS compatibility remains until demonstrated parity.
- [ ] `.agent-memory/` is optional notes/import/export, not canonical DB.

## STOP conditions

Stop and report when:

- local Memory is made dependent on PostgreSQL or full ReBAC/auth;
- SQLite and PostgreSQL use different domain/service contracts;
- Web/CLI/MCP opens an independent write-capable Memory SQLite connection;
- NixOS source files must be deleted/rewritten;
- harvested/rejected content becomes accepted guidance automatically;
- legacy `kind: "handoff"` is silently converted to `WorkHandoff`;
- revision history is overwritten;
- authorization lives only in adapters/routes;
- raw sessions/secrets become default Memory input.

## Out of scope

- search ranking/indexes/MCP transport (plan 106);
- connected transport/ACK/retry (plan 107);
- WorkHandoff domain (plan 108);
- session archives/native conversion;
- hosted LLM generation or public plugin APIs.

## Pending-integration execution log — 2026-08-30

This evidence was produced by implementation work outside `main`. It records
what is ready to integrate, but it does not satisfy this plan's `DONE` status
until the implementation and its gates are present on `main`.

- Inventoried the external NixOS implementation at commit
  `71915d4566dd1079ec4fa8bd14666d59e4e1bbef`. The command/flag, Markdown,
  JSONL, fingerprint/watermark, layout, redaction, lock, adapter, and synthetic
  scenario inventory is recorded without private content in
  `packages/memory-service/README.md`.
- Added one storage-independent Memory domain/application surface plus shared
  conformance over the dedicated local SQLite authority and PostgreSQL. The
  portable `authorization-contract` keeps Web and other transport consumers
  free of authorization implementation dependencies; complete scopes are
  materialized before proposal, item, or export content reads.
- Composed the local sole writer in `apps/usage-engine`, including the bounded
  authenticated numeric-loopback Memory service, private rendezvous, durable
  outbox, non-replacing owner-only coherent backup, and a zero-platform-call
  local-independence gate.
- Delivered the local Web proposal-review vertical: provenance, trust and
  sensitivity inspection, accept, edit-then-accept, and reject through oRPC and
  TanStack Query, with SSR, accessibility, and browser coverage.
- Implemented bounded synthetic legacy/native import as
  scan/preview/state-bound-confirm, durable idempotency, quarantine without
  partial content mutations, deterministic Markdown/JSONL export, and privacy
  purge through content, relations, authorization rows, and unsent outbox
  derivatives. The content-free mapping is
  `packages/memory-service/migration-mapping.json`.
- The documented intentional re-import losses are limited to collapsing
  historical exported revisions into one current import revision, collapsing
  person scope to Space scope, omitting non-supersession relations, and
  representing rejected exported items as rejected proposals. Stable accepted
  identities, current content, kind, status, trust, sensitivity, supersession,
  and bounded provenance remain portable.
- Verification passed: formatting/lint/type coverage, all package/tool tests,
  41 real PostgreSQL tests, identical SQLite/PostgreSQL Memory conformance,
  local independence with zero platform/authentication factory calls, build,
  client-manifest and bundle guards, production startup, dev/build isolation,
  and 181 Playwright tests. Authorization scope materialization measured
  p95 4.815 ms on the plan-103 reference workload, below its 150 ms trigger.
- The NixOS source remains active and untouched. Compatibility is deliberately
  retained until plan 106 supplies search/MCP and the remaining representative
  command/adapter parity; no adapter switch or source deletion happened here.
