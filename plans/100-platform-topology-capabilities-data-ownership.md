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

## Current state

This plan is documentation-only, but it edits four registries that already have
an exact shape. Read them before writing anything.

### The ADR ledger — next free number is `0022`

- `docs/adr/README.md:12-34` is the index table; the last row is
  `| [0021](0021-design-system-promotion-policy.md) | Design-system promotion requires a second consumer | 2026-08-25 | Accepted |`.
- `docs/adr/README.md:40-46` ("Writing a new ADR") is binding on format: title
  `# ADR NNNN: …`, a bold list with **Status** and **Date** plus
  **Amends**/**Supersedes**/**Amended by**, short Context/Decision/Consequences,
  **one named rejected alternative**, and Evidence linking to living code or plans.
- `docs/adr/README.md:5-9` records the 2026-08-25 renumbering. Do not reuse
  0009 or 0002 semantics from old plan prose.

The ADRs this plan will extend, and the exact clauses at risk:

| ADR | Clause this program touches |
| --- | --- |
| [0009](../docs/adr/0009-sole-writer-usage-engine-and-direct-sqlite-readers.md) | "sole writer" is scoped to the local usage SQLite database — the shared PostgreSQL writer is a **second** data plane, not a second writer to the same one |
| [0010](../docs/adr/0010-sveltekit-contract-first-browser-boundary.md) | browser imports only the oRPC contract — connected mode must not leak a PostgreSQL or authorization client into browser code |
| [0012](../docs/adr/0012-tanstack-query-browser-server-state-ownership.md) | one named Query policy per data identity — shared/remote reads are new data identities, not variants of the local ones |
| [0003](../docs/adr/0003-isolated-synthetic-runtime.md) | the demo runtime stays isolated — it must keep working with no PostgreSQL |
| [0016](../docs/adr/0016-collect-everything-present-faithfully.md) | partial data is presented faithfully — replicated data adds a freshness/provenance axis, it does not add a "data quality" flag |

### `CONTEXT.md` — 31 terms, and two real collisions

`CONTEXT.md:5` opens `## Language`; terms run `CONTEXT.md:7-138`. Two entries
collide with vocabulary this program proposes:

- `CONTEXT.md:42-46` **Control plane** = "the authenticated numeric-loopback
  usage-engine surface carrying only commands, status, and bounded sanitized SSE
  events", with _Avoid_: "remote service". A shared server is exactly the thing
  that entry tells you not to call a control plane.
