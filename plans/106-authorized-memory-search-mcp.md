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

## Decision this plan closes: embeddings, and when

The program forbids requiring `vector` until "an evaluation justifies it"
(plan 101), and this plan lists vector search as Stage 3. Left as written, an
executor either adds pgvector speculatively or skips it silently.

**Decision: ship Stages 1 and 2 only — PostgreSQL full-text plus `pg_trgm`.
Build the evaluation corpus first, and gate Stage 3 on a measured recall
failure.**

### Why this ordering

The queries this product must answer are largely *lexical*: "did we already
solve this error string", "what did we decide about the outbox", "which command
was validated for X". Titles, commands, error strings, and identifiers are
exactly where FTS and trigram are strong and where embeddings add little. The
corpus is also small — an operator's accumulated memory, thousands of records,
not millions.

Embeddings additionally introduce a dependency the program has not otherwise
taken: an embedding model, either a network call per record (contradicting
"no provider credentials") or a locally-hosted model (a new runtime component).
That cost is worth paying against evidence, not in anticipation.

### The gate

Build the evaluation corpus (Step 1) **before** the search implementation. Add
pgvector only when, on that corpus:

- **recall@10 for the hybrid FTS+trigram ranker is below 0.8** across the query
  set, **and**
- the failures are concentrated in paraphrase queries (semantically equivalent,
  lexically disjoint) rather than in tuning problems — weights, stemming
  configuration, or trigram thresholds.

The second clause matters. Most early recall failures are configuration, and
reaching for embeddings first hides them permanently behind a heavier mechanism.

If the gate fires, pgvector goes into its own migration and its own plan, and
`vector` becomes a documented extension requirement in
`packages/postgres-store/README.md`.

Record the measured recall in the ADR either way.

### Language configuration — decide by measurement, not by default

The plan notes the corpus is English and French. Do not assume one stemming
configuration serves both. Step 1's corpus must contain French queries against
French records, and the choice between per-chunk language tagging and the
`simple` (language-neutral) configuration is made on that measurement.

Default if the measurement is inconclusive: **`simple`**, plus trigram. It
under-stems rather than mis-stems, and mis-stemming across two languages
produces failures that look random and are very hard to debug later.

## Search domain

Search only accepted, addressable projections by default:

- current active Memory Item revisions;
- optionally superseded/rejected history when explicitly requested;
- accepted Handoffs and Work Threads after plan 108;
- bounded Project context projections;
- selected structured facts such as validated commands and constraints.

Pending Proposals and raw Observations require separate permissions and explicit
query modes; they are not mixed into normal agent guidance.

## Current state

### No MCP server exists in this repository

`grep -rn "modelcontextprotocol\|mcp" package.json packages/*/package.json
apps/*/package.json` → no output. This plan introduces the first one.

### The projection discipline to reuse

`packages/skills` already solves "write configuration into harness-owned
directories without clobbering what the harness or Nix owns":

- `packages/skills/src/projection-lock.ts:20,44` —
  `projectionLockIdentityForTarget` and `withSkillProjectionLock`, a
  cooperating-process lock taken before mutating a target.
