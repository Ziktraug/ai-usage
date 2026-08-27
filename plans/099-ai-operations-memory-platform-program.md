# Plan 099: Evolve ai-usage Into a Multi-Tenant AI Operations and Memory Platform (program plan)

> **Executor instructions**: This is the umbrella for plans 100–110. Do not
> implement production behavior directly from this file. Execute the child plans
> in the dependency order below, read each child in full before starting it, honor
> every STOP condition, and update the planning index only after the child’s done
> criteria pass. A child may be rejected when its spike disproves the proposed
> direction; rejection with evidence is a valid program outcome.
>
> **Drift check (run first)**: `git rev-parse --short HEAD`. This program was
> written against `dac2214c` on 2026-08-26. If `main` has moved, re-read
> `AGENTS.md`, `CONTEXT.md`, `docs/architecture.md`, `docs/adr/README.md`,
> `tools/check-package-boundaries.ts`, `packages/usage-store/README.md`, and
> `apps/usage-engine/README.md` before executing any child. Existing local
> ownership rules remain authoritative until a child explicitly replaces them
> through an accepted ADR.

## Status

- **Priority**: P0 program
- **Effort**: L as a planning program; implementation is multiple XL workstreams
- **Risk**: HIGH — changes product topology, tenancy, persistence, privacy, and
  authorization
- **Depends on**: plans 100–110
- **Category**: product/platform direction
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

ai-usage currently answers a local, single-operator question well: what happened
across Claude Code, Codex, OpenCode, and Cursor on this machine? The existing
architecture deliberately keeps provider credentials out of the product, gives
SQLite one production writer, and lets Web and CLI read immutable report
projections directly. That foundation is valuable and must not be discarded.

The product direction now extends beyond local reporting:

1. a developer uses several harnesses, subscriptions, projects, and machines;
2. sessions and operational context should be visible without manually moving a
   JSON bundle;
3. work should continue across harnesses through explicit handoffs rather than
   repeated explanation;
4. durable Agent Memory should let an agent ask whether a problem was already
   solved, why an approach was rejected, or what work remains;
5. personal and organization data must coexist without accidental disclosure;
6. a future organization may need aggregate adoption and usage visibility
   without permission to read prompts, code, or project memory.

This is not a request to turn ai-usage into another model provider or another
coding harness. The proposed product is the neutral operations, memory, and
continuity layer above interchangeable models and harnesses.

## Program thesis

Keep one monorepo and one product identity, while introducing multiple explicit
runtime roles:

```text
Local machine
  harness histories
      ↓
  usage-engine (sole local writer)
      ↓
  SQLite operational store + durable replication outbox
      ↓ outbound HTTPS

Shared server
  authenticated ingest/API
      ↓
  server application services
      ↓
  PostgreSQL shared platform store
      ↓
  one Web product, connected or local

Agents
  Claude / Codex / OpenCode / Cursor
      ↓
  harness-specific MCP transport
      ↓
  shared Memory and Handoff application services
```

The monorepo may contain several deployable apps. That is runtime separation,
not product fragmentation.

## Decisions this program proposes to lock

These are proposed program decisions. Plan 100 must either turn them into
accepted ADRs or reject them with evidence before implementation proceeds.

1. **One monorepo, one product**. Usage, Skills, Memory, Sync, Handoff, and later
   Recommendations remain capabilities of ai-usage.
2. **Internal capability modules before a public plugin SDK**. Capabilities may
   register routes, jobs, MCP tools, navigation entries, and permissions, but
   migrations remain one reviewed sequence and arbitrary third-party code is not
   loaded into trusted runtimes.
3. **SQLite remains the local operational truth**. Collector checkpoints,
   caches, source attempts, local observations, outbox state, and offline report
   projections remain available without a server.
4. **PostgreSQL becomes the shared platform truth**. It owns people, spaces,
   devices, projects, replicated facts, DB-native memory, handoffs, organization
   aggregates, and authorization resources.
5. **Agent Memory becomes DB-native**. Markdown/JSONL remain supported import,
   export, backup, or optional projection formats; they are no longer the
   authoritative mutation surface.
6. **MCP is an agent adapter, not the application’s internal bus**. Web, CLI,
   jobs, and MCP call the same application services through separate adapters.
