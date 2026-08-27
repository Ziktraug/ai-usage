# Plan 103: Model Authorization With ReBAC, Content Boundaries, and Aggregate-Only Roles

> **Executor instructions**: Treat authorization as a product data model, not a
> middleware helper. Build and review the relationship model and golden tests
> before protecting production routes. Keep the application behind an
> `Authorizer` port; do not scatter OpenFGA, SpiceDB, or SQL ACL calls through
> handlers and repositories.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- CONTEXT.md docs/architecture.md docs/adr apps/server packages/platform-core packages/postgres-store packages/project-registry packages/authorization apps/web packages/web-contract`
> Re-read plans 100–102 and any identity-schema drift before changing the model.

## Status

- **Priority**: P0
- **Effort**: XL
- **Risk**: CRITICAL — authorization defects can expose source context, prompts,
  memory, or personal activity
- **Depends on**: 100, 101, 102
- **Category**: authorization and privacy boundary
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

The expected access model is not a flat list of roles:

- one Person may belong to several organizations;
- teams gain access to selected Projects;
- Projects relate to Repositories, Sessions, Memories, and Work Threads;
- Devices belong to people but publish observations into explicit Spaces;
- organization administrators may manage membership without reading all project
  content;
- usage auditors may need organization-level aggregates while having no access
  to repository code, prompts, session chronology, or memory;
- one Device may use personal and professional SCM accounts;
- a person’s personal projects must remain invisible to colleagues even when the
  same machine also publishes organization work.

This is naturally relationship-based authorization. Attributes still matter for
sensitivity, temporary grants, and active organization context, but a pure ABAC
rule set would duplicate the relationship graph in application code.

## Decision this plan closes: which authorization engine

The parent program left three candidates open (OpenFGA, SpiceDB,
PostgreSQL-native), which makes this plan unexecutable as written — an executor
would pick one arbitrarily on the repository's `Risk: CRITICAL` component.
It is closed here in a way that starts work immediately and keeps the choice
cheap to reverse.

### The decision

**Build the `Authorizer` port and its conformance suite first. Ship the
PostgreSQL-native adapter. Treat OpenFGA as a pre-designated escape hatch, and
run a bounded spike whose job is to *falsify* the PostgreSQL adapter against a
measured workload.**

Ordering matters more than the engine: the golden test matrix is the real
deliverable. Once every adapter must pass the same 15 scenarios, swapping
engines becomes a bounded task rather than a rewrite, and the choice stops being
load-bearing.

### Why PostgreSQL-native is the default rather than the fallback

| Force | Reading |
|---|---|
| Product scale | ai-usage is a local single-operator product growing to personal + small-organization Spaces. The graph is people × spaces × projects × devices — thousands of edges, not the millions Zanzibar was designed for. |
| Operational cost | OpenFGA or SpiceDB is a second server process with its own lifecycle, model-version deployment, and consistency-token semantics. The program's first cross-cutting invariant is that local mode works with no account and no network; every added service is pressure against it. |
| Existing precedent | `tools/check-package-boundaries.ts:52` lists `lan-pairing` and `sync` as **retired** packages — this repository has already removed one distributed-systems component it did not need. |
| Transactional integrity | The plan's "Storage and consistency" section wants the relation update to commit atomically with the business transaction. With relations in PostgreSQL that is one transaction. With an external engine it is a dual write plus a reconciliation outbox — real complexity, added before any measurement justifies it. |
| Reversal cost | Behind the port, with a conformance suite, moving to OpenFGA is one adapter package. |

The plan's own text already permits this: "Reject it for production unless a
written comparison shows that a dedicated engine adds more operational risk than
value." Step 6 below produces that written comparison. It is a deliverable, not
a formality — if it comes out the other way, take the escape hatch.

### The guardrail that makes this safe

The stated risk in "Candidate C" is real: an unreviewed custom Zanzibar
implementation. Three rules prevent it, and each is mechanically checked:

1. **One declarative policy definition.** Relations and permissions are declared
   as data in `packages/authorization/src/model.ts` — a table of resource types,
   relations, and permission derivations. No permission logic in SQL strings, no
   permission logic in route handlers. The PostgreSQL adapter *interprets* the
   model; it does not restate it. Enforced by a test that derives the adapter's
   supported permission set from the model and fails on divergence.
2. **No transitive closure caching.** The adapter resolves with recursive CTEs
   against live tables. Caching is the point where hand-rolled Zanzibar becomes
   dangerous, and it is banned until measurement demands it.
3. **A hard escalation trigger** (Step 6). Not a judgement call.

### The escape hatch, pre-designated

**OpenFGA, not SpiceDB** — it self-hosts against a PostgreSQL datastore, so
taking the hatch adds a process but not a third storage technology. SpiceDB is
reconsidered only if the spike shows OpenFGA's model language cannot express the
aggregate/content split; record that as a finding, do not decide it in advance.

### Escalation trigger — measured, not argued

Take the escape hatch when **any** of these is observed in Step 6:

- reverse listing (`listResources` for `project` at `permission: read`) exceeds
  **p95 150 ms** at the seeded scale of 50 spaces × 200 projects × 20 people
  with realistic team nesting;
- the recursive CTE requires more than **3 levels** of relation indirection to
  express a permission in the model table;
- the aggregate/content split cannot be expressed without a per-route
  application-side exception;
- two consecutive golden-test additions require adapter changes beyond adding a
  row to the model table.

Record the measurement in the ADR either way. "We measured and it was fine" is a
result worth writing down; the next executor should not have to re-derive it.

## Core decision

Adopt a ReBAC model behind an application-owned port. Prototype OpenFGA first
because its tuple/rewrite model and resource-list APIs fit a multi-tenant SaaS,
but preserve implementation substitutability and evaluate SpiceDB if the model
or consistency requirements expose a concrete limitation.

No application service may treat “organization admin” as an implicit wildcard
for every content resource. Permissions must be named and tested.

## Current state

### There is no principal authorization here — but the word is taken

This repository has no permission system. It is a single-operator local product,
which is why this plan is `Risk: CRITICAL`: it introduces the first security
boundary the codebase has.

**But `grep -rn "authoriz" packages apps` returns 180 hits, and none of them
mean what this plan means.** The collision is real and will mislead an executor:

- `packages/report-data/src/project-projection.ts:26` —
  `export type SourceAuthority = 'local-observed' | 'portable-opaque';`
- `packages/report-data/src/project-projection.ts:74` —
  `export const authorizeRows = (rows, authority) => rows.map((row) => ({ authority, row }));`
- `packages/report-data/src/index.ts:226-240` — `authorizeStoredRows`.

That "authority" answers a completely different question: *may this path be
canonicalized and touched on the local filesystem, or is it an opaque label from
another machine?* It is the enforcement of `CONTEXT.md:96-99` ("paths from
snapshots or merge bundles are opaque labels and never authorize local
filesystem access") — a provenance-trust rule, not a principal-permission rule.

Consequences for this plan:

- Do **not** extend, rename, or reuse `SourceAuthority`, `authorizeRows`, or
  `AuthorizedSourceRow`. They are correct as they stand.
- Name this plan's concepts `Principal`, `Permission`, and `Relation` — never
  `Authority`. Add `_Avoid_: source authority` to the `Principal` entry in
  `CONTEXT.md` (Step 9) so the next reader hits the distinction before the grep.
- `packages/usage-engine-control` is not a precedent either: its bearer token
  (`src/client.ts:233`) authenticates one local operator against one process. It
  answers "is this the local operator", not "may this principal read this
  resource".

### Nothing may enforce authorization by import path

The boundary rules that already exist do most of the defense-in-depth work, and
this plan must extend them rather than rely on discipline:

- `tools/check-package-boundaries.ts:61-133` — 10 policies. `report-core`,
  `skills`, and `effect-runtime` are fully closed (`forbiddenDependencies:
  ['@ai-usage/*']`).
- `tools/check-package-boundaries.ts:153-162` —
  `engineRuntimeAllowedWorkspaceDependencies`, the allowlist idiom.
- ADR 0010/0012 — browser code imports only the oRPC contract. The plan's "no
  authorization-engine client in browser code" is therefore already enforceable
  by the existing checker; add `@ai-usage/authorization` to
  `apps/web`'s `forbiddenDependencies` and it becomes mechanical.

### Prerequisites, and the one that is easy to get wrong

- Plan 100: ADR 0028 accepted.
- Plan 101: `packages/postgres-store`, `tools/pg-harness.ts`.
- Plan 102: `spaces`, `people`, `space_memberships`, `devices`, `projects`,
  `repositories`, `checkouts` — all with `space_id NOT NULL`.

Plan 102's non-nullable `space_id` is load-bearing here. If any tenant-scoped
table shipped with a nullable tenant column, stop and fix 102 first: every
permission rule below would need a null branch, and a null branch in an
authorization rule is a bypass waiting to be found.

### Scale assumption, stated so it can be falsified

The seeded workload in Step 6 (50 spaces × 200 projects × 20 people) is chosen
to be roughly 100× the realistic near-term size of this product — a single
operator with personal and small-organization Spaces. If the product's actual
trajectory is larger, that assumption is wrong and the escalation trigger fires
sooner. Say so in the ADR; a scale assumption left implicit is how a
PostgreSQL-native decision quietly becomes wrong two years later.

## Authorization port

Create a pure application interface conceptually equivalent to:

```ts
interface Authorizer {
  check(input: {
    principal: PrincipalRef;
    permission: PermissionName;
    resource: ResourceRef;
    context?: AuthorizationContext;
  }): Promise<AuthorizationDecision>;

