# Plan 099: Evolve ai-usage Into a Multi-Tenant AI Operations and Memory Platform (program plan)

> **Executor instructions**: This is the umbrella for plans 100–110. Do not
> implement production behavior directly from this file. Execute each child in
> the phase and dependency order below, read it in full, honor its STOP
> conditions, and update `plans/README.md` only after its done criteria pass.
> A measured rejection is a valid outcome for a spike.
>
> **Drift check (run first)**: compare the current branch with the plan baseline,
> then re-read `AGENTS.md`, `CONTEXT.md`, `docs/architecture.md`,
> `docs/adr/README.md`, `tools/check-package-boundaries.ts`,
> `tools/check-typescript-coverage.ts`, and
> `tools/check-public-package-exports.ts`. Existing local ownership rules remain
> authoritative until an accepted ADR explicitly amends them.

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

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

ai-usage is currently a local, single-operator product with strong boundaries:
one usage SQLite writer, direct read-only report queries, provider-free local
history, and an operational loopback control plane. The next product value is a
neutral operations, memory, and continuity layer across harnesses and devices,
without turning local collection into a network-dependent service.

The program must let a developer:

- preserve and search durable Agent Memory while offline;
- continue work across Claude, Codex, OpenCode, and Cursor through reviewed
  Work handoffs;
- publish selected facts and accepted knowledge to a shared server;
- keep personal and organization data separate;
- expose aggregate usage without implicitly exposing prompts, session detail,
  repository metadata, or Memory content.

## Locked program topology

```text
Local/offline mode
  harness histories
      ↓
  existing local runtime composition
      ├─ usage SQLite (existing report data plane)
      ├─ dedicated Memory SQLite (DB-native Agent Memory + Work handoffs)
      ├─ local FTS5 search
      ├─ local MCP adapter
      └─ durable outbound replication outbox

Connected mode
  Device ── outbound HTTPS ── shared server application services
                                  ├─ PostgreSQL shared platform authority
                                  ├─ organization authorization
                                  ├─ shared FTS + pg_trgm search
                                  ├─ shared Work handoffs
                                  └─ opt-in encrypted session archives
```

The database is authoritative in both modes. Markdown and JSONL are
import/export/projection formats, never a second mutation authority.

Local Memory is available without a server, account, network, or PostgreSQL.
PostgreSQL is authoritative for published/shared Memory and connected product
state. The same domain contracts and application-service interfaces are used by
the SQLite and PostgreSQL adapters.

One local process owns every write-capable connection to the dedicated Memory
SQLite store. Prefer composing this ownership in the existing local runtime.
Introduce another process only when a concrete lifecycle requirement is
documented. Web, CLI, and MCP never open independent write-capable SQLite
connections. If Memory needs a local service/IPC boundary, define it separately;
do not broaden the existing report-less usage-engine control-plane vocabulary
implicitly.

## Locked architectural decisions

1. **One monorepo and one product** with explicit local and shared runtime
   compositions.
2. **Internal capability modules before a public plugin SDK**. Migrations remain
   one reviewed sequence; trusted runtimes do not load arbitrary third-party
   code.
3. **Two local databases with explicit owners**: the existing usage SQLite
   remains the usage data plane; a dedicated SQLite store owns local Memory,
   Work handoffs, local FTS5 indexes, and their replication outbox.
4. **PostgreSQL is the shared authority**, not a replacement for local SQLite.
5. **Agent Memory is DB-native in both modes**. The NixOS Agent Memory remains
   the migration source and temporary compatibility implementation until parity
   is demonstrated.
6. **MCP is an edge adapter** over application services, never the internal bus
   and never a database adapter.
7. **Stable Project IDs are primary**; repository identities and URLs are
   locators. Non-Git projects and monorepo subpaths remain first-class.
8. **Person, authentication identity, SCM account, SCM installation, SCM
   credential, Device, and Device credential are distinct concepts**.
9. **The application owns the `Authorizer` port**. Plan 102 introduces the port
   and `SingleUserAuthorizer`; plan 103 adds the full organization model.
10. **V1 organization authorization uses domain-specific PostgreSQL relations
    and explicit queries**, not a generic Zanzibar-like DSL/interpreter.
    OpenFGA is the pre-designated escape hatch when plan 103's measured triggers
    fire.
11. **Aggregate permission is not content permission**. Dedicated aggregate
    projections never require loading content and masking it afterward.
12. **Search filters through the complete authorized relation before ranking**.
    No arbitrary authorization scope limit, post-filter, or forbidden candidate
    may affect counts, snippets, cursors, rank, statistics, or semantic score.