- `CONTEXT.md:112-119` — **Projection** ("a plan captures target identity;
  application revalidates it under a cooperating-process lock before mutation")
  and **Unmanaged runtime entry** ("reported for consolidation but never
  overwritten automatically").
- `packages/skills/package.json:6-11` — the `.`/`application`/`config`/`shared`
  export split.

MCP registration is the same problem: writing a server entry into
`~/.claude/…`, `~/.config/opencode/…`, or a Cursor config that may be
root-owned Nix-managed symlinks — as
`~/.claude/skills/agent-memory/SKILL.md` demonstrably is.

**Reuse `withSkillProjectionLock` and the unmanaged-entry rule rather than
writing a second config-projection mechanism.** If the lock is too
skills-specific to reuse directly, extract it — do not fork it.

### Authorization is a prerequisite, and scenario #13 already exists

Plan 103 Step 3 requires golden scenario #13: *"search candidate scope excludes
forbidden resources before ranking"*. That scenario was written **for this
plan**. Extend `SCENARIOS` in `packages/authorization/src/conformance.ts` here;
do not start a second matrix.

If `packages/authorization/src/conformance.ts` has no scenario #13, stop — the
authorization boundary this plan depends on was not finished.

### Prerequisites

- Plan 103: `Authorizer`, `listResources` with opaque cursors, conformance suite.
- Plan 105: `memory_items`, `memory_revisions`, and the separate
  `memory_content` resource type in `packages/authorization/src/model.ts`.

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

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite: scenario #13 exists | `grep -c "candidate scope" packages/authorization/src/conformance.ts` | ≥ 1 |
| Prerequisite: content type declared | `grep -c "memory_content" packages/authorization/src/model.ts` | ≥ 1 |
| Evaluation corpus | `bun tools/memory-search-eval.ts` | prints recall@k and MRR per query class |
| Search tests | `bun test packages/memory-search` | all pass |
| Leak tests | `bun test packages/memory-search/src/no-leak.test.ts` | all pass |
| MCP adapter tests | `bun test packages/mcp-adapter` | all pass |
| MCP over stdio, by hand | `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \| bun packages/mcp-adapter/src/stdio.ts` | tool list, no secrets |
| Authorization conformance | `bun test packages/authorization` | all scenarios pass |
| Local regression, no cluster | `! pgrep -x postgres && bun run test:packages` | all pass |
| Full verification | `bun run check && bun run lint && bun run typecheck && bun run test` | exit 0 |

## Git workflow

- Branch `plan/106-memory-search-mcp`, cut from plan 105's branch.
- Stage by explicit path. Never `git add -A`.
- Four commits:
  1. `test(memory-search): add the retrieval evaluation corpus and harness`
  2. `feat(memory-search): add authorized full-text and trigram search`
  3. `feat(mcp-adapter): add the harness-agnostic memory tools`
  4. `docs(adr): record the search stack decision with measured recall`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: The evaluation corpus, before the search

`tools/memory-search-eval.ts` plus `tools/fixtures/memory-search-corpus.json`.
Synthetic records only — same privacy rule as plan 105 Step 0.

The corpus needs at least 5 query classes, because they fail differently:

| Class | Example | What it tests |
|---|---|---|
| exact identifier | `USAGE_STORE_SCHEMA_VERSION` | literal mode, no stemming |
| error string | `SQLITE_BUSY: database is locked` | punctuation and trigram fallback |
| paraphrase | "why did we drop peer sync" vs a record saying "LAN pairing removed" | **the embedding gate** |
| misspelling | `postgrez outbox` | trigram thresholds |
| French | "pourquoi le cache est invalidé" against a French record | language configuration |

Report recall@1, recall@10, and MRR **per class**. An aggregate number hides
exactly the paraphrase weakness the gate depends on.

Include **negative** cases: queries whose only good match sits in a Space the
principal cannot read. The expected result is that the record does not appear
and the reported total does not change — these become the leak tests in Step 3.

**Verify**: `bun tools/memory-search-eval.ts` runs against a seeded cluster and
prints the table. It will report poor numbers before Step 2; that is the point.

### Step 2: Authorized search, with the scope query first

`packages/memory-search/src/search.ts`. The order in the plan's "Preferred
shape" is the implementation order, and it is not negotiable:

```ts
export const searchMemory = (query: MemorySearchQuery, principal: PrincipalRef) =>
  Effect.gen(function* () {
    // 1. Authorization FIRST. Never a post-filter.
    const scope = yield* authorizer.listResources({
      principal, permission: 'read', resourceType: 'memory_item', limit: query.scopeLimit,
    });
    if (scope.kind === 'error') return yield* Effect.fail(new SearchUnavailable(scope.error));
    // 2. Candidates constrained to `scope`, then ranked.
    …
  });
```

Two rules with tests attached:

- **The ranking query takes the authorized scope as a bound parameter.** Assert
  by inspecting the generated SQL in a test: it must contain the scope
  constraint. A ranking query that scores everything and filters after is the
  defect this plan exists to prevent, and it is invisible in behavior until
  someone counts results.
- **When `scope` is truncated by `limit`**, the response says so explicitly.
  Silent truncation of an authorization scope is a correctness bug, not a
  performance trade-off. `CONTEXT.md:80-83` already sets this precedent — the
  focused report result "reports exact omission counts".

Stage 1 (weighted `tsvector`, GIN) and Stage 2 (`pg_trgm`, threshold from Step 1)
per the sections below. `pg_trgm` is already provisioned by plan 101.

**Verify**: `bun tools/memory-search-eval.ts` → recall@10 per class. Compare
against the gate. Record in the ADR.

### Step 3: The leak tests

`packages/memory-search/src/no-leak.test.ts`. Seed two Spaces with deliberately
similar content, then assert that for a principal authorized only in Space A,
**none** of the following differs from a run where Space B is empty:

- result count and reported total;
- pagination cursor values and page boundaries;
- snippets and highlight offsets;
- **relevance scores** — a forbidden document changing IDF and shifting scores
  is a real, subtle side channel;
- timing, to a coarse tolerance (assert the same query plan shape, not a
  wall-clock threshold, which would be flaky).

Then extend `packages/authorization/src/conformance.ts` with search-specific
scenarios rather than starting a separate list.

**Verify**: `bun test packages/memory-search/src/no-leak.test.ts` → all pass.
Confirm each assertion fails when you temporarily remove the scope constraint —
a leak test that passes against a broken implementation is worse than none.

### Step 4: The MCP adapter

`packages/mcp-adapter`, over the application services — never over SQL, never
over the database.

Tools, identical across harnesses:

```text
memory_search(query, filters?, limit?)   → ranked items with provenance
memory_get(itemId)                       → one item's current revision
memory_propose(kind, title, body, …)     → a proposal, never a memory item
memory_propose_relation(fromId, toId, kind) → a proposal, never a durable edge
```

`memory_propose` and `memory_propose_relation` create **proposals**. There is no
MCP tool that creates a memory item, revision, or relation directly — plan 105
Step 2 made acceptance the only durable path, and the adapter must not open a
side door. Assert it: a test enumerates the registered tool names against an
allowlist and proves the proposal calls leave durable item/edge tables unchanged.

Prompt-injection handling, per the plan's own section — and worth stating in the
code, because it is the one thing an agent reading a response cannot recover
from:

- memory content is returned as **data**, wrapped and clearly labeled as
  retrieved content, never as instructions;
- every result carries provenance (who authored it, when, trust level, revision)
  so the calling agent can weigh it;
- superseded revisions are labeled as such when returned at all.

**Verify**: `bun test packages/mcp-adapter` → all pass, including the tool
allowlist test.

### Step 5: Two runtime modes, one code path

- **Local**: stdio or loopback; the local operator principal from plan 103's
  `local-authorizer`; local database.
- **Connected**: the device credential from plan 104; the server authorizes and
  searches.

Same tool schemas, same application services, different adapter wiring. Assert
that: a test runs the same tool-call fixture through both compositions and
asserts identical response *shape* (values differ, structure does not).

No shared-server credential in any repository file. Add the credential path to
`tools/check-secret-redaction.ts`'s scan from plan 104.

**Verify**: `bun test packages/mcp-adapter/src/modes.test.ts` → all pass.

### Step 6: Registration, using the existing projection discipline

Harness configuration is written through the skills projection machinery, not a
new mechanism:

- take `withSkillProjectionLock` (`packages/skills/src/projection-lock.ts:44`)
  before mutating a harness config;
- an existing entry that is **not** a verified ai-usage projection is an
  unmanaged runtime entry: report it for consolidation, never overwrite. This is
  not theoretical — `~/.claude/skills/agent-memory/SKILL.md` is a root-owned
  symlink into a NixOS configuration repository, and clobbering it would break
  the operator's machine;
- Nix-owned paths are reported and skipped, with an explicit message naming the
  target.

**Verify**: `bun test packages/mcp-adapter/src/registration.test.ts` — including
a fixture where the target is a symlink to a read-only path, asserting a
report-and-skip rather than an error or an overwrite.

### Step 7: Documentation

- `packages/memory-search/README.md` — stages, the authorization-first order,
  the leak-test list, and the measured recall with the pgvector gate.
- `packages/mcp-adapter/README.md` — tools, both modes, injection handling, and
  registration.
- ADR 0037 `authorized-hybrid-memory-search` — the FTS+trigram decision, the
  measured recall, the pgvector gate, the language-configuration measurement,
  and pgvector as the named rejected-for-now alternative.
- `CONTEXT.md` — **Memory search scope** and **Retrieved content**, the latter
  with `_Avoid_: instruction, guidance` in its avoid list.
- `plans/README.md:66` row → `DONE`.

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