  listResources(input: {
    principal: PrincipalRef;
    permission: PermissionName;
    resourceType: ResourceType;
    context?: AuthorizationContext;
    limit: number;
    cursor?: string;
  }): Promise<AuthorizedResourcePage>;
}
```

Requirements:

- explicit allow/deny/error result; infrastructure failure is not “deny” hidden
  from operators and is never “allow”;
- bounded list operations and opaque cursors;
- request-scoped decision tracing that contains IDs and rule names but no
  sensitive resource content;
- test implementation for application-service tests;
- single-user implementation for local-only mode;
- OpenFGA/SpiceDB adapter isolated in one package;
- no authorization-engine client in browser code.

## Resource graph

The exact DSL belongs in the implementation, but the model must represent at
least these resource types and relations.

### Person and team

```text
person:<id>
team:<id>
  organization: organization:<id>
  member: person:<id>
  manager: person:<id>
```

### Space and organization

```text
space:<id>
  owner: person:<id>                # personal space
  organization: organization:<id>   # organization space

organization:<id>
  owner: person:<id>
  admin: person:<id>
  member: person:<id> | team:<id>#member
  usage_auditor: person:<id> | team:<id>#member
  security_auditor: person:<id> | team:<id>#member
```

Roles are relations that contribute to named permissions; they are not global
application enums assumed by every resource.

### Repository and project

```text
repository:<id>
  owning_space: space:<id>
  viewer: person/team
  maintainer: person/team

