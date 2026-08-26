# Plan 100: Define the Platform Topology, Capability Modules, and Data Ownership

> **Executor instructions**: This is an architecture decision plan. Do not add
> PostgreSQL, authentication, synchronization, or Agent Memory production code
> until the decision deliverables and ADRs below are accepted. Read the current
> architecture and every ADR referenced by `docs/adr/README.md`; this plan must
> extend the existing local system rather than redescribe it from scratch.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- AGENTS.md CONTEXT.md docs/architecture.md docs/adr package.json tools/check-package-boundaries.ts apps packages`
> Reconcile any drift affecting process ownership, the SQLite data plane,
> browser contracts, or package boundaries before editing the plan deliverables.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: MEDIUM — documentation-only when executed correctly, but it governs
  every later migration
- **Depends on**: none
- **Category**: architecture and product topology
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

The current architecture is intentionally local and explicit:

- `apps/usage-engine` is the sole production writer of the durable SQLite data
  plane;
- Web and CLI read revision-keyed projections through read-only connections;
- authenticated numeric-loopback HTTP is a control plane, not a report-data API;
- the SvelteKit browser boundary is contract-first through oRPC;
- Skills are a separate filesystem control-plane domain;
- package boundaries are executable repository policy.

The proposed platform direction adds a shared server, identities, organizations,
Agent Memory, synchronization, and cross-harness continuity. If those features
are added opportunistically, the repo will end up with competing meanings for
“server”, “control plane”, “database”, “project”, and “owner”. This plan locks a
coherent topology first.

## Deliverables

This plan produces decisions and contracts only:

1. accepted or rejected ADRs for the topology choices below;
2. an updated architecture diagram and data-ownership matrix;
3. new ubiquitous-language entries in `CONTEXT.md`;
4. proposed package/app boundaries and dependency rules;
5. a capability-module contract precise enough for later plans to implement;
6. an explicit compatibility statement for existing local mode.

It must not create empty speculative packages solely to mirror the diagram.

## Proposed runtime topology

### Local runtime

```text
apps/usage-engine
  owns:
    - collection scheduling and source attempts
    - local machine identity
    - the only write-capable SQLite composition
    - local immutable report publication
    - replication outbox production
    - local operational diagnostics

apps/web (local mode)
  owns:
    - the SvelteKit application shell
    - read-only local report/query adapters
    - local control-plane commands through existing contracts
    - local capability presentation

apps/cli
  owns:
    - terminal adapters over local application capabilities
    - no direct collector or write-store composition
```

### Shared runtime

```text
apps/server (future)
  owns:
    - authenticated external HTTP endpoints
    - one shared application-service composition root
    - one PostgreSQL write composition root
    - device ingestion, identity, authorization, memory, shared reads, jobs
    - no access to machine-local harness files

apps/web (connected mode)
  remains the same product and frontend codebase
  resolves shared read/write adapters when connected
  never imports PostgreSQL or authorization-engine clients into browser code
```

The exact server framework is not selected here unless a later implementation
spike proves it. The architectural contract is more important than the HTTP
library.

## Proposed data planes

### Local operational data plane — SQLite

Owns data whose correctness depends on a specific machine or local filesystem:

- collection checkpoints and attempts;
- source enablement and source-control state;
- local harness observations and parser caches;
- quota observations collected on that machine;
- local machine identity and checkout paths;
- immutable local report revisions;
- unsent replication outbox and acknowledgements;
- local-only operational diagnostics.

### Shared platform data plane — PostgreSQL

Owns data whose value is cross-machine, cross-session, or multi-user:

- spaces, people, auth identities, SCM accounts, teams, and memberships;
- enrolled devices and revocable device credentials;
- repositories, aliases, projects, and checkouts;
- replicated session facts and their source-device provenance;
- shared usage projections and organization aggregates;
- Agent Memory observations, proposals, items, revisions, edges, and chunks;
- handoffs and work threads;
- authorization resource identities and audit events.

### Filesystem data

Remains authoritative only where the product intentionally manages files:

- harness-owned histories are source inputs, never ai-usage storage;
- Skills source repositories and runtime projections retain their current
  ownership rules;
- Agent Memory Markdown/JSONL becomes import/export/projection data after plan
  105, not the shared source of truth;
- generated artifacts remain disposable and are never database substitutes.

## Data-ownership matrix

The executor must add a version of this matrix to `docs/architecture.md` with
exact package/app names once accepted.

| Concern | Authoritative owner | Local availability | Shared availability |
| --- | --- | --- | --- |
| Harness raw history | harness | yes | no by default |
| Collection checkpoint | local usage-engine/SQLite | yes | no |
| Normalized local session fact | local usage-engine/SQLite | yes | replicated copy |
| Shared session fact | server/PostgreSQL | cached/optional | yes |
| Skills source/projection | Skills domain/filesystem | yes | future policy only |
| Memory item | Memory domain/PostgreSQL in connected mode | local cache/export | yes |
| Local-only memory | Memory domain/local store | yes | no unless published |
| Handoff | Memory/Handoff domain | yes | yes when published |
| Organization aggregate | server projection | optional cache | yes |
| Device credential | auth/device service | private local secret | verifier/metadata |

The matrix must distinguish “authoritative original”, “replicated fact”, and
“derived projection”. A replicated row does not grant the server authority over
the machine’s harness files.

## Capability modules

The platform should support internal capabilities without creating a public
runtime plugin system prematurely.

### Proposed capability descriptor

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

Initial conceptual capability IDs:

```text
usage
sources
skills
sync
memory
handoff
recommendations
organization-governance
```

This does **not** authorize:

- arbitrary dynamic imports from user-supplied packages;
- capability-owned migration histories that can be installed in any order;
- browser discovery of server implementation modules;
- a separate Web app for each capability.

### Activation semantics

A capability may be disabled by deployment or space policy. Disabled means:

- no navigation entry;
- no public route or MCP tool registration;
- no background job execution;
- commands fail with an explicit capability-disabled result.

Disabled does not mean its historical tables vanish or its migration is skipped.
The server schema follows one reviewed migration sequence.

### Initial implementation restraint

Do not implement a generic registry until at least two new capabilities would
otherwise duplicate real composition behavior. Plan 100 may define the contract
and dependency direction; plan 101 or 105 may implement the smallest registry
needed by real consumers.

## Application-service rule

Every domain with multiple adapters must expose application services or ports:

```text
Domain/application service
  ↑            ↑            ↑            ↑