13. **Search is lexical first**: local SQLite FTS5 and shared PostgreSQL FTS plus
    `pg_trgm` use one evaluation corpus and result contract. `pgvector` remains
    gated by measured semantic-recall failure.
14. **Clients initiate synchronization**. No machine opens an inbound peer port
    or performs LAN discovery.
15. **Work handoff precedes native session conversion**. The domain names are
    `WorkHandoff`, `WorkHandoffId`, and `WorkHandoffStatement`; continuation
    starts a normal target session and never forges private harness storage.
16. **GitHub sign-in is the only normal V1 shared-server login**. First-owner
    bootstrap authorizes the first successful GitHub identity; it does not
    support users who cannot use GitHub. Local-only mode needs no login.
17. **Machine-generated bearer tokens use an efficient keyed digest**:
    `public_token_id + random_secret`, with only the ID and
    `HMAC-SHA-256(deployment_token_key, random_secret)` stored. Argon2id is
    reserved for future human passwords.
18. **Sensitive session archives are opt-in and envelope-encrypted** with one
    per-Space DEK wrapped by a deployment KEK supplied outside PostgreSQL.
    This protects a leaked DB/backup without the KEK; it does not claim
    end-to-end encryption or guaranteed cryptographic erasure of every backup.

## Vocabulary collisions that must remain resolved

- `UsageEngineHandoff*` is the existing CLI-to-engine staged-file transport.
- imported Memory `kind: "handoff"` is retained only for legacy import
  fidelity.
- **Work handoff** / `WorkHandoff*` is the new cross-harness domain.
- `SourceAuthority` is filesystem-trust provenance, not principal permission.
- `Project source`, `Project group`, and cross-device `Project` remain distinct.
- **Control plane** stays reserved for the authenticated numeric-loopback
  usage-engine surface. The shared server is the platform/server surface.

## Existing repository work to reuse

- `packages/report-core/src/session-vcs.ts` already normalizes HTTPS and
  SCP-style SSH repository remotes; extend it instead of rewriting it.
- `packages/usage-engine-control/src/secret.ts` already provides a branded,
  redacted secret representation; reuse its rendering discipline for device
  credentials while keeping the types distinct.
- `usage_store_metadata` generations and `CONTEXT.md`'s **Source publication**
  provide the acknowledgement discipline for replication.
- `packages/skills/src/projection-lock.ts` and the unmanaged-entry rule provide
  the safe harness-configuration projection pattern for MCP registration.
- `tools/check-package-boundaries.ts` permanently retires `lan-pairing` and
  `sync`; outbound-only replication must preserve that boundary.

Every real package must also register its TypeScript project, dependency
boundary, and public exports through the three repository checks named in the
drift check. Do not create empty packages merely to match an architecture
diagram.

## Child plans and dependencies

| Plan | Title | Priority | Effort | Depends on |
| --- | --- | --- | --- | --- |
| 100 | Define the Platform Topology, Capability Modules, and Data Ownership | P0 | L | - |
| 101 | Add the PostgreSQL Server Foundation Without Replacing the Local SQLite Engine | P0 | L | 100 |
| 102 | Introduce Stable Spaces, People, Devices, Repositories, Projects, and Checkouts | P0 | L | 100, 101 |
| 103 | Model Authorization With ReBAC, Content Boundaries, and Aggregate-Only Roles | P0 | XL | 100–102 |
| 104 | Add Authentication, GitHub Identity Separation, and Device Enrollment | P1 | L | 102, 103 |
| 105 | Migrate Agent Memory From NixOS Files Into a DB-Native Domain | P1 | XL | 100–102 |
| 106 | Build Authorized Hybrid Memory Search and a Harness-Agnostic MCP Adapter | P1 | XL | 102, 105; 103, 104 for organization-connected activation |
| 107 | Replicate Local Machine Facts to the Server With an Idempotent Outbox Protocol | P1 | XL | 101–105 |
| 108 | Add Cross-Harness Work Handoffs and Work Threads | P1 | L | 102, 105, 106 for local; 107 for connected |
| 109 | Archive Session Detail Safely for Cross-Machine Read-Only Continuity | P2 | L | 103, 104, 107, 108 connected |
| 110 | Spike Native Session Portability Across Claude, Codex, OpenCode, and Cursor | P2 | L spike | 108, 109 |

## Execution order

The first milestone validates product value before enterprise plumbing:

```text
100 topology and language
  ↓
101 minimal PostgreSQL/server foundation
  ↓
102 personal Space + Person + Device + Repository + Project + Checkout
    + Authorizer port + SingleUserAuthorizer
  ↓
105 DB-native Memory: local SQLite + shared PostgreSQL adapters
  ↓
106 local FTS5/shared FTS+trigram search + local MCP
  ↓
108 local WorkHandoff vertical slice
```

