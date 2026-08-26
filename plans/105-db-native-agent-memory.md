# Plan 105: Migrate Agent Memory From NixOS Files Into a DB-Native Domain

> **Executor instructions**: Migrate behavior and semantics, not the current
> 95-kilobyte script structure. Read the NixOS Agent Memory contract, module,
> script, adapters, and harvest tests before designing tables. PostgreSQL becomes
> the connected source of truth, but the import must be repeatable and must not
> destroy the existing Markdown/JSONL corpus. No automatically harvested content
> becomes durable memory without the existing review/acceptance distinction.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- packages apps/server apps/web apps/cli docs/architecture.md docs/adr`
> Also record the exact source commit in `Ziktraug/nixos` for
> `modules/devtools/ai/agent-memory/`, its contract, and its tests before copying
> any behavior. If that source has changed, re-inventory its commands and record
> formats first.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — memory can encode false instructions, secrets, or stale
  decisions if provenance and trust are weakened
- **Depends on**: 100–104
- **Category**: Agent Memory domain and migration
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

The existing NixOS Agent Memory prototype already proves useful behavior:

- scopes: session, repository, and global;
- durable types: decision, pattern, pitfall, command, constraint, handoff,
  lesson, preference;
- statuses: active, superseded, rejected;
- trust: explicit or reviewed `harvest-accepted`;
- raw captures first, explicit distillation second;
- provenance and guidance intended to change future agent behavior;
- redaction, locking, atomic writes, retention, and dry-run behavior;
- adapters for multiple harnesses.

Its current file topology and single large Bun script are appropriate for a
system-level prototype, but become limiting for:

- stable identity and revisions;
- cross-machine synchronization;
- concurrent proposals and review;
- relationship authorization;
- full-text/fuzzy/semantic search;
- organization and project scopes;
- audited migration and deletion;
- MCP reads and writes through one typed service.

The goal is not to replace useful memory with raw transcripts. It is to preserve
the contract while making the database the authoritative domain model.

## Source inventory gate

Before implementation, produce a checked inventory from the current NixOS
source:

- CLI commands and flags (`append`, `harvest`, `distill`, `recall`, `lint`,
  `doctor`, `sync-adapters`, and any drifted commands);
- global and repository-local paths;
- Markdown frontmatter/content shape;
- inbox JSONL event shape;
- fingerprints/watermarks/retention state;
- lock and atomic-write behavior;
- redaction rules;
- adapter outputs for Claude, Codex/generic, OpenCode, Cursor, and Copilot;
- `memory-distiller` proposal behavior;
- all current shell/integration test scenarios.

Commit this as a dated design input or execution log without copying private
memory content. The importer fixture must use synthetic records.

## Domain layers

```text
Observation plane
  machine/session/user facts; append-only, not durable guidance
        ↓
Proposal plane
  candidate knowledge awaiting explicit acceptance or rejection
        ↓
Memory plane
  stable logical items with immutable revisions and relationships
        ↓
Projection/search plane
  chunks, summaries, exports, MCP responses
