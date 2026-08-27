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

## Current state

### The source is in a different repository — this is the plan's first obstacle

The NixOS agent-memory implementation is **not in this repo and not vendorable
as-is**:

```text
/home/nathan/Projects/Github/nixos/modules/devtools/ai/agent-memory/
├── SKILL.md                     152 lines   (agent-facing instructions)
├── default.nix                              (NixOS module; writes agent-memory-config.json)
├── references/memory-contract.md 91 lines   (the durable data contract)
└── scripts/agent-memory.ts     2909 lines   (the whole CLI)
```

It is surfaced to agents through root-owned symlinks
(`~/.claude/skills/agent-memory/SKILL.md → …/nixos/modules/…`), so it is
machine-provisioned config, not a dependency this repo can add.

Consequences for the inventory gate:

- The gate is a **read of another repository**, and that repository is the
  operator's personal NixOS configuration. Read it; do not modify it; do not
  copy private memory content into this repo.
- `scripts/agent-memory.ts` at 2909 lines is the specification. Prose in
  `SKILL.md` describes intent; the script defines behavior. Where they disagree,
  the script wins and the disagreement is itself an inventory finding.
- The migration is a **one-way import**, not a sync. Plan through the possibility
  that the NixOS module keeps running afterwards.

### The data contract that already exists