The second milestone completes connected, multi-tenant behavior:

```text
102 identity kernel
  ↓
103 full organization authorization
  ↓
104 GitHub authentication + Device enrollment
  ↓
107 connected multi-device replication
  ↓
108 connected WorkHandoff extension
  ↓
109 sensitive session archives
  ↓
110 native portability spike
```

Plan 103 may be implemented in parallel with the 105–108 local-value path after
102, but full ReBAC must not block the single-user Memory proof. Plan 108 is one
plan with two explicit phases; its local phase lands before its connected phase.

## Cross-cutting invariants

### Local mode is a complete product

- Local Usage, Skills, Memory, search, MCP, and Work handoffs work with no
  account, network, shared server, or PostgreSQL.
- Platform absence is proved by injecting a connection adapter that fails the
  test if invoked, not by asserting that no unrelated PostgreSQL process exists.
- Collection and local writes never wait for replication.
- The manual merge bundle remains a bootstrap/recovery/air-gapped fallback.

### Writer ownership is explicit

- `apps/usage-engine` remains the only production writer to the existing usage
  SQLite database.
- One local process owns the Memory SQLite writer and its outbox.
- The shared server has one PostgreSQL write composition root.
- Web, CLI, MCP, routes, and jobs call application services; they do not open
  arbitrary write-capable stores.

### Tenant and content boundaries fail closed

- Shared resources belong to an explicit personal or organization Space.
- Device, path, repository, or SCM identity never silently assigns organization
  ownership.
- Aggregate usage, session metadata, session content, Memory content, Work
  handoff content, and raw local artifacts are distinct permission/data classes.
- Authorization is never route-local or application-side post-filtering.

### Contracts are independent of storage

Drizzle/SQLite rows remain adapter-private. Commands, results, replication
envelopes, oRPC schemas, MCP schemas, and domain IDs are explicitly validated
contracts shared across adapters.

### Native harness stores remain read-only

No child writes undocumented Claude, Codex, OpenCode, or Cursor session stores.
Plan 110 may investigate official portability in disposable environments only.

## Program product gates

1. Existing local report, Skills, sources, CLI, and usage-engine behavior stays
   green without platform configuration or a PostgreSQL connection attempt.
2. Local Memory can record, accept, revise, search, and retrieve through MCP
   while offline using SQLite and FTS5.
3. A local accepted `WorkHandoff` can be retrieved by another harness through
   the normalized MCP tools without a shared server.
4. Two enrolled synthetic Devices can publish while either is offline, and the
   shared read model retains acknowledged provenance and freshness.
5. Replication adds no inbound client listener.
6. Personal, organization, aggregate, metadata, content, Memory, Work handoff,
   and archive permissions pass the shared conformance suite.
7. Repository rename/URL change preserves Project identity; a non-Git Project
   remains valid.
8. Search evaluates every eligible authorized candidate within query/time
   bounds and leaks no forbidden influence through result metadata or scoring.
9. The outbox proves logical fact identity, publication event identity, and
   content identity separately, including enrichment/correction.
10. Metadata-only replication works by default; sensitive archive is opt-in,
    separately deletable, and never stores raw harness files.
11. Database restore plus the matching KEK restores encrypted archives; key
    rotation works; documentation states the historical-backup limitations.

## STOP conditions

Stop and return to the maintainer when:

- local Usage or Memory requires network, login, or PostgreSQL;
- a second process must write either local SQLite store without a documented
  lifecycle and ownership decision;
- ownership must be inferred after storage;
- aggregate access requires raw content access;
- complete authorized search scope cannot be represented before ranking;
- a generic authorization interpreter/DSL is proposed for V1;
- relation writes require an untracked best-effort dual write;
- native continuation requires undocumented harness-store mutation;
- Work handoff evidence cannot distinguish observed, declared, and generated
  statements;
- archive encryption cannot restore from a DB backup plus the matching KEK.

## Non-goals

- hosting or proxying models;
- a public plugin marketplace;
- remote shell or arbitrary command execution;
- automatic organization publication from repository/GitHub identity;
- productivity scoring from tokens, duration, commits, or lines;
- peer-to-peer/LAN replication;
- raw harness backup or exact native process migration;
- synchronizing uncommitted worktrees or provider credentials.

## Documentation ownership

Plan 100 records accepted topology in ADRs, `CONTEXT.md`, and
`docs/architecture.md`. Later plans update those living documents only when
their implementation proves the planned behavior. Plan files remain execution
records and `plans/README.md` remains their status/dependency index.
