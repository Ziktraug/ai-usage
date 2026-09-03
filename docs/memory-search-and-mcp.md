# Memory search and MCP

> **Implementation status:** Accepted target specification. The search and MCP
> packages, commands, routes, corpus measurements, and verification evidence
> below are pending integration and are not available on `main`; plan 106
> remains `IN PROGRESS` in `plans/README.md`.

Memory retrieval is specified as one authorization-first application contract
with two storage projections and several edge adapters. Local/offline mode uses
the dedicated `memory.sqlite` authority and FTS5. Connected mode uses
PostgreSQL full-text search plus `pg_trgm`. Web, CLI, and MCP never query either
database directly.

This document is the accepted operating and safety specification. The synthetic
corpus and its measured numbers are regression evidence, not a production
latency SLA.

## Retrieval contract

Normal search returns only current accepted Memory. Every result identifies the
exact item and immutable revision, content hash, kind, optional Project, status,
trust, sensitivity, rank components, matched fields/excerpts, chunker version,
and bounded accepted-proposal provenance. Pending Proposals and raw
Observations never enter normal retrieval.

Historical `archived`, `rejected`, or `superseded` content requires both an
explicit history mode and explicit statuses. The application service requests
`view_memory` for active retrieval and `manage_memory` for history. Literal mode
preserves command/error punctuation and identifiers; hybrid mode combines
lexical and bounded fuzzy evidence.

The accepted target contract versions are:

| Contract | Version |
| --- | --- |
| Search | `memory-search-v1` |
| Chunker | `memory-search-chunker-v1` |
| Ranking | `memory-search-lexical-v1` |

Hard limits include 512 query characters/2,048 UTF-8 bytes, 32 query terms, 25
results, 4,096 cursor bytes, five-minute cursor lifetime, 32 KiB per result,
128 KiB per search response, eight match explanations, eight provenance
summaries, and a two-second application deadline. MCP adds a 192 KiB serialized
tool-response ceiling. Cancellation crosses Web, CLI/MCP loopback, application,
and repository seams.

Cursors bind the normalized query and filters, exact authorized result order,
authorization snapshot/version where applicable, source projection state, and
ranking version. A changed relevant scope or projection invalidates the cursor
instead of silently continuing a different result set.

## Indexing and ranking

SQLite stores deterministic revision chunks in an FTS5-derived projection.
The sole local Memory writer updates accepted/superseded eligibility and the
projection in the same transaction. Rebuilding unchanged source state is
idempotent. Structured Space, Project, status, trust, sensitivity, and current
revision predicates are applied before candidates are returned.

PostgreSQL stores a generated weighted `tsvector` plus indexed trigram support:

- A: exact title and accepted command text;
- B: summary, decisions, and pitfall symptoms/causes;
- C: guidance and structured terms;
- D: bounded supporting text.

Both adapters use the `simple` text-search configuration plus normalized
trigrams. The committed English/French corpus did not justify per-document
stemming, and `simple` avoids selecting an incorrect language stemmer.

### Authorization before ranking

The application first obtains one complete opaque authorized-resource scope.
SQLite binds that scope to its structured predicates. PostgreSQL materializes
the complete authorized relation in the query and joins it before FTS/trigram
eligibility and scoring. Result limit and cursor are applied only afterward.

The target implementation must never rank a global corpus and post-filter it or
rank an arbitrary bounded page returned by the Authorizer. If a complete scope
cannot be represented, search fails closed. The no-leak fixtures compare the
entire response with a deliberately stronger forbidden match present and
absent; IDs, order, total, snippets, cursor, page boundary, and every rank
component remain identical. A direct unsafe SQL fixture proves that the
forbidden row exists and would rank without the authorization join.

## Evaluation and vector gate

The committed corpus has 11 active plan-106 cases: exact ADR identifier, exact
punctuated command/error, typo/fuzzy, lexically disjoint semantic paraphrase,
history, Space/Project precedence, trust, no-answer, authorization-negative,
English/French, and prompt injection. The plan-108 Work-handoff case is reserved
but remains inactive until that domain exists.

Measured on 2026-08-30 in this repository's Nix/Bun test environment:

| Adapter | Cases | Recall@1 | Recall@10 | MRR | No-answer FPR | No-leak | Latency median / p95 / max | Response bytes median / p95 / max |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| SQLite FTS5 | 11 | 0.888889 | 0.888889 | 0.888889 | 0 | pass | 9.504 / 15.943 / 15.943 ms | 1,357 / 3,858 / 3,858 |
| PostgreSQL FTS + `pg_trgm` | 11 | 0.888889 | 0.888889 | 0.888889 | 0 | pass | 16.549 / 21.200 / 21.200 ms | 1,366 / 2,769 / 2,769 |

Per-class samples (one query per class, so sample = median = p95):

| Query class | Expected outcome | SQLite ms / bytes | PostgreSQL ms / bytes |
| --- | --- | ---: | ---: |
| exact identifier | hit@1 | 7.416 / 1,252 | 18.820 / 1,257 |
| exact command | hit@1 | 6.543 / 1,401 | 8.454 / 1,399 |
| typo/fuzzy | hit@1 | 5.112 / 1,312 | 11.508 / 1,318 |
| semantic paraphrase | lexical miss | 10.233 / 185 | 16.874 / 191 |
| explicit history | hit@1 | 5.157 / 1,357 | 6.395 / 1,366 |
| scope precedence | hit@1 | 11.964 / 2,756 | 15.976 / 2,769 |
| trust | hit@1 | 11.859 / 1,517 | 17.122 / 1,523 |
| no answer | empty | 9.504 / 185 | 14.622 / 191 |
| authorization negative | empty/no leak | 6.695 / 185 | 16.549 / 191 |
| multilingual | hit@1 | 10.174 / 3,858 | 21.200 / 1,386 |
| prompt injection | hit@1, quoted data | 15.943 / 2,745 | 16.916 / 1,557 |

