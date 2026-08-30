# Plan 100: Define the Platform Topology, Capability Modules, and Data Ownership

> **Executor instructions**: This plan records architecture and language before
> runtime implementation. Do not add PostgreSQL, authentication, replication,
> or Agent Memory production code here. Read the current ADR ledger and extend
> the existing local system instead of redescribing or weakening it.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- AGENTS.md CONTEXT.md docs/architecture.md docs/adr package.json tools/check-package-boundaries.ts tools/check-typescript-coverage.ts tools/check-public-package-exports.ts apps packages`

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: MEDIUM — documentation-only when executed, but governs every later
  persistence and process boundary
- **Depends on**: none
- **Category**: architecture and product topology
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: DONE

## Current repository anchors

- ADR 0009 makes `apps/usage-engine` the sole writer of the existing usage
  SQLite database. Web and CLI use its reader facade; the numeric-loopback HTTP
  surface is operational only.
- ADRs 0010 and 0012 keep browser imports contract-first and make TanStack Query
  the owner of browser server state.
- ADR 0003 keeps the synthetic runtime isolated from live stores and services.
- `CONTEXT.md` already reserves **Data plane**, **Control plane**, **Project
  source**, and **Project group** for existing local concepts.
- `tools/check-typescript-coverage.ts` is an explicit project registry;
  `tools/check-package-boundaries.ts` contains targeted architectural policies;
  `tools/check-public-package-exports.ts` enforces declared exports.
- No `apps/server`, PostgreSQL, Drizzle, generic authorization engine, or
  platform package exists at the plan baseline.

Plan 100 must create ADRs at the next free numbers at execution time. Do not
assume `0022` is still free without checking the current ledger.

## Runtime topology

### Local/offline composition

```text
apps/usage-engine
  existing usage-domain sole writer
  owns the usage SQLite write connection
  may compose the local Memory writer by default
  owns durable publication/outbox scheduling

dedicated Memory SQLite store
  Agent Memory observations/proposals/items/revisions
  Work Threads and Work handoffs
  local FTS5 index
  Memory/WorkHandoff replication outbox

apps/web / apps/cli / local MCP
  call local application services
  never open independent write-capable Memory SQLite connections
```

The Memory store is separate from the existing usage SQLite data plane. It may
share the existing runtime process because that already has supervised local
lifecycle and sole-writer discipline. A separate Memory process is permitted
only after documenting a concrete lifecycle reason, its ownership, shutdown,
lock, and IPC behavior.

The existing usage-engine **control plane** remains report-less commands,
status, and bounded SSE. Memory data or mutations must not be smuggled into that
term. If the local application services need IPC, define a separate bounded
Memory service/IPC seam and give it explicit authentication and payload rules.

### Shared composition

```text
apps/server
  authenticated external HTTP endpoints
  one application-service composition root
  one PostgreSQL write composition root
  identity, authorization, replication, shared Memory/search, Work handoffs
  no access to machine-local harness files

apps/web (connected mode)
  same product/front-end codebase
  uses contract-first shared adapters
  never imports PostgreSQL or authorization-engine clients in browser code