`references/memory-contract.md:9-32` defines eight durable entry types and six
required classification fields. This is not a blank slate — it is a contract with
users (the operator's existing memories) and it constrains the schema:

| Contract element | Values |
|---|---|
| Types (`:11-21`) | `decision`, `pattern`, `pitfall`, `command`, `constraint`, `handoff`, `lesson`, `preference` |
| `scope` | `session`, `repo`, `global` |
| `status` | `active`, `superseded`, `rejected` |
| `provenance` | session, file, command, or user-instruction evidence |
| `guidance` | how a future agent should behave differently |
| `trust` | `explicit` \| `harvest-accepted` |

`status: superseded` and `trust` already exist. The plan's revision/provenance
model must **subsume** these values, not replace them — an import that drops
`trust` silently promotes reviewed harvests to explicit knowledge.

### `handoff` now has three meanings — resolve before writing schema

1. `packages/usage-engine-control/src/handoff.ts` (+ 9 files) — a staged file
   passed CLI → engine through an inbox directory.
2. `references/memory-contract.md:18` — a **durable memory entry type**
   ("current state and next actions").
3. Plan 108 — cross-harness work continuity.

All three will coexist in this codebase after 108. Decide the naming here,
because this plan writes the schema that stores meaning 2:

- keep the memory entry type as `handoff` in the **imported data** for fidelity;
- name plan 108's concept **Work handoff** in code and `CONTEXT.md`;
- never name a symbol in `packages/memory` just `Handoff`.

Confirm plan 100 recorded this in `CONTEXT.md`. If it did not, add it here
before the migration runs — renaming after import means rewriting stored rows.

### Known state-management details to inventory

Observed in `scripts/agent-memory.ts`:

- `:96` `fingerprint: string` and `:102` `watermark: number | null` — the
  dedupe/replay mechanism. `:437` carries a comment that matters: *"The watermark
  is diagnostic only: unseen fingerprints stay eligible even when their source
  timestamp is older."* Fingerprint is the identity; watermark is not a cursor.
  An importer that treats the watermark as a cursor will drop records.
- `:355-386` `append` — scope parsing, git-root resolution, target path.
- `:437-450` `distill` — filters observations by unseen fingerprint.
- `:160-166` — `distill`, `recall`, `lint` dispatch.
- `:185-187` — the usage text, which is the fastest authoritative list of flags.
- `.agent-memory/inbox/events.jsonl` — repo-local raw captures; the global memory
  repo has its own `inbox/events.jsonl`.

### `.agent-memory/` in this repository is gitignored

`AGENTS.md` states working notes go to `.agent-memory/` (gitignored), not
`docs/`. So this repo already *is* a consumer of the file-based system. After
migration, that directory must keep working or the operator loses their working
notes — see "Files after migration".

### Prerequisites

Plans 100–104 complete: `CONTEXT.md` memory terms, `postgres-store`,
tenancy with non-nullable `space_id`, the `Authorizer` port, and person/device
principals. Memory is the most sensitive content in the program; do not build it
before the boundary that protects it.

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

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Locate the source | `ls /home/nathan/Projects/Github/nixos/modules/devtools/ai/agent-memory/` | `SKILL.md default.nix references scripts` |
| Command surface | `sed -n '150,200p' <source>/scripts/agent-memory.ts` | the dispatch + usage text |
| Contract | `cat <source>/references/memory-contract.md` | 91 lines |
| Live command list | `agent-memory --help` | the authoritative flags |
| Fixture shape (synthetic only) | `bun tools/memory-inventory.ts --emit-schema` | JSON schema, no content |
| Importer tests | `bun test packages/memory/src/import.test.ts` | all pass |
| Memory domain tests | `bun test packages/memory` | all pass |
| Authorization still conformant | `bun test packages/authorization` | 15/15 |
| Round-trip proof | `bun test packages/memory/src/round-trip.test.ts` | all pass |
| Local regression, no cluster | `! pgrep -x postgres && bun run test:packages` | all pass |
| Full verification | `bun run check && bun run lint && bun run typecheck && bun run test` | exit 0 |

## Git workflow

- Branch `plan/105-db-native-memory`, cut from plan 104's branch.
- Stage by explicit path. Never `git add -A`.
- **Never stage anything under `.agent-memory/`** — it is gitignored, and it
  holds real memory content.
- Five commits:
  1. `docs(plans): record the agent-memory source inventory` (schema only, no content)
  2. `feat(memory): add the observation, proposal, item, and revision schema`
  3. `feat(memory): add application services for propose, accept, revise, supersede`
  4. `feat(memory): add the file importer with synthetic fixtures`
  5. `feat(web): add the memory review vertical slice`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 0: The inventory gate — a real step with a real output

Do not start the schema until this is committed. Produce
`plans/105-source-inventory.md` with:

1. **Command surface** — every command and flag, read from
   `scripts/agent-memory.ts:150-200` **and** cross-checked against
   `agent-memory --help` on the live machine. Where the script and `SKILL.md`
   disagree, record both and mark the script authoritative.
2. **Paths** — global memory repo root, repo-local `.agent-memory/` layout,
   inbox locations, and where `default.nix` writes `agent-memory-config.json`.
3. **Frontmatter shape** — every key, its type, and whether it is optional.
   Derive from the writer in the script, not from a sample file: a sample shows
   what one memory happens to have, not what the format permits.
4. **Inbox JSONL event shape** — same rule.
5. **Fingerprint and watermark semantics** — quote
   `scripts/agent-memory.ts:437` verbatim. This is the single most
   misunderstandable behavior in the source.
6. **Lock and atomic-write behavior** — the importer must not read a
   half-written file.
7. **Redaction rules** already applied at capture, so import does not assume raw
   text is unredacted, or assume it is.
8. **Adapter outputs** for Claude, Codex/generic, OpenCode, Cursor, Copilot.
9. **`memory-distiller` proposal behavior** — the closest existing analogue to
   this plan's proposal plane. If it already encodes an accept/reject decision,
   the new model should match its semantics rather than invent new ones.
10. **Test scenarios** in the source, as the behavioral baseline.

**Privacy rule, absolute**: this document records *shape*, never *content*. No
memory titles, no bodies, no paths that identify projects. `tools/memory-inventory.ts`
must emit schema only — add a test asserting its output contains no value from a
seeded fixture body.

**Verify**: the document exists, `grep` it for any real memory text → nothing.
Commit it before Step 1.

### Step 1: The schema, with four planes and an explicit import ledger

Migration `0005_memory`. The plan's rule "do not collapse these layers into one
`memories` table with a status flag" is enforced by distinct tables:

```text
memory_observations (id, space_id NOT NULL, project_id NULL, device_id NULL,
                     capture_context_id NULL, source_kind, source_locator NULL,
                     fingerprint text NOT NULL, observed_at, payload jsonb,
                     sensitivity, created_by,
                     UNIQUE (space_id, fingerprint))
memory_proposals    (id, space_id NOT NULL, project_id NULL, proposed_by,
                     kind, title, summary, guidance jsonb, structured_content jsonb,
                     trust_candidate, status, reviewed_by NULL, reviewed_at NULL)
memory_proposal_observations
                    (space_id NOT NULL, proposal_id, observation_id,
                     PRIMARY KEY (space_id, proposal_id, observation_id))
memory_items        (id, space_id NOT NULL, project_id NULL, scope, kind, status,
                     trust, sensitivity, current_revision_id NULL,
                     created_at, updated_at)
memory_revisions    (id, space_id NOT NULL, item_id NOT NULL, revision int NOT NULL,
                     title, summary, guidance jsonb, structured_content jsonb,
                     authored_by, authored_at, reason NULL,
                     UNIQUE (space_id, item_id, revision))
memory_relations    (space_id NOT NULL, from_item_id, to_item_id, kind,
                     created_by, created_at, reason NULL)
memory_imports      (id, space_id NOT NULL, source_system, source_locator,
                     source_content_hash, import_version, status, diagnostics jsonb,
                     result_resource_ids jsonb, imported_at,
                     UNIQUE (space_id, source_system, source_locator,
                             source_content_hash, import_version))
```

Details that carry the plan's requirements:

- **`fingerprint` is `UNIQUE (space_id, fingerprint)`** — the source's identity
  mechanism, preserved, and scoped per Space so two Spaces can independently
  hold the same observation.
- **`memory_revisions` is append-only.** No `UPDATE`. Revising writes a new row
  and moves `memory_items.current_revision_id`. Superseding is a
  `supersedes_revision_id` link, never a delete — the plan's "traced to
  observations without deleting history".
- **`trust`** carries the source's `explicit` | `harvest-accepted` forward. Add
  a `CHECK` so an importer cannot invent a third value.
- **`kind`** is the eight types from `memory-contract.md:11-21`, as a `CHECK`
  constraint. If the import finds a ninth, that is a finding for Step 0, not a
  reason to drop the constraint.
- `space_id NOT NULL` on every table, including revision content, relation edges,
  proposal evidence, and import state. Composite foreign keys require every
  referenced item/revision/observation to belong to that same Space; this gives
  plan 103's RLS fence a concrete column and prevents cross-Space edges.
- `project_id` is nullable because memory can be Space-wide.
- **`memory_content` is a separate resource type in plan 103's model** —
  `memory_item` metadata and `memory_revisions.body` are authorized separately.
  Verify `packages/authorization/src/model.ts` already declares both; if it
  declares only one, fix plan 103 rather than working around it here.

**Verify**: `bun test packages/postgres-store/src/migrations.test.ts` → all pass.

### Step 2: Application services, with acceptance as an explicit act

`packages/memory/src/services.ts`:

```ts
recordObservation(input): Effect<ObservationId, MemoryError>        // append-only, idempotent on fingerprint
proposeMemory(input): Effect<ProposalId, MemoryError>
acceptProposal(id, by): Effect<{ itemId; revisionId }, MemoryError> // the only path to a memory item
rejectProposal(id, by, reason): Effect<void, MemoryError>
reviseMemory(itemId, input): Effect<RevisionId, MemoryError>        // new revision, never an update
supersedeMemory(itemId, byItemId): Effect<void, MemoryError>
```

There is **no** `createMemoryItem`. An item exists only via `acceptProposal`, so
"nothing becomes durable guidance without an explicit decision" is structural
rather than procedural. Assert it: a test greps the module's exports for any
other item-creating function.

Every service takes a principal and calls `Authorizer` first. `services.test.ts`
includes a case per operation where the principal lacks permission, asserting
`deny` — and one where the authorizer returns `error`, asserting the operation
fails rather than proceeding.

`recordObservation` is idempotent on `(space_id, fingerprint)`: replaying the
same observation returns the existing ID and writes nothing. This is what makes
re-running an import safe, and plan 107 depends on it.

**Verify**: `bun test packages/memory/src/services.test.ts` → all pass.

### Step 3: The importer, on synthetic fixtures only

`packages/memory/src/import.ts` reads the file format inventoried in Step 0.

Fixtures live in `packages/memory/test-fixtures/` and are **written by hand**,
never copied from real memory. Cover:

- one file per `kind`, all eight;
- `status: superseded` → imports as a superseded revision chain, not a dropped
  file;
- `status: rejected` → imports as a rejected **proposal**, not an item. This is
  the mapping most likely to be got wrong, and getting it wrong resurrects
  knowledge the operator explicitly rejected;
- `trust: harvest-accepted` → preserved verbatim;
- a repo-scoped memory whose repo maps to a plan 102 project → attached;
- a repo-scoped memory whose repo maps to **nothing** → imported at Space scope
  with an explicit unresolved marker. Never dropped, never guessed;
- `scope: session` → **not imported**. Session scope is by definition not
  durable. Assert the count is zero rather than letting it pass silently;
- an inbox JSONL event → an observation, with fingerprint preserved;
- the same file imported twice → no duplicates (fingerprint idempotency);
- a malformed frontmatter file → a typed error naming the file, and the rest of
  the import proceeds. A whole-import abort on one bad file is unusable against
  a real corpus.

**Dry-run first**: `import --dry-run` prints counts per kind, per outcome, and
per unresolved reason, writing nothing. This is what the operator will actually
run first, and it must be trustworthy.

**Verify**: `bun test packages/memory/src/import.test.ts` → all pass, including
the zero-session-imports assertion.

### Step 4: Round-trip, because export is the safety net

`packages/memory/src/export.ts` writes the file format back.
`round-trip.test.ts`: import every fixture, export, and compare to the original —
allowing only differences the inventory explicitly documents as lossy, each one
listed in the test as a named exception with a reason.

If the exception list grows past a handful, the schema is losing information;
stop and fix the schema. This test is the reason the operator can run the
migration without fear, so let it be strict.

**Verify**: `bun test packages/memory/src/round-trip.test.ts` → passes with a
short, named exception list.

### Step 5: Files after migration — decide and document

The NixOS module keeps existing. State the post-migration contract explicitly in
`packages/memory/README.md`:

- the database is authoritative for **mutation** (ADR 0025);
- export produces files for backup, inspection, and air-gapped reading;
- `.agent-memory/` in a repository stays a working-notes directory and is
  **not** synchronized. It is gitignored and stays that way;
- the NixOS CLI is not modified by this plan. Whether it later becomes a client
  of the database is out of scope — say so, so the next reader does not assume
  it was overlooked.

**Verify**: `.agent-memory/` still works; `git status --porcelain .agent-memory`
→ empty (still ignored).

### Step 6: Redaction and retention

- Redaction runs at **capture**, before storage, and the applied rule set is
  recorded per record so a later rule change is auditable.
- Deletion is real deletion of `memory_revisions` bodies, with the item and its
  provenance chain retained as tombstones. "Deleted" that only hides a row is
  not deletion; assert the body is gone by querying the table directly after.
- Retention policy is per Space and defaults to **no automatic deletion**. A
  default that silently expires memory would defeat the product's purpose.

**Verify**: `bun test packages/memory/src/retention.test.ts` → deletion removes
the body and preserves the chain.

### Step 7: The review vertical slice

One surface: the proposal queue. List pending proposals, show the observation
behind each, accept or reject with a reason.

- ADR 0010/0012: contract-only browser imports, one named Query policy for
  `memory-proposal-queue`.
- Presentation gate (`plans/README.md:268`) and axe.
- Rejecting requires a reason — it becomes provenance for why an approach was
  turned down, which is one of the program's stated use cases.

**Verify**: `bun run test:e2e -- e2e/<new-spec>.spec.ts` → passes, axe clean.
On NixOS set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; `--channel chrome` fails here.

### Step 8: Documentation

- `packages/memory/README.md` — four planes, the append-only rule, import/export,
  the post-migration file contract.
- `CONTEXT.md` — verify plan 100's memory terms match what shipped; add the
  `handoff` disambiguation if 100 did not.
- `docs/architecture.md` `## Package ownership` — a `### @ai-usage/memory` block.
- `plans/README.md:66` row → `DONE`.

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