The single miss is the intentionally lexically disjoint semantic paraphrase.
Although failures are concentrated in that class, lexical recall@10 is above
the required 0.8 threshold. Both gate clauses therefore do not fire and
`pgvector` is deliberately absent. Adding embeddings requires a new reviewed
migration with model/version/dimension/input hashes, sensitive-derivative
handling, rebuild/mixed-version behavior, fusion, and no external disclosure of
private content by default.

To reproduce and print the synthetic report:

```sh
AI_USAGE_PRINT_MEMORY_SEARCH_METRICS=1 bun test packages/memory-sqlite/src/search.test.ts
nix develop -c bash -lc \
  'AI_USAGE_RUN_POSTGRES_TESTS=1 AI_USAGE_PRINT_MEMORY_SEARCH_METRICS=1 bun test tools/memory.postgres.test.ts'
```

The print flag is test-only and the corpus is synthetic. Production query,
content, snippets, scores, unauthorized IDs, and result cards are never logged.

## Product surfaces

The supervised local engine owns `memory.sqlite` and exposes a separately
authenticated numeric-loopback Memory service. Its owner-only rendezvous and
bearer token are distinct from usage-engine control. Web's server-side oRPC
handler, the CLI, and local MCP call this service; browser code imports only the
oRPC contract. Connected composition calls the same Memory application service
over PostgreSQL with an established Person/Device authorization context.

Web `/memory` provides active accepted search with hybrid/literal selection.
TanStack Query owns one key containing every result-shaping input. Search is
disabled during SSR until an operator submits a query; proposal review remains
separately SSR-hydrated.

With the supervised engine running, CLI search is:

```sh
bun run cli -- memory search 'SQLITE_BUSY: database is locked' --literal
bun run cli -- memory search 'authorized ranking' --json
```

Optional `--project <uuid> --include-space-wide`, `--limit 1..25`, and
`--cursor <opaque>` retain the same service contract. If the local Memory
service is unavailable, CLI/Web/MCP fail explicitly; connected failure never
falls back to a different local corpus.

## MCP tools and retrieved-content safety

`@ai-usage/mcp-adapter` registers exactly three read-only tools:

| Tool | Input | Output |
| --- | --- | --- |
| `memory.search` | bounded search fields: `query`, `limit`, optional cursor/mode/Project/kind/status/trust | revision-pinned cards, total/cursor, rank, match explanation, provenance |
| `memory.get` | `itemId` UUID and optional exact `revisionId` UUID | exact authorized current or historical item/revision card |
| `memory.project_context` | Project UUID and limit (default 16, max 32) | deterministic active constraints, decisions, pitfalls, and commands |

`memory.latest_work_handoff`, `work_handoff.get`, and
`work_thread.get_context` are reserved names, not registered placeholder tools.
Plan 108 activates them only with real Work application services. There is no
MCP acceptance, revision, supersession, relation, or direct Item-creation tool.

Every response includes `contentRole: "retrieved-data"`, a fixed notice, exact
revision/content identity, status, trust, sensitivity, and verification. An
exact historical `memory.get` result is labeled `accepted-historical-revision`;
current results are labeled `accepted-current-revision`.
Search cards additionally preserve match explanation, rank, and bounded
provenance. Retrieved text—including prompt-injection fixtures—is serialized as
quoted JSON data and cannot override the current user request, system
instructions, code, or tests. Raw Observations are excluded, and exact command
text can come only from an accepted command item.

The adapter imports application ports, never SQLite/PostgreSQL adapters. The
same protocol tests run through the SDK's in-memory transport; the connected
PostgreSQL test runs the same `memory.search` composition.

## Local MCP and registration

Start the local stdio server only while the supervised engine is available:

```sh
bun run mcp
```

Registration is always an explicit operator action. Codex registration uses
its supported `codex mcp list --json` / `codex mcp add` interface and verifies
the resulting stdio command; see the
[official Codex MCP documentation](https://developers.openai.com/codex/mcp).

```sh
bun run mcp:register:codex
bun apps/mcp/src/register.ts json /absolute/project/.mcp.json
```

The JSON path must end in `.mcp.json` or `mcp.json`. Registration shares the
Skills projection lock, validates parent/target identity, refuses symlinks,
bounds existing files to 1 MiB, uses an owner-only atomic temp write, preserves
unrelated keys/servers, and is idempotent. A same-name registration with
different content is unmanaged and is refused rather than overwritten. Codex
configuration is changed through the Codex CLI rather than hand-edited TOML.
No shared credential is written to repository configuration.

## Failure and redaction rules

- authorization unavailable/denied, invalid input, not found, timeout,
  cancellation, and service unavailable map to closed stable errors;
- private paths, bearer tokens, database errors, queries, result text, and
  unauthorized IDs never enter MCP/Web/CLI diagnostics;
- response-size overflow becomes a fixed sanitized error, never a partial card;
- local search never calls PostgreSQL or a connected server;
- shared search never returns a local fallback;
- harness-specific configuration cannot change tool names or schemas.
