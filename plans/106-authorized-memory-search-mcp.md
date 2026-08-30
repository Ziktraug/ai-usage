# Plan 106: Build Authorized Hybrid Memory Search and a Harness-Agnostic MCP Adapter

> **Executor instructions**: Treat search quality and authorization as one
> contract. Build one evaluation corpus before ranking code. Implement local
> SQLite FTS5 and shared PostgreSQL FTS + `pg_trgm` behind the same search
> service/result contract. Do not add `pgvector` unless the measured semantic
> recall gate fails. MCP is an adapter over application services, never a DB API.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- packages/memory packages/memory-search packages/authorization packages/postgres-store packages/mcp-adapter apps/usage-engine apps/server apps/web apps/cli docs/architecture.md docs/adr`

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — search can leak forbidden existence or feed stale/untrusted
  instructions to an agent
- **Depends on (local and single-user shared adapters)**: 102, 105
- **Depends on (organization-connected activation)**: local slice, 103, 104
- **Connected organization activation**: also requires 103 and 104
- **Category**: local/shared retrieval and MCP
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: DONE

## Locked search topology

```text
Local/offline
  dedicated Memory SQLite
  SQLite FTS5 + structured filters
  SingleUserAuthorizer
  local stdio/loopback MCP

Shared/connected
  PostgreSQL Memory
  PostgreSQL full-text search + pg_trgm + structured filters
  complete authorization relation joined before ranking
  connected MCP/server adapter
```

Both adapters consume the same synthetic evaluation corpus, application query,
result contract, bounds, and correctness expectations. Local search does not
fall back to the server. Shared search does not expose PostgreSQL to harnesses.

Plan 106 depends on the `Authorizer` port and `SingleUserAuthorizer`, not the
complete plan-103 organization implementation. The local vertical and
single-user shared adapter may land first. Organization-scoped shared search is
enabled only after plan 103's complete-scope conformance passes.

## Searchable domain

Default search includes:

- current active accepted Memory revisions;
- selected current structured decisions, constraints, patterns, pitfalls, and
  validated commands;
- accepted Work handoffs and Work Thread context after plan 108.

Superseded/rejected history requires an explicit mode/permission. Pending
Proposals and Observations require separate permissions and never mix into
normal guidance.

Every indexed chunk names exact item/revision, Space, optional Project, kind,
trust, sensitivity, status, content hash, chunker version, and bounded
provenance. Generated text remains distinguishable from observed/declared facts.

## Search application contract

```ts
interface MemorySearchQuery {
  readonly principal: PrincipalRef;
  readonly query: string;
  readonly activeSpaceId: SpaceId;
  readonly projectId?: ProjectId;
  readonly kinds?: readonly MemoryKind[];
  readonly statuses?: readonly MemoryStatus[];
  readonly trust?: readonly MemoryTrust[];
  readonly includeSpaceWide?: boolean;
  readonly limit: number;
  readonly cursor?: string;
}

interface MemorySearchResult {
  readonly id: MemoryItemId | WorkHandoffId;
  readonly revisionId: MemoryRevisionId | WorkHandoffId;
  readonly resourceKind: "memory" | "work-handoff";
  readonly title: string;
  readonly summary: string;
  readonly guidance: readonly string[];
  readonly status: MemoryStatus | WorkHandoffStatus;
  readonly trust: MemoryTrust;
  readonly sensitivity: Sensitivity;
  readonly projectId: ProjectId | null;
  readonly matchedBecause: readonly MatchExplanation[];
  readonly provenance: readonly BoundedProvenanceSummary[];
}
```

Hard bounds cover input length, result count, per-result bytes/tokens, total
response size, snippets, provenance, timeout, cancellation, and cursor lifetime.
Cursors bind query/filter, principal authorization version/snapshot as
applicable, adapter/ranking version, and exact result order.

## Local SQLite FTS5 adapter

- FTS5 indexes deterministic chunks from exact immutable revisions;
- structured Space/Project/status/trust/sensitivity/current-revision predicates
  are applied before returning/ranking candidates;
- exact/literal mode preserves commands, IDs, filenames, and error strings;
- tokenizer/language configuration is evaluated on English and French fixtures;
- reindexing unchanged content is idempotent;
- supersede/delete removes eligibility immediately and rebuilds projections
  according to the documented transaction model;
- local search uses `SingleUserAuthorizer` and permits only the local personal
  Space; it never calls PostgreSQL.

FTS5 tables remain derived projections in the dedicated Memory SQLite store.
The same sole local writer owns Memory mutations and index maintenance.

## Shared PostgreSQL adapter

Use weighted full-text fields plus trigram:

```text
A: exact title and validated command
B: summary, decision choice, pitfall symptom/cause
C: guidance, alternatives, tags/structured terms
D: bounded supporting text
```

Use indexed `tsvector` and indexed `pg_trgm` similarity with thresholds measured
against the corpus. Trigram handles misspellings, aliases, short errors, and
weak-FTS fallback. Do not run unbounded similarity scans.

Language choice is measured. If results do not justify per-chunk configuration,
use the `simple` configuration plus trigram to avoid incorrect stemming.

## Authorization before ranking

The shared query must join/materialize the complete authorized relation inside
the ranking SQL:

```text
principal + permission + active Space
  ↓