7. **A Git repository is a primary locator, not a project primary key**. Stable
   internal project IDs survive repository rename, transfer, URL protocol
   changes, mirrors, monorepo subpaths, and non-Git projects.
8. **Authentication concepts stay separate**: person, login identity, SCM
   connection, and device credential are different objects.
9. **Authorization is relationship-first**. Personal and organization spaces,
   teams, projects, repositories, sessions, memories, and devices form a graph.
   Contextual attributes may constrain that graph, but ABAC alone is not the
   source of truth.
10. **Aggregate permission is not content permission**. An organization auditor
    may see adoption, volume, and cost aggregates without reading session detail
    or memory.
11. **Search is authorization-aware before ranking**. Full-text, fuzzy, and
    vector search may only rank resources inside the caller’s permitted scope.
12. **Clients initiate synchronization**. No machine opens an inbound peer port,
    performs LAN discovery, or needs another machine online at the same time.
13. **Handoff precedes native session conversion**. The first cross-harness
    continuity feature creates a new native target session with verified context;
    it does not forge another harness’s private session store.
14. **Sensitive session archives are opt-in**. Portable metadata can sync by
    default; prompts and normalized chronology require explicit project/space
    policy; raw harness databases and transcripts are never default payloads.

## Decisions closed during executable-plan preparation (2026-08-26)

Plans 100–110 were written as specifications and then made executable against
the working tree on the same date. Seven questions the program left to the
executor were closed, because each blocked the first line of code and none can
be resolved mid-flight without guessing. Each has a named rejected alternative
and a reversal condition in its own plan.

| Plan | Decision | Escape |
|---|---|---|
| 101 | `initdb` into `mkdtemp`, Unix socket, PostgreSQL in `flake.nix` | one cluster per test process if startup dominates |
| 103 | PostgreSQL-native relations behind the `Authorizer` port | OpenFGA, on four measured triggers |
| 104 | Better Auth, verified by spike before use | stop and report if the spike fails |
| 104 | bearer device credential stored as an Argon2id verifier | asymmetric keys if non-repudiation is ever needed |
| 104 | password login **BLOCKED** (needs transactional email) | one plugin + email infra when a real user needs it |
| 106 | FTS + `pg_trgm`, no embeddings yet | pgvector on recall@10 < 0.8 in paraphrase queries |
| 109 | per-Space envelope encryption for Class B archives | reconsider only if measured restore/rotation cannot meet the documented recovery SLO |

**Plan 101's was not a preference — it was a blocker.** The development machine
has no container runtime and no PostgreSQL binaries, so "a pinned container or
an equivalent hermetic service" was unexecutable as written.

### Vocabulary collisions found in the working tree

Each would have produced a silent defect. Plan 100 Step 1 resolves the first
three before any schema exists.

- **`handoff`** — three meanings: a staged CLI→engine file
  (`packages/usage-engine-control/src/handoff.ts` + 9 files), a durable memory
  entry type (the NixOS agent-memory contract), and plan 108's cross-harness
  continuity. Plan 108's is renamed **Work handoff**.
- **`authorize`** — 180 hits in the tree, none meaning permission.
  `SourceAuthority` (`packages/report-data/src/project-projection.ts:26`) is
  *filesystem-trust provenance*. Plan 103 must not reuse the word "authority".
- **`project`** — `Project source` and `Project group` already exist in
  `CONTEXT.md`; the platform's cross-device `Project` is a third meaning.
- **`control plane`** / **`data plane`** — both already defined in `CONTEXT.md`
  for the *local* engine seam and the *local* SQLite store.

### Prior art these plans reuse instead of rebuilding

- `packages/report-core/src/session-vcs.ts:166` — remote normalization, already
  handling https + SCP-style SSH, already tested. Plan 102 extends it; it does
  not rewrite it.
- `packages/usage-engine-control/src/secret.ts:4` — a branded `WeakMap`-backed
  secret rendering `[REDACTED]` by construction. Plan 104's device credential
  copies this shape.
- `usage_store_metadata`'s monotonic `generation` counters plus `CONTEXT.md:19`
  **Source publication** — plan 107's outbox acknowledgement discipline already
  exists locally.
