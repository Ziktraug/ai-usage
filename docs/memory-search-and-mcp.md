# Memory search and MCP

> **Implementation status:** Integrated on `main` via PR #53 (plan 106
> `DONE`). Corpus measurements and verification evidence below record the
> validation run at integration time, not a continuously refreshed benchmark.
> Plan 120 removed the connected PostgreSQL search adapter and its suite; this
> page describes the local mode only.

Memory retrieval is specified as one authorization-first application contract
over the dedicated `memory.sqlite` authority and its FTS5 projection, with
several edge adapters. Web, CLI, and MCP never query the database directly.

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

Two external-content FTS5 tables index each chunk's title, summary, guidance,
structured terms, and supporting text: a `unicode61` table (diacritics removed,
2–4 character prefixes) for lexical candidates and a `trigram` table for
bounded fuzzy candidates. Literal mode draws candidates only from a substring
match of the normalized literal; hybrid mode adds both FTS5 candidate sets.
The exact, lexical, and trigram scores weight the title highest and supporting
text lowest. No language stemmer is applied: the committed English/French
corpus did not justify per-document stemming, and leaving it out avoids
selecting an incorrect one.

### Authorization before ranking

The application first obtains one complete opaque authorized-resource scope.
SQLite binds its complete ID set into the eligible-chunk relation, together
with the structured predicates, before any FTS5 match or scoring. Result limit
and cursor are applied only afterward.

The target implementation must never rank a global corpus and post-filter it or
rank an arbitrary bounded page returned by the Authorizer. If a complete scope
cannot be represented, search fails closed. The no-leak fixture compares the
entire response with a deliberately stronger forbidden match present and
absent; IDs, order, total, snippets, cursor, page boundary, and every rank
component remain identical.

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

Per-class samples (one query per class, so sample = median = p95):

| Query class | Expected outcome | SQLite ms / bytes |
| --- | --- | ---: |
| exact identifier | hit@1 | 7.416 / 1,252 |
| exact command | hit@1 | 6.543 / 1,401 |
| typo/fuzzy | hit@1 | 5.112 / 1,312 |
| semantic paraphrase | lexical miss | 10.233 / 185 |
| explicit history | hit@1 | 5.157 / 1,357 |
| scope precedence | hit@1 | 11.964 / 2,756 |
| trust | hit@1 | 11.859 / 1,517 |
| no answer | empty | 9.504 / 185 |
| authorization negative | empty/no leak | 6.695 / 185 |
| multilingual | hit@1 | 10.174 / 3,858 |
| prompt injection | hit@1, quoted data | 15.943 / 2,745 |

The single miss is the intentionally lexically disjoint semantic paraphrase.
Although failures are concentrated in that class, lexical recall@10 is above
the required 0.8 threshold. Both gate clauses therefore do not fire and
vector search is deliberately absent. Adding embeddings requires a new reviewed
migration with model/version/dimension/input hashes, sensitive-derivative
handling, rebuild/mixed-version behavior, fusion, and no external disclosure of
private content by default.

To reproduce and print the synthetic report:

```sh
AI_USAGE_PRINT_MEMORY_SEARCH_METRICS=1 bun test packages/memory-sqlite/src/search.test.ts
```

The print flag is test-only and the corpus is synthetic. Production query,
content, snippets, scores, unauthorized IDs, and result cards are never logged.

## Product surfaces

The supervised local engine owns `memory.sqlite` and exposes a separately
authenticated numeric-loopback Memory service. Its owner-only rendezvous and
bearer token are distinct from usage-engine control. Web's server-side oRPC
handler, the CLI, and local MCP call this service; browser code imports only the
oRPC contract.

Web `/memory` provides active accepted search with hybrid/literal selection.
TanStack Query owns one key containing every result-shaping input. Search is
disabled during SSR until an operator submits a query; proposal review remains
separately SSR-hydrated.

Proposals reach that review only through the Memory application's
`recordObservation`, `createProposal`, `previewMemoryImport`, and
`confirmMemoryImport` operations, which the local service, CLI, Web, and MCP
do not expose yet; `exportMemory` is in the same state. A fresh local store
therefore has an empty corpus until such a surface exists
([`future-work.md`](future-work.md)).

With the supervised engine running, CLI search is:

```sh
bun run cli -- memory search 'SQLITE_BUSY: database is locked' --literal
bun run cli -- memory search 'authorized ranking' --json
```

Optional `--project <uuid> --include-space-wide`, `--limit 1..25`, and
`--cursor <opaque>` retain the same service contract. If the local Memory
service is unavailable, CLI/Web/MCP fail explicitly.

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

The adapter imports application ports, never the SQLite adapter. Its protocol
tests run through the SDK's in-memory transport.

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

The JSON path must end in `.mcp.json` or `mcp.json` and receives the
`mcpServers` shape (the Claude Code project-scope and Cursor conventions);
there is no OpenCode registration mode, and any other stdio MCP client is
pointed at `bun run mcp` by hand. Registration shares the
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
- search reads only `memory.sqlite` through the local Memory service and never
  calls a remote server;
- harness-specific configuration cannot change tool names or schemas.