project:<id>
  owning_space: space:<id>
  repository: repository:<id>       # optional
  viewer: person/team
  collaborator: person/team
  maintainer: person/team
```

Project access may inherit from owning Space or Repository only where the model
states it explicitly. A Repository association does not automatically make
personal data visible to an organization installation.

### Device

```text
device:<id>
  owner: person:<id>
  owning_space: space:<id>
  manager: person/team
```

Device management permissions cover enrollment, label, credential rotation, and
revocation. They do not imply permission to read every content item ever
published by that Device.

### Session and memory resources

```text
session:<id>
  project: project:<id>
  owning_space: space:<id>
  produced_by: device:<id>
  content_viewer: person/team        # optional explicit grant

memory_item:<id>
  project: project:<id>              # optional for global/personal memory
  owning_space: space:<id>
  author: person:<id>
  content_viewer: person/team

work_thread:<id>
  project: project:<id>
  owning_space: space:<id>

handoff:<id>
  work_thread: work_thread:<id>
  owning_space: space:<id>
```

## Permission vocabulary

Define permissions by capability, not one generic `read`.

### Organization and membership

```text
view_organization
manage_organization
manage_members
manage_teams
manage_authorization
```

### Usage and aggregate permissions

```text
view_organization_usage_aggregate
view_project_usage_aggregate
view_project_usage_detail
view_session_metadata
```

### Sensitive content permissions

```text
view_session_content
archive_session_content
view_memory
propose_memory
accept_memory
manage_memory
view_handoff
create_handoff
```

### Project/repository/device permissions

```text
view_project
manage_project
link_repository
view_repository_metadata
manage_repository_binding
view_device
manage_device
revoke_device
```

Names may change, but content, metadata, aggregate, and management must remain
separate axes.

## Aggregate-only roles

An organization `usage_auditor` may receive:

```text
view_organization_usage_aggregate
view_project_usage_aggregate (possibly all org projects)
```

It must not receive by implication:

```text
view_session_metadata
view_session_content
view_memory
view_repository_metadata
```

Implement organization aggregates as dedicated authorized projections/tables or
queries. Do not implement aggregate-only access by loading every raw session and
stripping fields in an HTTP serializer.

Tests must prove that an auditor can answer “How many sessions and which
harnesses were used?” while failing to retrieve a session title, prompt,
checkout path, memory snippet, or repository name when those are not separately
permitted.

## Personal and organization data on one device

A Device’s publications carry the Capture Context from plan 102. Authorization
uses the resource’s owning Space, not the Device owner’s current organization
membership.

Required behavior:

- personal Capture Context → personal Space resources;
- explicit organization Project/Space context → organization resources;
- unresolved context → personal/unassigned quarantine according to policy;
- no repository hostname, branch name, or SCM account automatically upgrades the
  Space;
- changing organization membership does not retroactively transfer personal
  resources.

## Active organization context

Some routes may require an active Space/organization context to prevent a person
who belongs to several organizations from accidentally acting in the wrong one.
Model this as an authorization condition/caveat, not as the only access rule.

Example context:

```ts
interface AuthorizationContext {
  activeSpaceId?: SpaceId;
  now?: Instant;
  trustedDeviceId?: DeviceId;
}
```

Rules that depend on `activeSpaceId` must fail closed when the context is absent
or mismatched.

## Sensitivity and conditional access

ReBAC establishes relationships. Attributes may further constrain access:

- `standard`, `private`, or `sensitive` content class;
- temporary grant expiry;
- archived content policy;
- trusted-device or step-up-auth requirement;
- legal hold or deletion state.

Implement these through supported authorization conditions/caveats or one
central application policy layer. Do not duplicate them differently in Web,
MCP, and jobs.

## Search authorization

Plan 106 depends on this invariant:

```text
principal + permission + context
        ↓