```

### Mode guarantees

Local/offline mode provides Usage, Skills, DB-native Memory, FTS5 search, MCP,
and local Work handoffs with no account, server, network, or PostgreSQL.

Connected mode adds organization/personal Spaces, cross-device authorized
search, shared Work handoffs, replication, and opt-in archives. PostgreSQL is
authoritative for published/shared resources. The local SQLite authority is not
silently replaced by a cache of PostgreSQL.

## Data ownership

No logical row has two mutation authorities. A replicated fact is a server-owned
projection of an explicitly published local fact, not authority over the source
machine or harness file.

| Concern | Authority | Local availability | Connected availability |
| --- | --- | --- | --- |
| Harness raw history | harness | yes | never by default |
| Usage checkpoints/report revisions | usage-engine + usage SQLite | yes | replicated projection only |
| Local Agent Memory | Memory application + Memory SQLite | yes | published by policy |
| Shared Agent Memory | Memory application + PostgreSQL | imported/exported locally | yes |
| Local Work Thread/Work handoff | Work application + Memory SQLite | yes | published by policy |
| Shared Work Thread/Work handoff | Work application + PostgreSQL | replicated/projected | yes |
| Local Memory search | SQLite FTS5 projection | yes | n/a |
| Shared Memory search | PostgreSQL FTS + `pg_trgm` projection | no direct DB access | yes |
| Replication event | source SQLite outbox until ACK; server receipt afterward | yes | yes |
| Space/Person/organization membership | PostgreSQL in connected mode | single-user identity kernel | yes |
| Device credential | private local secret + server verifier metadata | secret only | verifier/metadata |
| SCM account | Person-scoped provider identity | optional metadata | yes |
| SCM installation | Space-scoped repository grant | no authority locally | yes |
| SCM credential | encrypted secret/reference attached to account or installation | never inferred | yes |
| Session archive metadata/ciphertext | PostgreSQL archive service | queued projection only | opt-in |
| Skills source/projection | existing Skills filesystem domain | yes | future policy only |

Markdown/JSONL for Agent Memory are import/export/projection formats. The NixOS
Agent Memory remains the migration source and temporary compatibility
implementation until SQLite/PostgreSQL application-service parity is proven.
After migration, `.agent-memory/` remains an optional working-notes and
import/export surface, not a canonical database.

## Capability modules

Capabilities may register routes, application jobs, MCP tools, navigation, and
permissions through trusted composition. They do not own independently ordered
migration histories and cannot load arbitrary user packages.

```ts
interface PlatformCapability {
  readonly id: CapabilityId;
  readonly dependencies: readonly CapabilityId[];
  readonly permissions: readonly PermissionName[];
  readonly serverJobs: readonly ServerJobRegistration[];
  readonly localJobs: readonly LocalJobRegistration[];
  readonly mcpTools: readonly McpToolRegistration[];
  readonly navigation: readonly NavigationRegistration[];
  readonly routes: readonly RouteRegistration[];
}
```

Conceptual IDs are `usage`, `sources`, `skills`, `replication`, `memory`,
`work-handoff`, and `organization-governance`. Do not implement a generic
registry until at least two real consumers would otherwise duplicate
composition logic.

Disabled capability semantics are explicit: no navigation, public route, tool,
or job execution; commands return a typed capability-disabled result. Disabled
does not mean migrations are skipped or historical tables disappear.

## Application-service and contract rule

```text
                    application service / port
                  ↗        ↑        ↑        ↖
             Web/oRPC     CLI      MCP      jobs
                  ↓        ↓        ↓        ↓
                  persistence/transport adapters
```

- MCP is an edge adapter, not the internal bus.
- Route handlers and MCP tools never implement permission logic or instantiate
  write repositories.
- SQLite and PostgreSQL adapters implement the same domain/application ports.
- Drizzle/inferred storage types stay inside the PostgreSQL adapter.
- Public commands, results, events, oRPC, replication, and MCP contracts are
  explicit runtime-validated domain types.

## Package direction

Names are provisional until real code proves a boundary. Prefer fewer deep
packages over empty speculative ones.

```text
apps/server
packages/platform-core          pure IDs/value objects/contracts if needed
packages/postgres-store         shared schema/migrations/adapters
packages/authorization          Authorizer port/adapters
packages/identity               auth and identity application services
packages/project-registry       project/repository resolution
packages/memory                 shared domain/application services
packages/memory-sqlite          local Memory adapter, if a separate package helps
packages/memory-search          FTS5/PostgreSQL search adapters
packages/replication-protocol   pure replication contract
packages/mcp-adapter            MCP transport over application services
packages/work-threads           Work Thread/WorkHandoff domain services
```

Only introduce a package with a real consumer. On introduction:

1. add its `tsconfig` to `TYPECHECK_PROJECTS`;
2. add focused dependency/import policies and mutation tests when it owns an
   architectural rule;
3. declare every cross-package subpath in `package.json#exports`.

Do not weaken current Web/CLI/usage-store/engine-runtime allowlists to make the
future topology convenient.

## Ubiquitous language

Plan 100 adds or amends exact `CONTEXT.md` entries for:

- **Person** — the human, independent of login and provider accounts;
- **Authentication identity** — one verified login identity linked to Person;
- **SCM account** — one Person-scoped provider identity; `person_id` required;
- **SCM installation** — one Space-scoped provider installation/repository
  grant, not owned by one Person;
- **SCM credential** — encrypted recoverable secret/reference attached to an
  SCM account or installation;
