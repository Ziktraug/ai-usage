# Plan 106: Build Authorized Hybrid Memory Search and a Harness-Agnostic MCP Adapter

> **Executor instructions**: Search quality and authorization are joint
> requirements. Build an evaluation corpus before adding embeddings. Start with
> PostgreSQL full-text search plus `pg_trgm`, prove authorization is applied
> before ranking/snippet generation, and add `pgvector` only if the measured
> corpus shows a material semantic-recall gap. MCP is an adapter over Memory
> application services, not an alternate database API.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- packages/memory packages/memory-search packages/authorization packages/postgres-store packages/mcp-adapter apps/server apps/web apps/cli docs/architecture.md docs/adr`
> Re-read plans 103 and 105 and reconcile any schema, permission, or revision
> drift before creating indexes.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — search can leak forbidden resource existence or feed stale,
  low-trust instructions to an agent
- **Depends on**: 103, 105
- **Category**: retrieval, MCP, agent-facing continuity
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

The valuable Agent Memory behavior is not “store every conversation”. It is the
ability for any harness to ask questions such as:

- Have we already tried this architecture?
- Why was LAN pairing removed?
- What constraint applies to this package?
- What command was previously validated and from which directory?
- What is the latest accepted handoff for this project?
- Is the retrieved guidance explicit, harvested, superseded, or contradicted?

The answer must be useful, explainable, bounded, and authorized. A vector match
alone is not enough; a keyword-only system may miss semantic paraphrases; a
post-filtered global search can leak private memory. This plan builds the
retrieval contract and exposes it consistently to Claude, Codex, OpenCode, and
other MCP-capable harnesses.

## Search domain

Search only accepted, addressable projections by default:

- current active Memory Item revisions;
- optionally superseded/rejected history when explicitly requested;
- accepted Handoffs and Work Threads after plan 108;
- bounded Project context projections;
- selected structured facts such as validated commands and constraints.

Pending Proposals and raw Observations require separate permissions and explicit
query modes; they are not mixed into normal agent guidance.

## Chunking model

One Memory Revision may produce one or more bounded `memory_chunks`.

Suggested fields:

```ts
interface MemoryChunk {
  id: MemoryChunkId;
  memoryItemId: MemoryItemId;
  memoryRevisionId: MemoryRevisionId;
  owningSpaceId: SpaceId;
  projectId: ProjectId | null;
  resourceRef: ResourceRef;
  type: MemoryType;
  trust: MemoryTrust;
  sensitivity: Sensitivity;
  ordinal: number;
  title: string;
  text: string;
  structuredTerms: string[];
  contentHash: string;
  indexedAt: Instant;
}
```

Requirements:

- chunks are deterministically derived from an exact immutable revision;
- chunk size/count are bounded and measured;
- commands, titles, summaries, guidance, alternatives, symptoms, and causes can
  receive different searchable weights;
- generated text and observed facts remain distinguishable;
- reindexing an unchanged revision is idempotent;
- changing the chunker or embedding model records a version and supports a
  controlled rebuild;
- superseding/deleting an item removes it from default search immediately and
  eventually/transactionally removes derived indexes according to the chosen
  consistency model.

## Search stages

### Stage 1 — PostgreSQL full-text search

Create weighted `tsvector` input, conceptually:

```text
A: exact title and validated command
B: summary, decision choice, pitfall symptom/cause
C: guidance, alternatives, tags/structured terms
D: bounded supporting text
```

Use GIN indexes and a parser/configuration appropriate for the expected English
and French corpus. The executor must test language behavior instead of assuming
one stemming configuration handles both. A simple per-chunk language flag or a
language-neutral configuration may be preferable initially.

Support Web-search-style query parsing for user/agent inputs while preserving a
literal/exact mode for commands, IDs, error strings, branches, and filenames.

### Stage 2 — `pg_trgm`

Use trigram similarity for:

- misspelled titles and names;
- repository/project aliases;
- short error strings;
- command fragments;
- fuzzy fallback when FTS has weak recall.

Do not run an unbounded similarity scan. Add suitable GIN/GiST indexes and
minimum thresholds measured against the evaluation corpus.

### Stage 3 — structured filters and scoring

Filters:

```text
owning Space
Project or global/person scope
memory type
status/current revision
trust
sensitivity
freshness/revision time
exact IDs/resource references
```

Ranking should be transparent and versioned. The result explains at least:

- matched fields/stages;
- current/superseded status;
- trust;
- Project/Space scope;
- freshness;
- provenance summary;
- whether semantic ranking contributed.

Avoid a single opaque “relevance score” in the UI/API.

### Stage 4 — optional `pgvector`

Only proceed after the lexical benchmark fails a documented semantic class, for
example “outbound-only hub” failing to retrieve “remove LAN peer ports”.

If accepted:

- select a local/self-hostable or privacy-reviewed embedding provider;
- record model name/version/dimension and input hash;
- treat embeddings as sensitive derivatives of their source;
- authorize candidate scope before vector ranking;
- support full re-embedding and mixed-version transition;
- benchmark HNSW/IVFFlat only at realistic corpus size;
- combine lexical and vector results through a documented fusion method such as
  Reciprocal Rank Fusion rather than arbitrary incomparable score addition;
- no external embedding API receives sensitive/private content by default.

`pgvector` absence must not break lexical search.

## Authorization-before-ranking design

The implementation must choose and document one safe strategy.

### Preferred shape

```text
Authorizer list/check + active Space context
        ↓