authorized candidate scope
        ↓
full-text / trigram / vector retrieval
        ↓
ranking and snippets
```

Forbidden design:

```text
search entire corpus → top 10 → remove unauthorized rows
```

The model must support either:

- bounded resource listing used to constrain the database query;
- relation-derived Space/Project predicates with an equivalent authorization
  proof;
- or a search index partitioned by authorized resource scope.

The executor must document how list/search consistency works and what happens
when relationship state changes while a search is in flight.

## Architecture candidates

### Candidate A — OpenFGA

Evaluate:

- model expressiveness for the graph above;
- `ListObjects`/resource listing at expected cardinality;
- contextual tuples/conditions for active Space and expiry;
- model version deployment and rollback;
- self-hosted operation;
- consistency token behavior;
- observability and test ergonomics.

### Candidate B — SpiceDB

Evaluate if OpenFGA exposes a real blocker, especially around:

- permission composition/caveats;
- consistency requirements;
- large reverse lookups;
- schema tooling and migration.

### Candidate C — PostgreSQL-only relation tables

May be used as a baseline/prototype but must not become an unreviewed custom
Zanzibar implementation. Reject it for production unless a written comparison
shows that a dedicated engine adds more operational risk than value and the
application can preserve one audited policy definition.

## Architecture candidates — dated resolution (2026-08-26)

Closed in "Decision this plan closes" above. Retained here as the evaluation
record, because the escape hatch needs criteria written down *before* it is taken.

### Chosen — PostgreSQL relation tables behind the `Authorizer` port

Not a custom Zanzibar: one declarative model (`model.ts`), no transitive-closure
cache, a conformance suite every adapter must pass, and a measured escalation
trigger. See the three guardrails above.

### Escape hatch — OpenFGA

Taken only when Step 6 fires a trigger. When that happens, evaluate in this order
and record each answer:

- `ListObjects` at the measured cardinality from `bench-authorization-listing.ts`;
- contextual tuples for active Space and expiry;
- model version deployment and rollback while the server is serving;
- self-hosted operation against the **existing** PostgreSQL instance — if it
  needs its own datastore, that is a finding, not a detail;
- consistency-token semantics at the read-after-write boundary in plan 107;
- whether all 15 conformance scenarios pass unmodified.

### Reconsidered only on a specific finding — SpiceDB

Evaluate only if OpenFGA's model language cannot express the aggregate/content
split (`aggregate_usage` reachable without `session_content` or
`memory_content`). Record that finding explicitly; do not switch on preference.

## Storage and consistency

PostgreSQL remains authoritative for business entities. The authorization engine
stores or derives relation tuples. Define an explicit write protocol:

1. application command validates domain input;
2. business transaction commits resource/membership state;
3. relation update is committed atomically where supported, or through a durable
   outbox with reconciliation;
4. resource is not externally usable until authorization state reaches the
   specified readiness guarantee;
5. retries are idempotent;
6. deletion/revocation invalidates relations predictably.

Do not perform an untracked best-effort dual write from an HTTP handler.

## Defense in depth

PostgreSQL Row-Level Security may enforce coarse Space boundaries for selected
shared tables. It is optional defense in depth, not the sole source of fine
permissions.

If used:

- application sessions set a verified principal/Space context transactionally;
- connection pooling cannot leak context across requests;
- background jobs use explicit service principals;
- tests prove missing context fails closed;
- ReBAC and RLS rules have documented responsibility boundaries.

## Auditability

Record authorization-relevant changes:

- membership and team changes;
- project/repository grants;
- device enrollment/revocation;
- aggregate-auditor assignment;
- sensitive-content policy changes;
- manual resource moves between Spaces.

Audit events must contain actor, action, resource IDs, result, and time without
copying sensitive content into the audit log.

Do not log every successful read by default unless the threat model requires it;
plan and bound high-volume access logs separately.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite: tenancy is non-nullable | `grep -c "space_id.*NOT NULL" packages/postgres-store/src/migrations.ts` | ≥ 5 |
| Reference-model conformance | `bun test packages/authorization/src/conformance.test.ts` | 15/15 scenarios pass |
| Adapter conformance (PostgreSQL) | `bun test packages/authorization/src/postgres-adapter.test.ts` | same 15 scenarios pass |
| Mutation check | `bun tools/check-authorization-mutations.ts` | every removed edge fails ≥ 1 scenario |
| Reverse-listing benchmark | `bun tools/bench-authorization-listing.ts` | prints p50/p95/p99; p95 < 150 ms |
| Fail-closed proof | `bun test packages/authorization/src/failure-modes.test.ts` | all pass |
| Local-mode single user | `bun test packages/authorization/src/local-authorizer.test.ts` | all pass |
| Local regression, no cluster | `! pgrep -x postgres && bun run test:packages` | all pass |
| Boundaries | `bun run lint` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Full verification | `bun run check && bun run lint && bun run typecheck && bun run test` | exit 0 |

## Git workflow

- Branch `plan/103-authorization`, cut from plan 102's branch.
- Stage by explicit path. Never `git add -A`.
- Five commits, each independently green — this ordering is also the review
  order, and it exists so the conformance suite is reviewable **before** any
  adapter can be tuned to pass it:
  1. `feat(authorization): declare the resource, relation, and permission model`
  2. `test(authorization): add the golden conformance matrix against a reference model`
  3. `feat(authorization): add the PostgreSQL relation adapter`
  4. `feat(authorization): enforce on the project listing vertical`
  5. `docs(adr): record the authorization engine decision with measurements`
- **Do not push or open a PR.** This is the repository's first security
  boundary; the maintainer reviews before anything depends on it.

## Steps

### Step 1: Declare the model as data

`packages/authorization/src/model.ts`. This file is the single policy
definition; everything else interprets it.

```ts
export type ResourceType =
  | 'space' | 'organization' | 'team' | 'project' | 'repository' | 'device'
  | 'session' | 'session_content' | 'memory_item' | 'memory_content'
  | 'work_thread' | 'work_handoff' | 'aggregate_usage';