- **Device** — one local runtime identity; credential is separate;
- **Space** — personal or organization ownership/authorization root;
- **Repository**, **Project**, **Checkout**, **Capture context**;
- **Replication generation**, **Memory observation**, **Memory proposal**,
  **Memory item**, **Memory revision**;
- **Work handoff** and **Work thread**.

The entries must preserve these collisions:

1. `UsageEngineHandoff*` is staged-file transport.
2. imported Memory `kind: "handoff"` is a legacy record value.
3. `WorkHandoff*` is cross-harness continuity.

**Control plane** remains the existing local engine seam. Name the shared layer
the platform/server. **Data plane** must distinguish the existing usage SQLite,
the dedicated local Memory SQLite, and the shared PostgreSQL authority without
implying that readers query all three directly.

## ADR work

Create focused ADRs for:

1. one monorepo with local and shared compositions;
2. existing usage SQLite plus dedicated Memory SQLite plus shared PostgreSQL;
3. internal capability modules before a public plugin SDK;
4. DB-native Agent Memory in both modes, files as adapters;
5. MCP as an edge adapter;
6. stable Project identity, repository as locator;
7. application-owned `Authorizer`, SingleUser local mode, and full ReBAC later;
8. domain-specific PostgreSQL authorization with OpenFGA escape triggers;
9. outbound-only replication;
10. Work handoff before native conversion;
11. separated Person/auth/SCM account/SCM installation/Device concepts;
12. complete authorization before search ranking;
13. opt-in normalized session archives and honest envelope-encryption limits.

Each ADR names one rejected alternative and a reversal condition. Amend ADR
0009 only to clarify that its sole-writer decision still governs the existing
usage SQLite data plane; do not imply Web/CLI may write either local database.

## Steps

### Step 1: Resolve language before schema

Update `CONTEXT.md` with the terms above. Read it end-to-end and ensure no
shared service is called the usage-engine control plane and no Work handoff is
called bare `Handoff` in the new domain.

### Step 2: Record ADRs

Check the next free ADR ordinal, write one decision per file, update the ADR
index, and maintain supersession/amendment bookkeeping. Do not create ADRs from
the plan numbers by assumption.

### Step 3: Record runtime and data ownership

Add the two runtime compositions and data-ownership matrix to
`docs/architecture.md`. Preserve the existing local usage flow verbatim and add
the Memory SQLite writer/reader/IPC boundary without broadening ADR 0009.

### Step 4: Record local compatibility

Document that local Usage, Skills, Memory, FTS5 search, MCP, and Work handoffs
work with no account/network/PostgreSQL. The future executable test injects a
platform connection adapter that throws if invoked and asserts zero calls while
local commands pass. It does not inspect global process tables.

### Step 5: Register plans and contributor entry points

Update `AGENTS.md` with one pointer to plan 099, register plans 099–110 in
`plans/README.md`, and set this plan to DONE only after the documents agree.

### Step 6: Record remaining deferrals

Only implementation details with no effect on the contracts may remain
deferred, such as the server HTTP framework, hosted PostgreSQL provider, and
final package granularity. Authorization engine direction, local Memory
topology, writer ownership, login support, and encryption guarantees are not
deferred.

## Verification

- every new ADR link resolves and the next-free ordinal was checked live;
- `CONTEXT.md`, `docs/architecture.md`, plan 099, and `plans/README.md` describe
  the same topology and DAG;
- the data matrix has one mutation authority per logical resource;
- local Memory remains an unconditional offline capability without platform
  configuration;
- `WorkHandoff*` terminology and the three legacy/current handoff meanings are
  explicit;
- `bun run lint` and the repository documentation checks pass.

## STOP conditions

Stop and return to the maintainer when:

- an accepted ADR cannot be amended narrowly enough for this topology;
- local Web/CLI/Memory becomes network- or login-dependent;
- a new process is required but its write/lock/shutdown/IPC ownership is not
  concrete;
- one resource has two mutation authorities;
- arbitrary capability code must run in trusted processes;
- Drizzle rows must become public contracts;
- a shared server needs direct local harness-file access.

## Out of scope

- implementing packages, apps, migrations, authentication, authorization,
  replication, Memory, MCP, or Work handoffs;
- choosing a hosted PostgreSQL provider;
- public third-party plugin APIs or billing;
- changing the current local report UI.