authorized Space/Project/resource constraints
        ↓
SQL candidate query with those constraints
        ↓
FTS/trigram/vector ranking
        ↓
bounded snippets and provenance
```

For large resource sets, evaluate:

- relation-derived Space/Project constraints that are equivalent to the
  Authorizer model;
- short-lived authorized-scope tables/tokens;
- index partitioning by Space plus Project permission filters;
- batched list-resource cursors.

The design must not reveal forbidden result count, title, snippet, score, or
embedding influence.

Re-check exact resource permission before returning content if the candidate
scope is broader than final item permission. Preserve consistency semantics from
plan 103.

## Search API

Create an application-service interface, not a SQL-shaped query.

```ts
interface MemorySearchQuery {
  principal: PrincipalRef;
  query: string;
  activeSpaceId: SpaceId;
  projectId?: ProjectId;
  types?: MemoryType[];
  statuses?: MemoryStatus[];
  trust?: MemoryTrust[];
  includeGlobal?: boolean;
  limit: number;
  cursor?: string;
}
```

Result:

```ts
interface MemorySearchResult {
  id: MemoryItemId;
  revisionId: MemoryRevisionId;
  title: string;
  summary: string;
  guidance: string[];
  type: MemoryType;
  status: MemoryStatus;
  trust: MemoryTrust;
  sensitivity: Sensitivity;
  projectId: ProjectId | null;
  matchedBecause: MatchExplanation[];
  provenance: BoundedProvenanceSummary[];
}
```

Bounds:

- hard maximum result count;
- hard per-result and total response byte/token estimate;
- bounded snippets/provenance;
- opaque cursor tied to query, principal scope/version, and search index version;
- timeout/cancellation propagated through SQL and authorization work.

## Retrieval evaluation corpus

Create a committed synthetic/generic corpus and questions based on real classes
of problems, without private content.

Required categories:

1. exact decision title;
2. semantic paraphrase with little token overlap;
3. typo/fuzzy project or command;
4. exact error/command lookup;
5. active item superseding an older contradictory item;
6. rejected approach requested as history;
7. global preference versus Project constraint;
8. explicit versus harvest-accepted trust;
9. no relevant memory;
10. forbidden item that would otherwise rank first;
11. French query retrieving English memory and vice versa where required;
12. latest Handoff after plan 108.

For each question record:

- expected relevant IDs;
- acceptable alternatives;
- forbidden/incorrect IDs;
- required status/trust explanation;
- permission fixture;
- expected “no answer” behavior.

Measure top-1/top-k recall, false-positive rate, forbidden-result leakage, query
latency, and response size. Do not introduce embeddings without showing which
cases they improve and which regress.

## MCP adapter

### Ownership

Create `packages/mcp-adapter` only when the first tools are real. It owns:

- MCP server/transport protocol;
- tool schemas and bounded serialization;
- conversion between MCP principal context and application-service calls;
- capability registration;
- sanitized errors and cancellation.

It does not own:

- Memory storage;
- ranking;
- authorization policy;
- Handoff generation;
- harness-specific history parsing.

### Read-only first tool set

```text
memory.search
memory.get
memory.project_context
memory.latest_handoff        # activated after plan 108
```

#### `memory.search`

Inputs: query, optional Project/type filters, bounded limit.

Returns: compact result cards with ID, current revision, title, summary,
guidance, trust, status, matched-because, and provenance references. It does not
return every observation or full revision history.

#### `memory.get`

Exact authorized retrieval by Memory Item ID and optional revision ID. Exact old
revisions require history permission/mode.

#### `memory.project_context`

Returns a bounded composed context:

- active constraints;
- recent accepted decisions;
- relevant pitfalls/patterns;
- validated commands;
- latest active Handoff when available.

It must not dump the entire Project memory. Composition is deterministic and
versioned.

#### `memory.latest_handoff`

Owned by plan 108; this plan reserves the adapter slot and permission contract.

### Proposal tool (gated follow-up in this plan)

`memory.propose` may be enabled only after read-only tools are stable and plan
105 proposal authorization is proven. It creates a pending Proposal; it never
accepts or revises durable Memory directly.

The first MCP release must not expose `accept`, `supersede`, arbitrary SQL, or raw
observation write tools.

## MCP runtime modes

Support the same product in two configurations:

### Local MCP

- harness starts/connects to a local loopback or stdio adapter;
- local operator trust and capability policy apply;
- queries local/shared adapters according to configured mode;
- no shared server credential appears in repository files.

### Connected MCP

- local adapter authenticates as Person/Device using private credentials;
- server performs authorization and search;
- cached/offline fallback behavior is explicit and labels staleness;
- an organization can disable sensitive Memory tools by policy.

Do not expose the shared PostgreSQL directly to a harness.

## Harness-agnostic registration

The tool names and schemas are identical for Claude, Codex, OpenCode, Cursor, and
future clients. Harness-specific work is limited to configuration/projection:

- MCP server command/URL;
- credential reference;
- tool allowlist;
- instructions encouraging search before repeating architecture work.

Reuse the existing Skills/config ownership discipline. Do not hand-edit
unmanaged harness configuration or overwrite Nix-owned projections.

## Prompt-injection and memory safety

Memory content can contain hostile or stale instructions. MCP responses must:

- label memory as retrieved project knowledge, not a system instruction;
- include trust, status, source type, and verification guidance;
- avoid embedding raw untrusted Observation text into default context;
- treat imported/harvested content according to its trust;
- never claim memory overrides source code, tests, or current user instruction;
- truncate/escape content safely for MCP JSON and logs;
- preserve exact command text only where it was accepted as a `command` item.

Add adversarial fixtures where stored text attempts to override the agent’s
system prompt or exfiltrate secrets; the adapter must present it as quoted data
with metadata, not elevate it.

## Web and CLI surfaces

Minimum useful surfaces:

- Web search with Project/Space/type/trust filters and explainable matches;
- exact Memory detail/revision/provenance navigation;
- CLI `memory search` and `memory get` using the same service/result vocabulary;
- no duplicate search algorithm in Web, CLI, or MCP.

Search UI must hide unauthorized filters/counts and pass the existing
presentation/accessibility gates.

## Observability

Measure without logging content:

- query kind and normalized length bucket;
- authorized candidate scope size bucket where safe;
- search stages used;
- result count;
- latency per authorization/lexical/vector stage;
- timeout/partial/error code;
- index and ranking version.

Never log query text, snippets, embeddings, Memory content, or unauthorized
candidate IDs by default.

## Testing requirements

### Search correctness

- FTS weights and exact command behavior;
- trigram typo/fuzzy threshold;
- structured filters/status/trust;
- multilingual cases;
- supersession and contradiction behavior;
- pagination/cursor binding;
- chunk/revision index consistency;
- timeout and cancellation;
- optional vector/RRF benchmark only if enabled.

### Authorization/privacy

- forbidden top candidate never influences returned count/snippet/rank;
- aggregate auditor cannot search Memory;
- Project collaborator sees Project Memory but not personal/global private
  Memory;
- sensitive item extra condition;
- relationship revocation removes access;
- search-service failure is typed and fails closed.

### MCP

- tool discovery respects capability/policy;
- identical schemas across harness fixtures;
- response/result byte bounds;
- malformed inputs and oversized queries;
- cancellation;
- no content in logs/errors;
- prompt-injection fixture remains labelled data;
- read-only tool set cannot mutate durable Memory;
- proposal tool, if enabled, creates pending Proposal only.

### Evaluation gate

- committed corpus runs deterministically;
- baseline metrics are versioned;
- any ranking/index change reports deltas;
- embeddings require a written accept/reject result, not intuition.

## Done criteria

- [ ] Authorized search candidate scope is applied before ranking and snippets.
- [ ] FTS + `pg_trgm` are indexed, bounded, explainable, and benchmarked.
- [ ] A committed retrieval evaluation corpus covers exact, fuzzy, semantic,
      contradiction, no-answer, multilingual, and forbidden-result cases.
- [ ] `pgvector` is either rejected with evidence or introduced with model/index
      versioning, privacy policy, and hybrid fusion tests.
- [ ] Web, CLI, and MCP share one Memory search application service.
- [ ] Read-only MCP tools work through the same schemas for multiple harness
      fixtures.
- [ ] MCP responses expose trust/status/provenance and treat content as data.
- [ ] Search logs and errors contain no query/content/embedding secrets.
- [ ] Supersession/deletion/revision changes update indexes correctly.
- [ ] Local and connected MCP configurations preserve credential ownership and
      offline/staleness semantics.

## STOP conditions

Stop and report when:

- the implementation searches globally and filters unauthorized results after
  ranking;
- forbidden candidates can affect counts, snippets, similarity thresholds, or
  returned rank;
- embeddings require sending private Memory to an external API by default;
- search result schemas omit trust, status, revision, or provenance;
- MCP handlers import Drizzle/PostgreSQL directly;
- the MCP tool can accept or overwrite durable Memory in the first release;
- raw Observations or transcripts are mixed into normal guidance search;
- lexical search is abandoned without a measured evaluation;
- vector index/model changes cannot be versioned and rebuilt;
- a harness-specific tool schema diverges from the shared contract.

## Out of scope

- general document search outside accepted Memory/Handoff domains;
- autonomous memory acceptance;
- public Internet MCP endpoint for arbitrary clients;
- large-scale enterprise search performance beyond a measured growth plan;
- native harness session conversion;
- model routing or inference proxying.