export type SubjectType = 'person' | 'team' | 'device' | 'space';
export type RelationName =
  | 'organization' | 'member' | 'manager' | 'owner' | 'admin'
  | 'usage_auditor' | 'security_auditor' | 'owning_space'
  | 'viewer' | 'maintainer' | 'repository' | 'collaborator'
  | 'project' | 'produced_by' | 'content_viewer' | 'author'
  | 'work_thread';
export type PermissionName =
  | 'view_organization' | 'manage_organization' | 'manage_members'
  | 'manage_teams' | 'manage_authorization'
  | 'view_organization_usage_aggregate' | 'view_project_usage_aggregate'
  | 'view_project_usage_detail' | 'view_session_metadata'
  | 'view_session_content' | 'archive_session_content'
  | 'view_memory' | 'propose_memory' | 'accept_memory' | 'manage_memory'
  | 'view_work_handoff' | 'create_work_handoff'
  | 'view_project' | 'manage_project' | 'link_repository'
  | 'view_repository_metadata' | 'manage_repository_binding'
  | 'view_device' | 'manage_device' | 'revoke_device';
export type RelationPath =
  | readonly [RelationName]
  | readonly [RelationName, RelationName]
  | readonly [RelationName, RelationName, RelationName];

/** A relation is a directly stored edge. A permission is derived from relations. */
export interface RelationDeclaration {
  readonly resourceType: ResourceType;
  readonly relation: RelationName;
  readonly subjectTypes: readonly SubjectType[];
}

export interface PermissionDeclaration {
  readonly resourceType: ResourceType;
  readonly permission: PermissionName;
  /** Union of paths. Each path walks ≤ 3 relations — the cap is the escalation trigger. */
  readonly via: readonly RelationPath[];
}