authorization relation join / authorized-resource CTE /
request-scoped temporary authorized relation / proven equivalent predicate
  ↓
all eligible authorized candidates within normal SQL/query-time bounds
  ↓
FTS + trigram + optional gated semantic ranking
  ↓
result pagination
```

Forbidden designs:

```text
rank global corpus → filter results
bounded Authorizer resource page → rank only that truncated page
```

Rules:

- there is no arbitrary authorization cap before ranking;
- result `limit` and cursor apply only after the eligible authorized query;
- if complete authorized scope cannot be represented safely, return a typed
  fail-closed search-unavailable result;
- no forbidden result affects count, reported total, snippet/highlight, cursor
  boundary/value, rank, IDF/statistics, trigram/semantic threshold, or semantic
  score;
- exact content permission is rechecked if the materialized scope is broader
  than returned content, without letting broader candidates influence ranking;
- relationship changes during paging follow documented transaction/snapshot or
  cursor invalidation semantics.

The query implementation is adapter-owned and proven equivalent to the
`Authorizer` model through plan 103 fixtures. Route/MCP code cannot assemble an
ID allowlist or post-filter.

If a future OpenFGA adapter replaces PostgreSQL relationship queries, it must
materialize all authorized objects under documented consistency (for example
all `ListObjects` pages into a request-scoped temp table) before the ranking
query. A partial/truncated materialization fails closed.

## Ranking and `pgvector` gate

Ship lexical FTS5 locally and FTS + `pg_trgm` shared. Add `pgvector` only when:

1. hybrid lexical recall@10 is below 0.8 across the committed evaluation set;
2. failures are concentrated in semantically equivalent but lexically disjoint
   paraphrases after weights, tokenizer/language, and trigram thresholds have
   been tuned.

If the gate fires, create a separately reviewed migration/implementation step,
record embedding model/version/dimension/input hash, treat embeddings as
sensitive derivatives, support rebuild/mixed-version transition, and use a
documented fusion method. No external embedding API receives private content by
default. Absence of `pgvector` must leave lexical search complete.

## Evaluation corpus

Commit synthetic/generic records and questions covering:

1. exact title/identifier;
2. exact error/command punctuation;
3. typo/fuzzy project/command;
4. semantic paraphrase with little lexical overlap;
5. active item superseding contradiction;
6. rejected history requested explicitly;
7. Space-wide preference versus Project constraint;
8. explicit versus harvest-accepted trust;
9. no relevant answer;
10. forbidden item that would otherwise rank first;
11. English/French cases;
12. latest accepted Work handoff after plan 108.

Record expected IDs, acceptable alternatives, forbidden IDs, required
status/trust explanation, permission fixture, and no-answer behavior. Report
recall@1, recall@10, MRR, false-positive rate, no-leak results, latency, and
response size per query class and per adapter. Aggregate metrics alone do not
decide the vector gate.

## No-leak test contract

Seed authorized Space A and forbidden Space B with deliberately similar
documents, then compare the principal's search with B present versus absent.
The following must be identical except for nondeterministic timing excluded from
the assertion:

- returned IDs/order/count/total;
- snippets, highlights, matched-because;
- cursor values and page boundaries;
- rank/lexical/trigram/semantic scores;
- corpus statistics/IDF inputs and query-plan scope.

Each assertion must fail when the authorization join is deliberately removed.
Timing tests compare plan/scope shape or coarse bounded classes, not flaky wall
clock equality.

## MCP adapter

Create `packages/mcp-adapter` only with real tools. It owns MCP protocol,
runtime schemas, bounded serialization, principal-context conversion,
cancellation, sanitized errors, and registration. It never owns storage,
ranking, authorization policy, WorkHandoff generation, or harness parsing.

Initial tools use dotted names exactly:

```text
memory.search
memory.get
memory.project_context
memory.latest_work_handoff   # activated by plan 108
work_handoff.get             # activated by plan 108
work_thread.get_context      # activated by plan 108
```

`memory.search` returns bounded cards with revision, trust, status,
matched-because, and provenance. `memory.get` retrieves an exact authorized item
or revision. `memory.project_context` deterministically composes bounded active
constraints, decisions, pitfalls, commands, and latest Work handoff when
available.

After read tools stabilize, optional `memory.propose` may create a pending
Proposal only. No MCP tool accepts, revises, supersedes, or directly creates a
Memory Item/relation. Plan 108 owns WorkHandoff creation/acceptance rules and the
three reserved retrieval tools.

## MCP modes and registration

Local MCP uses stdio or bounded loopback, local application services, local
SQLite/FTS5, and `SingleUserAuthorizer`. It works offline and does not carry a
shared credential in repository files.

Connected MCP uses the same schemas and calls shared application services with
Person/Device credentials. Organization policy may disable sensitive tools.
Offline/stale behavior is explicit; connected failure never silently changes a
shared query into local results.

Harness-specific work is configuration only. Reuse
`withSkillProjectionLock`, target identity revalidation, and the unmanaged-entry
rule. Never overwrite root/Nix-owned or unverified harness configuration.

## Retrieved-content safety

- responses label content as retrieved data, not system instruction;
- trust, status, revision, source kind, and verification guidance are present;
- raw untrusted Observations are excluded from normal context;
- retrieved content never overrides current user request, code, tests, or system
  instruction;
- prompt-injection fixtures remain quoted/labeled data;
- exact command text is returned only from an accepted command item;
- query/content/snippets/embeddings/unauthorized IDs never enter logs.

## Steps

### Step 1: Commit one evaluation corpus and harness

Create synthetic fixtures and adapter-independent expected results before
search code. Include negative authorization and multilingual/paraphrase cases.

### Step 2: Implement local SQLite FTS5 search

Add deterministic chunking/index maintenance and the shared query/result
contract. Prove local-only operation with a platform connector that throws if
invoked and zero calls.

### Step 3: Implement shared PostgreSQL FTS + trigram search

Implement indexed weighted search with a complete authorization join/CTE/temp
relation. Prove equivalence to Authorizer fixtures and no pre-ranking truncation.

### Step 4: Run no-leak and ranking evaluation

Verify forbidden-corpus non-influence, measure both adapters, choose language
configuration, and evaluate the pgvector gate. Record metrics and reject
pgvector unless both gate conditions hold.

### Step 5: Add read-only MCP tools in local mode first

Expose the exact dotted names owned by this plan, plus reserved plan-108 slots
only when those services exist. Test bounds, cancellation, injection labeling,
no direct DB import, and no mutation tools.

### Step 6: Add connected composition and safe registration

Run the same tool fixtures through local/shared compositions. Register through
the existing projection lock and unmanaged-entry discipline.

### Step 7: Add Web/CLI surfaces and docs

Web and CLI call the same search application service. Document ranking,
authorization materialization, corpus metrics, vector gate, tool schemas,
offline behavior, and log redaction.

## Verification

- local and shared adapters run the same evaluation corpus/result contract;
- local uses FTS5 and makes zero platform calls;
- shared uses FTS + `pg_trgm` with complete authorized SQL scope;
- no pre-ranking authorization page/cap or application post-filter exists;
- no-leak tests cover count/snippet/cursor/rank/statistics/semantic influence;
- pgvector is absent unless both measured gate clauses fire;
- MCP tools use exact dotted names and no direct write/DB path;
- `bun run lint`, typecheck, search/MCP tests, and relevant e2e pass.

## Done criteria

- [ ] Local Memory search/MCP works without server/account/network/PostgreSQL.
- [ ] Shared search evaluates all eligible authorized candidates before ranking.
- [ ] One corpus/result contract covers FTS5 and PostgreSQL FTS/trigram.
- [ ] Forbidden resources influence no observable search property.
- [ ] Vector search is evidence-gated and optional.
- [ ] MCP preserves trust/status/provenance and treats content as data.
- [ ] Exact WorkHandoff/WorkThread tool vocabulary is reserved/activated
      consistently.

## STOP conditions

Stop and report when:

- authorization is a truncated resource page before ranking;
- global ranking/snippets/statistics happen before authorization;
- complete scope cannot be represented safely;
- local search consults shared PostgreSQL/server;
- embeddings send private content externally by default;
- MCP imports storage adapters or mutates accepted Memory directly;
- tool schemas diverge by harness;
- results omit revision/trust/status/provenance.

## Out of scope

- general document/transcript search;
- autonomous Memory acceptance;
- public Internet MCP for arbitrary clients;
- native session conversion or inference/model routing.