```

Do not collapse these layers into one `memories` table with a status flag.

## Core schema

Names may change, but responsibilities must remain explicit.

### `memory_observations`

Append-only evidence from:

- explicit user note;
- agent proposal;
- ai-usage session evidence;
- Git commit/PR/file reference;
- imported inbox event;
- imported durable Markdown.

Suggested fields:

```ts
interface MemoryObservation {
  id: MemoryObservationId;
  owningSpaceId: SpaceId;
  projectId: ProjectId | null;
  captureContextId: CaptureContextId | null;
  sourceKind:
    | "user"
    | "agent"
    | "session"
    | "file"
    | "commit"
    | "pull-request"
    | "import";
  sourceLocator: string | null;
  observedAt: Instant;
  content: StructuredObservation;
  contentHash: string;
  sensitivity: Sensitivity;
  createdByPrincipal: PrincipalRef;
}
```

Rules:

- immutable after acceptance except for cryptographic/redaction remediation with
  an audit trail;
- duplicate hash/locator handling is explicit and idempotent;
- an observation is evidence, not automatically an instruction.

### `memory_proposals`

Candidate durable knowledge:

```ts
interface MemoryProposal {
  id: MemoryProposalId;
  owningSpaceId: SpaceId;
  projectId: ProjectId | null;
  proposedType: MemoryType;
  title: string;
  summary: string;
  guidance: string[];
  structuredContent: unknown;
  trustCandidate: "explicit" | "harvest-accepted";
  status: "pending" | "accepted" | "rejected" | "superseded";
  proposedByPrincipal: PrincipalRef;
  reviewedByPersonId: PersonId | null;
  reviewedAt: Instant | null;
}
```

A proposal references one or more observations through a join/edge table.
Generated proposal text is identified as generated and does not replace source
facts.

### `memory_items`

Stable logical identity:

```ts
interface MemoryItem {
  id: MemoryItemId;
  owningSpaceId: SpaceId;
  projectId: ProjectId | null;
  scope: "project" | "space" | "person";
  type: MemoryType;
  status: "active" | "superseded" | "rejected" | "archived";
  trust: "explicit" | "harvest-accepted";
  sensitivity: Sensitivity;
  currentRevisionId: MemoryRevisionId;
  createdAt: Instant;
  updatedAt: Instant;
}
```

The current contract’s `session` scope remains temporary observation/proposal
state. Durable Session-specific guidance may be represented by a Handoff or
Work Thread rather than a long-lived `session` Memory Item.

### `memory_revisions`

Immutable versions:

```ts
interface MemoryRevision {
  id: MemoryRevisionId;
  memoryItemId: MemoryItemId;
  revisionNumber: number;
  title: string;
  summary: string;
  guidance: string[];
  structuredContent: unknown;
  createdByPrincipal: PrincipalRef;
  createdAt: Instant;
  reason: string | null;
}
```

Rules:

- updates create a revision; they do not overwrite accepted history;
- one transaction creates the revision and advances `currentRevisionId`;
- revision numbers are unique and monotonic per item;
- readers may request current or an exact revision;
- search chunks identify the revision that produced them.

### `memory_edges`

Typed relations:

```text
supports
supersedes
contradicts
derived-from
related-to
applies-to
```

Edges include source/target resource IDs, actor, time, and optional reason.
Supersession updates status and relation atomically but keeps the old item
addressable.

### `memory_chunks`

Searchable units owned by plan 106:

- Memory Item/revision identity;
- bounded text chunk;
- structured fields/tags;
- search vector columns generated from the exact revision;
- optional embedding and embedding-model version later;
- owning Space, Project, sensitivity, and authorization resource identity.

Plan 105 may create the table contract but plan 106 owns ranking/index behavior.

### `memory_imports`

Track repeatable migrations:

```text
source system/repository
source path or logical locator
source content hash
import version
result resource IDs
status and diagnostics
imported_at
```

The same corpus can be scanned repeatedly without creating duplicates.

## Memory type schemas

Preserve existing durable types and add type-specific structured content instead
of putting every behavior in free text.

Examples:

### Decision

```ts
{
  context: string;
  choice: string;
  alternatives: Array<{ option: string; rejectionReason?: string }>;
  consequences: string[];
}
```

### Pitfall

```ts
{
  symptom: string;
  cause: string | null;
  resolution: string[];
  prevention: string[];
}
```

### Command

```ts
{
  command: string;
  cwdRule: string | null;
  purpose: string;
  safetyNotes: string[];
  validatedAt: Instant | null;
}
```

### Handoff

Handoff becomes a dedicated domain in plan 108, but existing imported handoff
files may initially map to Memory Items plus a migration marker, then be upgraded
through a planned migration. Avoid two competing permanent handoff models.

## Application service API

Create a package-level application boundary; Web, CLI, MCP, and jobs use it.

Minimum commands/queries:

```text
recordObservation
createProposal
acceptProposal
rejectProposal
reviseMemoryItem
supersedeMemoryItem
getMemoryItem
listMemoryItems
exportMemory
importMemoryCorpus
```

Every command:

- receives a Principal and owning resource IDs;
- checks authorization through plan 103’s port;
- validates sensitivity and provenance;
- runs transactionally;
- returns a domain result, not a Drizzle row;
- writes an audit event without copying sensitive content.

MCP direct durable write is not enabled in the first vertical slice. An agent may
create a Proposal only when policy allows; acceptance remains an explicit Person
or trusted workflow action.

## Migration from NixOS files

### Import scope

Support synthetic equivalents of:

```text
global memory repository
  durable Markdown by type
  inbox/events.jsonl
  state/watermarks/fingerprints where useful

repository .agent-memory
  durable Markdown
  inbox events
  handoffs