export const RELATIONS: readonly RelationDeclaration[] = [ … ];
export const PERMISSIONS: readonly PermissionDeclaration[] = [ … ];
```

The split that gives this plan its name must be visible **in the type list
above**, not in prose: `session` and `session_content` are different resource
types, as are `memory_item` and `memory_content`, and `aggregate_usage` is its
own type with no path to either. That is what makes "a broader permission must
not be simulated by reading a narrower resource and masking fields" structurally
true rather than a review rule.

Add `model.test.ts`:
- every `via` path references a declared relation;
- no path exceeds 3 hops (this is the escalation trigger, enforced);
- no permission on `aggregate_usage` derives from a `project` or `space` path
  that also grants `session_content` or `memory_content` — assert by walking the
  declared paths, not by inspection.

**Verify**: `bun test packages/authorization/src/model.test.ts` → all pass.

### Step 2: The port and its three implementations

`src/authorizer.ts` — the interface from "Authorization port" below, with one
change that matters:

```ts
export type AuthorizationDecision =
  | { readonly kind: 'allow'; readonly via: readonly string[] }   // the rule path, for tracing
  | { readonly kind: 'deny'; readonly reason: 'no-path' | 'condition-failed' }
  | { readonly kind: 'error'; readonly error: AuthorizationUnavailable };
```

Three variants, not a boolean, and `error` is distinct from `deny`. The plan
requires that infrastructure failure is neither silently denied nor allowed;
a two-state return makes that impossible to honor at the call site. Callers must
`switch` exhaustively — `exactOptionalPropertyTypes` and `strict` are on
(`tsconfig.json:8,12`), so a missing case is a typecheck failure.

`via` carries rule names and IDs only. Add a test asserting no resource content
(title, path, prompt text) can appear in it.

Three implementations:

1. `src/reference-authorizer.ts` — pure in-memory interpreter over `RELATIONS`
   and `PERMISSIONS`. This is the oracle the conformance suite is written
   against, and it must be simple enough to review by eye.
2. `src/local-authorizer.ts` — single-operator local mode. It allows the local
   operator on their own personal Space and **denies everything else**, rather
   than allowing everything. A local-mode authorizer that returns `allow`
   unconditionally will be reached one day by connected-mode code.
3. `src/postgres-adapter.ts` — Step 4.

**Verify**: `bun test packages/authorization/src/local-authorizer.test.ts`
→ passes, including a case proving a non-local principal is denied.

### Step 3: Write the 15 golden scenarios against the reference model

`src/conformance.ts` exports the scenarios as **data**, and
`src/conformance.test.ts` runs them against any `Authorizer`:

```ts
export interface ConformanceScenario {
  readonly name: string;
  readonly fixture: AuthorizationFixture;   // spaces, people, teams, projects, devices, relations
  readonly expectations: readonly {
    readonly principal: PrincipalRef;
    readonly permission: string;
    readonly resource: ResourceRef;
    readonly expect: 'allow' | 'deny' | 'error';
  }[];
}