- `packages/skills/src/projection-lock.ts:44` — the cooperating-process lock and
  unmanaged-entry rule plan 106's MCP registration must reuse. Relevant because
  `~/.claude/skills/agent-memory/SKILL.md` is a root-owned symlink into a NixOS
  configuration repository, and clobbering it would break the machine.
- `tools/check-package-boundaries.ts:52` `retiredPackages` — `lan-pairing` and
  `sync` were already removed for building what ADR 0029 forbids. Cite this as
  evidence rather than arguing the point again.

### The three package checks

Every new package must satisfy all three checks, but they do not have identical
registration semantics:

1. `tools/check-typescript-coverage.ts:4` `TYPECHECK_PROJECTS` — register the
   package's `tsconfig`; the checker also scans tracked TypeScript and fails on
   uncovered files, so omission is reported rather than silent.
2. `tools/check-package-boundaries.ts:61` `boundaryPolicies` — add a policy when
   the package has an architectural dependency rule. The checker does not require
   one policy per package automatically, so add a focused test for the intended
   boundary.
3. Each workspace package's own `package.json` `exports` — cross-package imports
   are enforced by `tools/check-public-package-exports.ts`.

## Child plans

| Plan | Title | Priority | Effort | Depends on |
| --- | --- | --- | --- | --- |
| 100 | Define the Platform Topology, Capability Modules, and Data Ownership | P0 | L | - |
| 101 | Add the PostgreSQL Server Foundation Without Replacing the Local SQLite Engine | P0 | L | 100 |
| 102 | Introduce Stable Spaces, People, Devices, Repositories, Projects, and Checkouts | P0 | L | 100, 101 |
| 103 | Model Authorization With ReBAC, Content Boundaries, and Aggregate-Only Roles | P0 | XL | 100–102 |
| 104 | Add Authentication, GitHub Identity Separation, and Device Enrollment | P1 | L | 102, 103 |
| 105 | Migrate Agent Memory From NixOS Files Into a DB-Native Domain | P1 | XL | 100–104 |
| 106 | Build Authorized Hybrid Memory Search and a Harness-Agnostic MCP Adapter | P1 | XL | 103, 105 |
| 107 | Replicate Local Machine Facts to the Server With an Idempotent Outbox Protocol | P1 | XL | 101–104 |
| 108 | Add Cross-Harness Handoffs and Work Threads | P1 | L | 102, 105–107 |
| 109 | Archive Session Detail Safely for Cross-Machine Read-Only Continuity | P2 | L | 103, 104, 107, 108 |
| 110 | Spike Native Session Portability Across Claude, Codex, OpenCode, and Cursor | P2 | L spike | 108, 109 |

## Execution order

```text
100 topology and ownership
  ↓
101 PostgreSQL foundation
  ↓
102 identities, spaces, projects, devices
  ↓
103 authorization model
  ↓
104 authentication and enrollment
  ├───────────────┐
  ↓               ↓
105 DB Memory     107 replication
  ↓               ↓
106 search/MCP ───┘
  ↓
108 handoffs and work threads
  ↓
109 sensitive session archives
  ↓
110 native portability spike
```

Plan 105 domain modelling may be prototyped while 103–104 are being reviewed,
but its shared database migrations must not land before tenancy and authorship
fields are final. Plans 105 and 107 may proceed in parallel only after 104 lands
and their migration ownership is coordinated.

## Cross-cutting invariants

Every child must preserve these rules unless this plan is amended explicitly:

### Local mode remains a first-class product

- `bun run dev` and a local production start remain useful without an account,
  network, or PostgreSQL.
- Collection never waits for the shared server.
- Server failure never blocks local writes or local report reads.
- The existing manual merge bundle remains a bootstrap/recovery/air-gapped
  fallback until a later plan explicitly retires it.

### No dual writer inside one data plane

- `apps/usage-engine` remains the only production writer to the local usage
  SQLite database.
- The future server runtime has one explicit PostgreSQL write composition root.
- Web routes, MCP handlers, and background jobs call application services; they
  do not instantiate arbitrary write-capable stores.

### Tenant assignment is explicit