```

### Mapping rules

- frontmatter scope/type/status/trust/provenance maps explicitly;
- imported durable Markdown creates an accepted Memory Item and revision;
- imported inbox event creates an Observation or pending Proposal according to
  source semantics, never accepted guidance by default;
- `session-harvest` retains `harvest-accepted` only when the source record proves
  it passed the existing acceptance flow;
- file path is import provenance, not identity;
- content hash and semantic keys prevent duplicate imports;
- superseded/rejected state and links are preserved where available;
- ambiguous or invalid files are quarantined in an import report and do not
  partially mutate related items.

### Dry run and confirmation

The importer must support:

```text
scan → preview exact effects → confirm using a state-bound proof
```

Reuse the repository’s established preview/confirm discipline rather than a
best-effort bulk import. Preview includes counts, conflicts, invalid entries,
Space/Project destination, sensitivity, and duplicate/supersession effects.

### Source preservation

- never delete or rewrite the NixOS/global/repo memory source during import;
- export a machine-readable mapping report;
- rerunning the importer is idempotent;
- switching the NixOS module to the new runtime is a separate coordinated change
  after parity tests pass.

## Files after migration

Database is authoritative in connected mode. Preserve these adapters:

### Markdown export

- bounded, deterministic, human-readable export by Space/Project/type;
- includes stable IDs, revision, status, trust, sensitivity, and provenance
  summaries;
- no secret-bearing observations unless explicitly authorized;
- export is not watched as a write-back source by default.

### Repository projection (optional later)

A Project may opt into a generated read-only memory summary or adapter block for
harnesses without MCP. The projection is derived, owned, and replaceable; user
files outside its ownership marker are untouched.

### Backup

PostgreSQL backup is the authoritative shared recovery. Markdown export is an
additional portability/review artifact, not a full relational backup.

## Redaction and sensitivity

Port existing redaction tests and strengthen the model:

- secrets never enter searchable text, snippets, audit events, or exports;
- `sensitive` observations/items require separate authorization;
- redaction is applied before persistence where feasible;
- later discovery of a secret supports audited purge/tombstone and search-index
  removal without pretending the original never existed;
- raw prompts are not a default Observation source;
- file/tool outputs require an explicit capture policy.

Do not promise that regex redaction makes arbitrary transcripts safe.

## Retention and deletion

Different resources need different policies:

- pending raw observations/proposals may expire or compact according to Space
  policy;
- accepted Memory Items remain until superseded/archived/deleted by an authorized
  action;
- immutable revisions are retained unless privacy deletion requires purge;
- imports and provenance mappings have bounded operational retention;
- deletion propagates to chunks/embeddings/exports and writes a content-free
  audit tombstone;
- legal/organization retention is outside the first release but schema must not
  make it impossible.

## UI vertical slice

Deliver one useful review workflow in the existing Web app:

```text
Memory proposals
  list pending proposals
  inspect generated content and source observations
  see trust/sensitivity/project/space
  accept, reject, or edit-then-accept

Memory item
  current revision
  revision history
  provenance
  supersession/contradiction relations
```

Do not attempt a complete graph visualization. Follow the presentation gate and
prove sensitive content is not rendered to unauthorized fixtures.

## Testing requirements

### Domain tests

- observations remain evidence, not active guidance;
- accept proposal transaction creates Item + Revision + provenance edges;
- revision update preserves exact old revision;
- supersession status and edge update atomically;
- rejection does not create an active Item;
- trust/sensitivity/provenance invariants;
- unauthorized commands fail before content mutation.

### Import tests

- each existing durable type;
- global/project/session scope mapping;
- explicit versus harvest-accepted trust;
- active/superseded/rejected status;
- JSONL inbox and session-harvest behavior;
- duplicate scan idempotency;
- invalid/partial file quarantined;
- preview/confirm stale proof;
- no source files changed;
- synthetic secret is redacted/rejected and never indexed.

### Persistence tests

- revision monotonicity under concurrency;
- current revision pointer consistency;
- edge foreign keys and cross-Space restrictions;
- transaction rollback leaves no partial Item;
- deletion removes chunks and generated exports as specified;
- Drizzle rows map through runtime validation.

### Compatibility tests

- existing NixOS command scenarios have an equivalent documented path;
- Markdown export round-trips enough semantics for human recovery but is not
  falsely claimed as lossless relational backup;
- local-only mode can retain a local Memory adapter or disable connected Memory
  without breaking Usage/Skills.

## Done criteria

- [ ] Existing Agent Memory behavior is inventoried from a pinned NixOS commit.
- [ ] Observation, Proposal, Item, Revision, Edge, Chunk, and Import ownership is
      explicit in schema and packages.
- [ ] Database is the authoritative mutation surface in connected mode.
- [ ] Existing memory types, status, trust, scope intent, provenance, and
      guidance semantics are preserved.
- [ ] Import is previewed, state-bound, idempotent, non-destructive, and tested.
- [ ] Automatically harvested content cannot become durable memory without the
      accepted review path.
- [ ] Application services are shared by Web/CLI/MCP/jobs and enforce Authorizer.
- [ ] Revision/supersession history is immutable and addressable.
- [ ] Secrets/sensitivity/deletion propagate through storage and search
      projections.
- [ ] Markdown export exists as a portability adapter, not a second source of
      truth.
- [ ] The first proposal-review UI passes authorization and presentation gates.

## STOP conditions

Stop and report when:

- the migration reduces Observations, Proposals, and accepted Memory to one
  mutable text row;
- imported `session-harvest` becomes active guidance automatically;
- the only stable ID is a file path or title;
- source files must be deleted or rewritten to complete migration;
- secret-bearing raw sessions are proposed as default memory input;
- Drizzle row types are exposed directly as MCP/oRPC contracts;
- revision updates overwrite old content;
- authorization is checked only in Web/MCP adapters rather than application
  services;
- DB-native Memory makes the local Usage/Skills product unusable without the
  server;
- a second permanent Handoff model is introduced before plan 108 resolves the
  domain.

## Out of scope

- search ranking and embeddings (plan 106);
- multi-machine replication (plan 107);
- final Handoff/Work Thread product (plan 108);
- native harness session conversion (plan 110);
- automatic memory generation using a hosted LLM;
- organization retention/legal hold;
- public plugin APIs.