- `CONTEXT.md:96-103` **Project source** ("a machine-scoped project path carried
  by a usage row … identity combines the machine and source path") and **Project
  group** ("an explicit local configuration that presents multiple project
  sources as one named project"). The program's **Project** is a third concept:
  a durable cross-device work identity. Three "project" words cannot ship
  undifferentiated.

`CONTEXT.md:37-41` **Data plane** is currently defined as the local SQLite
database specifically. The program's "two planes" language needs this entry
amended, not duplicated.

### `docs/architecture.md` — where the new material lands

- `:20-52` Data flow — currently one local pipeline; gains a shared runtime.
- `:53-158` Runtime and process ownership — `:55` Usage engine, `:77` Control
  plane, `:98` Read path, `:120` Supervision, `:139` SQLite backup.
- `:159-393` Package ownership — one `###` block per package, 15 today.
- `:421-466` Preserved domain invariants.
- `:467-478` Guardrails — names `bun run lint` as the enforcement seam.

### Boundary tooling — the three package checks

Any package this program later creates must satisfy all three checks; only the
first and third are automatically exhaustive:

1. `tools/check-typescript-coverage.ts:4-20` — `TYPECHECK_PROJECTS`, an explicit
   list of 16 tsconfig paths. Register the new `tsconfig`; the checker also scans
   tracked TypeScript and reports uncovered files.
2. `tools/check-package-boundaries.ts:61-133` — `boundaryPolicies`, currently 10
   targeted architectural policies rather than a complete package registry. Add
   a policy and focused checker test for each new dependency invariant. Note
   `:52` `retiredPackages` (`lan-pairing`, `sync`) — the precedent for naming a
   package that must never be imported again.
3. The workspace package's own `package.json` `exports` —
   `tools/check-public-package-exports.ts` rejects any
   cross-package import of a subpath not declared there. See
   `packages/usage-store/package.json:6-11` for the four-subpath pattern
   (`./reader`, `./writer`, `./testing`, `./performance-testing`) that already
   encodes read/write separation *in the module graph*.

`tools/check-package-boundaries.ts:153-162`
(`engineRuntimeAllowedWorkspaceDependencies`) is an allowlist, not a denylist —
the strictest existing pattern, and the one to copy for a server composition root.

### What does not exist yet

No `apps/server`, no PostgreSQL dependency, no Drizzle, no authorization engine,
no `packages/platform-core`. `grep -r "drizzle\|postgres" package.json packages
apps` returns nothing. This plan creates **no** code — it only decides.

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
10. separation of Person, authentication identity, SCM account, and Device
    credential;
11. authorization before candidate ranking in every search mode;
12. opt-in normalized session archives with raw artifacts excluded.

Do not pack unrelated decisions into one giant ADR if they have independent
reversal conditions. Every new ADR must link to the current ADRs it extends or
supersedes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check before starting | `git rev-parse --short HEAD` | compare to `dac2214c`; if moved, re-read the five documents in Current state |
| Confirm next ADR number | `ls docs/adr/ \| grep -c '^0'` | `21` → next free is `0022` |
| Confirm no stack was pre-installed | `grep -rl "drizzle\|postgres\|openfga\|spicedb" package.json packages apps` | no output |
| Format | `bun x ultracite fix` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Link check on new ADR paths | `for f in $(grep -o '(0[0-9]\{3\}-[a-z0-9-]*\.md)' docs/adr/README.md \| tr -d '()'); do test -f docs/adr/$f \|\| echo "MISSING $f"; done` | no output |
| Full verification | `bun run check` | exit 0 |

No test suite covers Markdown. The gate for this plan is that `bun run lint`
stays green and every ADR link resolves — a broken relative link in
`docs/adr/README.md` is the one mechanical failure mode here.

## Git workflow

- Branch: `plans/ai-platform-roadmap` (this plan and 101+ are separate commits on
  the program branch). Stage by explicit path — peer sessions write to this
  worktree, so never `git add -A`.
- Files this plan may touch, and no others:
  `docs/adr/0022-*.md` … `docs/adr/0033-*.md`, `docs/adr/README.md`,
  `CONTEXT.md`, `docs/architecture.md`, `AGENTS.md`, `plans/README.md`,
  `plans/100-platform-topology-capabilities-data-ownership.md`.
- One commit. Suggested message:
  `docs(adr): accept the platform topology, data ownership, and capability-module decisions`
- **Do not push or open a PR.** This plan locks twelve architectural decisions;
  the maintainer reviews before anything downstream starts.

## Steps

### Step 1: Resolve the three vocabulary collisions first

Everything else references these words, so fix them before writing ADRs.

1. **`Control plane`** — amend `CONTEXT.md:42-46` in place. Keep the existing
   definition verbatim and append one sentence:

   ```markdown
   **Control plane**:
   The authenticated numeric-loopback usage-engine surface carrying only commands,
   status, and bounded sanitized SSE events. This term stays reserved for the local
   engine seam; the shared multi-device server layer is the **platform**, never a
   "remote control plane".
   _Avoid_: data API, report transport, remote service, shared server surface
   ```

2. **`Data plane`** — amend `CONTEXT.md:37-41`. It currently names SQLite as
   *the* data plane; make it the *local* one and name its sibling:

   ```markdown
   **Data plane**:
   A durable store queried directly by readers rather than through a command
   surface. The **local data plane** is the SQLite database read through
   read-only/`query_only` connections by Web and CLI. The **platform data plane**
   is the shared PostgreSQL database, readable only through server application
   services. A reader never spans both in one query.
   _Avoid_: control HTTP, report endpoint, "the database"
   ```

3. **`Project`** — do **not** redefine `Project source` (`CONTEXT.md:96-103`) or
   `Project group` (`:100-103`). Add a third entry after them that states the
   relationship explicitly:

   ```markdown
   **Project**:
   A durable cross-device work identity, optionally bound to a repository and a
   subpath. It survives repository rename, transfer, URL change, and mirroring, and
   exists for non-Git work too. A **project source** is one machine-scoped path
   observed on one device; a **project group** is a local presentation alias. A
   project may resolve many project sources across many devices; neither of the
   local concepts is its primary key.
   _Avoid_: project source, project group, repository, folder name
   ```

**Verify**: `bun run lint` → exit 0. Re-read `CONTEXT.md` end to end and confirm
no remaining entry uses "control plane" to mean the shared server.

### Step 2: Add the remaining ubiquitous-language entries

Append to `CONTEXT.md` in this order, each following the existing three-line
shape (**Term**: / definition / `_Avoid_:`). The `_Avoid_` list is binding, so
populate it with the word you actually expect an agent to reach for by mistake.

| Term | Definition core | `_Avoid_` must include |
|---|---|---|
| **Person** | the human ai-usage represents, independent of any login | user, account, member |
| **Authentication identity** | one login method linked to a Person | user, GitHub account, credential |
| **SCM account** | a GitHub/GitLab identity or installation used to resolve repositories; not necessarily a login | authentication identity, person |
| **Device** | one enrolled machine runtime holding an independent revocable credential | machine, host, client |
| **Space** | the ownership and authorization root; personal or organization | tenant, workspace, team, org |
| **Repository** | one SCM repository identity, independent of its current URL | project, remote, origin |
| **Checkout** | a project's local path on one device | project source, working copy |
| **Capture context** | the explicit person/space/project/SCM assignment applied when a device publishes an observation | inferred owner, default space |
| **Replication generation** | a monotonic device publication checkpoint | sync cursor, version, timestamp |
| **Memory observation** | an append-only recorded fact; not durable guidance | memory, note, log |
| **Memory proposal** | candidate knowledge awaiting explicit acceptance or rejection | memory, draft |
| **Memory item** | a stable logical unit of accepted knowledge, addressed across revisions | memory file, note, document |
| **Memory revision** | one immutable version of a memory item | edit, update, patch |
| **Work handoff** | an explicit transfer of verified work context from one harness session to another | export, session migration, transfer |
| **Work thread** | the durable continuity spine linking sessions, handoffs, and memory for one intent | session, campaign, task |

Note the existing `Session` entry (`CONTEXT.md:55-58`) already reserves
"campaign" semantics via `Session origin` (`:59-63`) — **Work thread** must not
be described as a campaign.

**Verify**: `grep -c '^\*\*' CONTEXT.md` → `47` (31 existing + 15 new + the new
`Project`). `bun run lint` → exit 0.

### Step 3: Write the twelve ADRs, numbered 0022–0033

One decision per file, each with its own reversal condition. Use exactly these
numbers and slugs so plans 101–110 can cite them before they are written:

| ADR | Slug | Decision | Relationship to record |
|---|---|---|---|
| 0022 | `one-monorepo-many-runtime-compositions` | one monorepo and one Web product, several deployable runtimes | — |
| 0023 | `local-sqlite-and-shared-postgresql` | SQLite stays local truth; PostgreSQL becomes shared truth | **Amends 0009** — scope "sole writer" to the local plane |
| 0024 | `internal-capability-modules-not-a-plugin-sdk` | capabilities register routes/jobs/tools/permissions; migrations stay one reviewed sequence; no third-party code in trusted runtimes | — |
| 0025 | `db-native-agent-memory-files-as-adapters` | the database is the authoritative mutation surface; Markdown/JSONL are import/export adapters | — |
| 0026 | `mcp-is-an-edge-adapter` | Web, CLI, jobs, and MCP are peer adapters over one application service layer | — |
| 0027 | `stable-project-identity-repository-as-locator` | internal project IDs are primary; repository URL is a locator | — |
| 0028 | `relationship-based-authorization-and-content-boundaries` | ReBAC is the source of truth; aggregate permission ≠ content permission | — |
| 0029 | `outbound-only-device-replication` | clients initiate all traffic; no inbound port, no LAN discovery | cite `tools/check-package-boundaries.ts:52` `retiredPackages` — `lan-pairing` was already removed for this reason |
| 0030 | `handoff-before-native-session-conversion` | continuity creates a new native target session; no writes into another harness's private store | — |
| 0031 | `authentication-identity-separation` | Person, login identity, SCM account, and Device credential are separate objects | — |
| 0032 | `authorization-before-search-ranking` | authorize candidate scope before lexical, fuzzy, or vector ranking | **Extends 0028** |
| 0033 | `opt-in-session-content-archive` | metadata may replicate by default; normalized detail requires explicit policy; raw artifacts never replicate | **Extends 0028 and 0029** |

For each file:

1. Header block:
   ```markdown
   # ADR 0023: Local SQLite truth, shared PostgreSQL truth

   - **Status**: Accepted
   - **Date**: 2026-08-26
   - **Amends**: [0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
   ```
2. **Context** — what forces the decision now. Cite living code, not this plan.
3. **Decision** — imperative, testable sentences.
4. **Consequences** — including what becomes harder.
5. **Rejected alternative** — exactly one, named, with why. Suggested:
   - 0022 → separate repositories per runtime;
   - 0023 → replace SQLite with PostgreSQL everywhere;
   - 0024 → a public plugin SDK from day one;
   - 0025 → keep Markdown authoritative and index it;
   - 0026 → MCP as the internal service bus;
   - 0027 → repository URL as the project primary key;
   - 0028 → role-based access control with per-resource ACL columns;
   - 0029 → peer-to-peer LAN sync (already removed once — cite it);
   - 0030 → write directly into the target harness's session store.
   - 0031 → one generic account object for login, SCM access, and devices;
   - 0032 → rank all candidates and filter unauthorized results afterward;
   - 0033 → replicate normalized session content by default.
6. **Evidence** — link to the code or plan that will prove it.

Then add twelve rows to `docs/adr/README.md:34` in number order, matching the
existing pipe format exactly.

**Amendment bookkeeping**: 0023 amends 0009, so 0009's own status header gains
`**Amended by**: 0023` and its README row becomes
`Accepted; amends 0001, 0002, 0007, 0008, 0014; amended by 0023`.

**Verify**: the link check in Commands you will need → no output.
`bun run lint` → exit 0.

### Step 4: Record the data-ownership matrix in `docs/architecture.md`

The matrix in this plan (see "Data-ownership matrix" below) is the source. Move
it into `docs/architecture.md` as a new `## Data ownership` section placed
between `## Runtime and process ownership` (`:53`) and `## Package ownership`
(`:159`). The invariant to state in prose: **no row has two authorities**, and a
row whose authority is "device" is never also writable by the server.

Extend `## Data flow` (`:20-52`) with a second diagram for the shared runtime.
Keep the existing local diagram unchanged and unmoved — it is still accurate and
plans 101+ do not alter it.

**Verify**: read `:20-160` continuously; the local pipeline must still read as
complete without the shared one.

### Step 5: Write the local-mode compatibility contract

Add to `docs/architecture.md` under `## Preserved domain invariants` (`:421`),
as a named subsection `### Local mode compatibility`:

```markdown
- `bun run dev`, `bun run demo`, `bun run build`, and `bun run start` work with
  no account, no network, and no PostgreSQL.
- Collection never blocks on the platform. A server outage cannot delay or fail
  a local collection attempt, publication, or report read.
- Every platform dependency is resolved behind an adapter that has a local
  no-op implementation.
- `bun run test:packages` passes with no PostgreSQL available on the machine.
```

The fourth line is the one with teeth: it forbids a future plan from writing
`if (connected)` branches through the product.

**Verify**: `bun run demo` still starts (this plan changes no code, so it must).

### Step 6: Update `AGENTS.md` and register the plans

1. `AGENTS.md` — the "Read these before changing behavior" list gains one line
   pointing at the program: `plans/099-ai-operations-memory-platform-program.md`
   as the platform direction. Keep it to one line; `AGENTS.md` is an index.
2. `plans/README.md:66` status table — add rows 099–110 (see plan 099 for the
   exact table) and set 100's status to `DONE` when Steps 1–5 pass.
3. This file's `## Status` block — set **Implementation status** to `DONE` and
   record the accepted ADR numbers.

**Verify**: `bun run check` → exit 0.

### Step 7: Record what you did not decide

Append a `## Deferred decisions` section to this plan listing anything you hit
that needs the maintainer. Candidates already known:

- the server HTTP framework (deliberately deferred to 101);
- the authorization engine (deferred to 103's spike);
- hosted vs self-managed PostgreSQL (deferred to deployment work);
- whether `packages/identity`, `packages/project-registry`, and
  `packages/memory` are three packages or one — decide when 102 and 105 have
  real code, not now.

A deferred decision written down is a program outcome. An undeferred decision
made silently by an executor is the failure mode this step exists to prevent.

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