export const runConformance = (authorizer: Authorizer, scenarios = SCENARIOS) => { … };
```

All 15 from "Golden test matrix" below. Four deserve extra care:

- **#5 (usage auditor)** — assert `allow` on `aggregate_usage` **and** `deny` on
  `session_content` and `memory_content` for the same principal in the same
  fixture. Split across two scenarios it proves nothing.
- **#12 (pagination-safe listing)** — page through with `limit: 2` and assert the
  concatenated result equals the unpaged authorized set, with no duplicates and
  no omissions. Then revoke a grant *between* pages and assert the cursor does
  not leak a now-forbidden resource.
- **#13 (search scope)** — the assertion is on the *candidate set*, before
  ranking. Plan 106 depends on this scenario existing here.
- **#14 (fail closed)** — inject an adapter that throws; assert `kind: 'error'`,
  assert the caller surfaces a typed operational error, and assert it is **not**
  reported to the user as "not found" (that is an availability bug disguised as
  an authorization result).

`SCENARIOS` is exported so plan 104, 106, and 109 extend the same list rather
than starting their own.

**Verify**: `bun test packages/authorization/src/conformance.test.ts` → 15/15
against `reference-authorizer`.

### Step 4: The PostgreSQL adapter

Migration `0003_authorization_relations` adds one table:

```sql
CREATE TABLE authorization_relations (
  space_id     uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id   uuid NOT NULL,
  relation      text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  condition     jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, resource_type, resource_id, relation, subject_type, subject_id)
);
CREATE INDEX ON authorization_relations (space_id, subject_type, subject_id, relation);
```

The Space-scoped reverse index is what makes `listResources` viable; add it in
the same migration, not later. Relation mutations derive `space_id` from the
resource inside the same transaction and reject a caller-supplied mismatch.
RLS uses this concrete column as its coarse fence; no polymorphic lookup is
hidden in an RLS policy.

The adapter walks `PERMISSIONS[].via` with a recursive CTE. It reads the model
at runtime — a permission added to `model.ts` must work with **no** adapter
change. Assert that: `postgres-adapter.test.ts` adds a synthetic permission to a
copy of the model and runs a check through it.

Write protocol, per "Storage and consistency":

```ts
/** Relation writes commit inside the business transaction. There is no dual write. */
export const withAuthorizationRelations = (tx: Transaction, mutations: readonly RelationMutation[]) => …;
```

Because relations live in the same database as the entities, steps 1–3 of that
section collapse into one transaction and the reconciliation outbox is not
needed. Say so explicitly in the code comment — the next reader will look for it.

Then run the **same** conformance suite:

```ts
test('postgres adapter satisfies the golden matrix', async () => {
  const cluster = await startPostgresCluster('authorization');
  …
  await runConformance(makePostgresAuthorizer(cluster.url));
});
```

**Verify**: `bun test packages/authorization/src/postgres-adapter.test.ts`
→ the same 15/15. Two implementations, one suite, identical results.

### Step 5: Mutation-test the model

`tools/check-authorization-mutations.ts`: for each row in `RELATIONS` and each
`via` path in `PERMISSIONS`, remove it, run the conformance suite against the
reference authorizer, and assert **at least one scenario fails**. A surviving
mutant is an unexercised rule — either a missing scenario or a dead rule.

Report survivors by name and exit non-zero. Add it to `package.json:25`'s
`test` chain so it cannot be skipped.

**Verify**: `bun tools/check-authorization-mutations.ts` → no survivors.

### Step 6: Measure, then write the comparison

1. `tools/bench-authorization-listing.ts` seeds 50 spaces × 200 projects × 20
   people with team nesting 2 deep and ~30% cross-team membership, then measures
   `listResources('project', 'read')` for principals at three positions in the
   graph: a personal-only person, a single-team member, and a person in six
   teams across two organizations. Report p50/p95/p99 and rows scanned.
2. Compare against the escalation trigger above.
3. Write ADR 0034 `postgresql-native-relations-with-openfga-escape`, containing:
   the measured numbers, the seeded scale and why it was chosen, the four
   escalation criteria, the named rejected alternative (OpenFGA now), and the
   conformance suite as the migration path.

If a trigger fires: **stop and return to the maintainer** with the measurement.
Do not silently start an OpenFGA integration — the escape hatch is a decision,
not an implementation detail.

**Verify**: `bun tools/bench-authorization-listing.ts` → p95 < 150 ms, recorded
in the ADR.

### Step 7: Enforce on exactly one vertical

Project listing, chosen because plan 102 built it and it is read-only.

- The oRPC handler calls `listResources` and never post-filters. Assert the
  handler contains no `.filter(` over authorization — post-filtering is how
  count and pagination leaks appear.
- Add `@ai-usage/authorization` to `apps/web`'s `forbiddenDependencies` in
  `tools/check-package-boundaries.ts:104-108`, alongside the existing `cli`,
  `local-collectors`, and retired-package entries.
- Add an allowlist policy for `@ai-usage/authorization` itself: it may depend on
  `@ai-usage/postgres-store` and `@ai-usage/effect-runtime`, nothing else. No
  HTTP, no MCP, no report packages.

**Verify**: `bun run lint` → exit 0 (proves the browser boundary).
`bun test apps/server` → the listing route returns only authorized projects,
with a test for the cross-space case from plan 102 Step 4.

### Step 8: Defense in depth — decide, then either do it or record why not

Row-Level Security is listed as optional in this plan. Optional-and-unresolved
is how it never happens. Decide here:

**Enable RLS on `authorization_relations` and every table with `space_id`, as a
coarse Space fence only.** Fine-grained permission stays in the adapter.

- The server sets `SET LOCAL app.current_space_id` inside each transaction.
  `SET LOCAL` is transaction-scoped, which is what makes it safe under pooling —
  a plain `SET` leaks across pooled connections and is the classic RLS bug.
- Background jobs use an explicit service role with its own policy.
- `rls.test.ts`: a query with **no** context set returns zero rows, not all rows.
  This is the test that proves it fails closed.
- Document in `packages/authorization/README.md` which questions RLS answers
  (Space fence) and which it does not (everything else), so a future reader does
  not assume it is the permission system.

If you decide against RLS, record that in ADR 0034 with the reason. Either
outcome is fine; leaving it undecided is not.

**Verify**: `bun test packages/postgres-store/src/rls.test.ts` → all pass,
including the no-context-returns-nothing case.

### Step 9: Documentation and vocabulary

- `packages/authorization/README.md` — the model, the port, the three
  implementations, the conformance suite, the RLS boundary, and the escalation
  trigger.
- `CONTEXT.md` — add **Principal**, **Permission**, **Relation**, and
  **Aggregate-only role**, each with an `_Avoid_` list. `_Avoid_` for
  **Aggregate-only role** must include "read-only role", because that is the
  wrong mental model: it is not less access to the same data, it is access to
  different data.
- `docs/architecture.md` `## Package ownership` — a `### @ai-usage/authorization`
  block stating it holds no HTTP or transport code.
- `docs/adr/README.md` — the ADR 0034 row.
- This file's `## Status` → **DONE**, plus the `plans/README.md:66` row.

## Golden test matrix

Create repository-owned fixtures for at least:

1. personal user sees personal Project, Session, and Memory;
2. organization member cannot see another member’s personal Space;
3. project collaborator sees that Project’s session metadata and permitted
   content;
4. organization admin manages members but does not automatically see project
   content;
5. usage auditor sees aggregate rows and cannot retrieve raw sessions/memory;
6. security auditor behavior is explicitly defined rather than assumed;
7. team membership grants and revocation take effect;
8. user belongs to two organizations and active Space prevents cross-context
   mutation;
9. personal Device publishes organization and personal captures without mixing
   ownership;
10. revoked Device cannot publish or manage itself but historical provenance
    remains readable to authorized users;
11. sensitive memory requires the extra condition chosen by policy;
12. resource listing returns only authorized Projects and is pagination-safe;
13. search candidate scope excludes forbidden resources before ranking;
14. authorization service unavailable fails closed with a typed operational
    error;
15. single-user local mode authorizes the local operator without a remote engine.

Mutation-test representative model relations so a removed permission edge fails
at least one golden test.

## Integration sequence

1. define the resource/permission vocabulary and golden tests against an in-memory
   reference model;
2. prototype OpenFGA model and adapter behind `Authorizer`;
3. validate list/check/condition behavior and self-hosted lifecycle;
4. choose OpenFGA, SpiceDB, or documented alternative through an ADR;
5. add durable relation-write reconciliation;
6. enforce authorization on one low-risk vertical resource;
7. add aggregate/content split proof;
8. only then make plan 104 authentication principals use the model.

The dated resolution below records how the chosen PostgreSQL-native path maps
that sequence without erasing the original decision trail.

Superseded by the Steps above. The mapping, for anyone reading the original
sequence:

| Original | Now |
|---|---|
| 1. vocabulary + golden tests vs reference model | Steps 1–3 |
| 2. prototype OpenFGA adapter | **Dropped** — the PostgreSQL adapter is the default (Step 4); OpenFGA is prototyped only if Step 6 fires a trigger |
| 3. validate list/check/condition + lifecycle | Step 6, against the chosen adapter |
| 4. choose through an ADR | Step 6, ADR 0034, with measurements attached |
| 5. durable relation-write reconciliation | **Not needed** — relations share the business transaction (Step 4). Required only if the escape hatch is taken; note that as a cost of the hatch |
| 6. enforce on one low-risk vertical | Step 7 (project listing) |
| 7. aggregate/content split proof | Steps 1 and 3 (scenario #5), structurally rather than as a later proof |
| 8. plan 104 principals use the model | unchanged — 104 depends on this plan |

## Done criteria

- [ ] Resource and permission vocabulary is documented in `CONTEXT.md` or the
      authorization package README.
- [ ] `Authorizer` port and local/test implementations exist.
- [ ] A dedicated ReBAC engine is selected or rejected through a comparative ADR.
- [ ] Golden tests cover personal, organization, team, Device, Project,
      aggregate-only, content, and multi-organization scenarios.
- [ ] Aggregate-only roles cannot fetch raw content through any tested adapter.
- [ ] Relationship writes are transactional or durably reconciled; no best-effort
      dual writes remain.
- [ ] Search has a documented pre-ranking authorization strategy.
- [ ] Application services, Web, MCP, and jobs share one permission vocabulary.
- [ ] Authorization failures and infrastructure failures are distinguishable and
      fail closed.
- [ ] Local-only single-user mode remains operable without a remote
      authorization service.

## STOP conditions

Stop and report when:

- organization admin is treated as an implicit wildcard for all session/memory
  content;
- aggregate-only access requires raw content permission;
- the selected engine cannot list authorized resources at the needed boundary;
- application code must maintain a second independent ACL system;
- authorization is applied only after search ranking or result snippet creation;
- a Device’s owner or SCM account determines Space ownership implicitly;
- relation writes can be lost without a durable reconciliation mechanism;
- test fixtures cannot demonstrate two organizations and mixed personal/org data
  on one Device;
- local mode would need the remote authorization service to read its own local
  data.

## Out of scope

- login UX and credential storage (plan 104);
- billing/plan entitlements;
- enterprise SCIM or directory sync;
- legal/compliance certification;
- remote command authorization;
- full production load testing of millions of relations, though the selected
  engine must have a documented scale path.