- Every shared resource belongs to a personal or organization space.
- A machine, path, or GitHub account does not implicitly make data
  organization-owned.
- Ambiguous capture context stays personal or unassigned and is never silently
  published to an organization.

### Content and metadata stay distinct

At minimum, authorization and persistence distinguish:

- organization aggregate usage;
- project/session metadata;
- session content;
- Agent Memory content;
- raw local artifacts.

A broader permission must not be simulated by reading a narrower resource and
masking fields after the fact.

### Contracts do not become ORM row types

Drizzle may define PostgreSQL adapters and migrations. Public contracts,
application commands, sync envelopes, oRPC schemas, and MCP schemas remain
explicitly validated domain types so a storage migration does not accidentally
become a protocol breaking change.

### No unverified native harness writes

No child may write directly into undocumented Claude, Codex, OpenCode, or Cursor
session stores. Plan 110 is the only place authorized to investigate native
portability, and it contains hard STOP conditions.

## Program product gates

The program cannot be marked DONE until all of the following are demonstrated
with repository-owned fixtures:

1. **Local regression**: the current local-only usage report, Skills management,
   source control, CLI, and usage-engine tests remain green without PostgreSQL.
2. **Two-device continuity**: two synthetic enrolled devices can publish facts;
   either device may be offline while the shared Web view still shows previously
   acknowledged data with provenance and freshness.
3. **No inbound client port**: replication tests prove the device initiates all
   application traffic.
4. **Tenant isolation**: personal data is invisible to an organization; an
   organization member sees only related projects; an aggregate auditor sees
   aggregates but cannot retrieve session or memory content.
5. **Identity continuity**: a repository rename/URL change does not create a new
   logical project, and a non-Git project remains supported.
6. **Memory provenance**: imported and newly accepted memory can be revised,
   superseded, searched, and traced to observations without deleting history.
7. **Authorized retrieval**: memory search filters authorization before ranking
   and does not leak forbidden result existence through counts, snippets, or
   embeddings.
8. **Cross-harness handoff**: a synthetic source harness creates an accepted
   handoff and a different target harness retrieves enough verified context to
   continue in a new session.
9. **Archive boundary**: metadata-only sync works by default; sensitive session
   archive is opt-in, separately deletable, and never stores raw harness files.
10. **Operational recovery**: PostgreSQL migrations, device credential
    revocation, outbox retry/idempotency, backups, and restore procedures are
    documented and tested at their owned layer.

## STOP conditions for the program

Stop and return to the maintainer when any child discovers one of these:

- connected mode requires weakening the existing local-only privacy boundary
  without a replacement threat model;
- the proposed server topology makes local collection depend on network
  availability;
- tenancy cannot be attached before data ingestion and would require inferring
  ownership after storage;
- organization aggregate access can only be implemented by granting raw session
  access;
- the selected authorization engine cannot express reverse resource listing or
  conditional tenant context without application-side ACL duplication;
- search cannot filter authorization before candidate ranking;
- session archive requires raw provider credentials or undocumented native DB
  mutation;
- a cross-harness handoff cannot distinguish observed facts from generated
  summary content;
- PostgreSQL replacement work starts rewriting the local SQLite engine without a
  measured product requirement.

## Explicit non-goals

- training or hosting a frontier model;
- building a replacement for Claude Code, Codex, OpenCode, or Cursor;
- proxying every LLM inference request;
- a public third-party plugin marketplace;
- remote shell or arbitrary command execution from the server;
- automatic organization publication based only on repository host or GitHub
  login;
- productivity scoring from tokens, lines, or session duration;
- exact native process migration between harnesses;
- synchronizing uncommitted worktrees or secrets.

## Documentation ownership

Plan 100 must propose the necessary ADR updates before code. Later child plans
must keep these documents aligned with accepted behavior:

- `AGENTS.md` — contributor entry point and runtime invariants;
- `CONTEXT.md` — new ubiquitous language (`space`, `person`, `device`,
  `repository`, `project`, `checkout`, `memory item`, `handoff`, `work thread`,
  `replication generation`);
- `docs/architecture.md` — local and shared data flows;
- `docs/adr/README.md` — accepted decisions and supersession links;
- package/app READMEs — exact writer, reader, and protocol ownership.