Web/oRPC       CLI          MCP          Jobs
```

MCP is never the internal transport between these adapters. Drizzle repositories
are never imported directly by Web handlers or MCP tool definitions.

## Contract and ORM separation

The plan must record this rule in the architecture and package-boundary policy:

- Drizzle table definitions and inferred row types belong to a PostgreSQL
  adapter package;
- public commands, results, event envelopes, oRPC schemas, sync contracts, and
  MCP schemas use explicit domain types with runtime validation;
- mapping code is deliberate and tested;
- database migrations may change storage representation without silently
  changing wire contracts.

## Proposed package/app direction

Names remain provisional until the executor validates them against current
conventions. Prefer fewer real boundaries over many empty packages.

```text
apps/server                    # shared composition root

packages/platform-core         # pure IDs/value objects/contracts
packages/postgres-store        # Drizzle schema, migrations, repository adapters
packages/authorization         # Authorizer port and model adapters
packages/identity              # application/domain identity services
packages/project-registry      # repository/project/checkout rules
packages/memory                # memory domain/application services
packages/memory-search         # authorized search adapter
packages/replication           # device protocol and server ingest application
packages/mcp-adapter           # MCP transport over application services
```

The executor must update `tools/check-package-boundaries.ts` only when a real
package is introduced. Do not weaken existing rules globally to make future
imports convenient.

## Ubiquitous language to add

Plan 100 must propose exact `CONTEXT.md` entries for:

- **Person**: the human represented by ai-usage; avoid “user” when login or SCM
  identity is meant.
- **Authentication identity**: one login method linked to a Person.
- **SCM account**: a GitHub/GitLab identity or installation used to resolve
  repositories; not necessarily a login identity.
- **Device**: one enrolled machine runtime with an independent credential.
- **Space**: the ownership and authorization root; personal or organization.
- **Repository**: one SCM repository identity, independent of its current URL.
- **Project**: an ai-usage work identity, optionally bound to a repository and
  subpath.
- **Checkout**: a project’s local path on one device.
- **Capture context**: the explicit person/space/project/SCM assignment applied
  when a device publishes an observation.
- **Replication generation**: a monotonic device publication checkpoint.
- **Memory observation / proposal / item / revision**.
- **Handoff** and **Work thread**.

The executor must also resolve whether “control plane” stays reserved for the
existing local engine command surface. Recommended outcome: keep that precise
meaning in code/docs and call the broader product layer “platform” or
“operations layer”.

## ADR work

Create or amend ADRs covering at least:

1. one monorepo and one Web product with multiple runtime compositions;
2. local SQLite plus shared PostgreSQL rather than PostgreSQL replacing local
   storage;
3. internal capability modules before a public plugin system;
4. DB-native Agent Memory with files as adapters;
5. MCP as an edge adapter;
6. stable project IDs with repository locators;
7. relationship-based authorization and content/aggregate separation;
8. outbound-only device replication;
9. handoff-first cross-harness continuity.

Do not pack unrelated decisions into one giant ADR if they have independent
reversal conditions. Every new ADR must link to the current ADRs it extends or
supersedes.

## Verification

This plan is complete when:

- the architecture diagram shows both local and shared runtimes and every write
  composition root;
- the data-ownership matrix has no row with two authorities;
- local mode has an explicit compatibility contract;
- capability activation semantics are documented without promising a public SDK;
- ORM/domain separation is documented and reflected in proposed boundary tests;
- the terminology above is added or deliberately rejected;
- every topology decision has an accepted ADR or a recorded rejection;
- plans 101–110 can reference stable terms instead of redefining them.

## STOP conditions

Stop and return to the maintainer when:

- an accepted current ADR forbids a proposed topology and the relationship
  cannot be expressed as a scoped supersession;
- a proposed shared runtime would need direct access to local harness files;
- local Web or CLI must become network-dependent;
- “one product” is interpreted as one process or one database;
- the capability design requires arbitrary third-party code execution;
- the only way to share contracts is to export Drizzle row types across every
  layer;
- process or data ownership cannot be described without two writers to the same
  database.

## Out of scope

- selecting a hosted PostgreSQL provider;
- implementing `apps/server`;
- selecting the final authentication library;
- writing an OpenFGA/SpiceDB model;
- moving Agent Memory data;
- changing the current local report UI;
- implementing capability billing or a marketplace.
