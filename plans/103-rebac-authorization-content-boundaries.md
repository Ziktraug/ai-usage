# Plan 103: Model Authorization With ReBAC, Content Boundaries, and Aggregate-Only Roles

> **Executor instructions**: Extend plan 102's application-owned `Authorizer`
> port. Write and review golden/conformance scenarios before the PostgreSQL
> adapter. V1 uses domain-specific relationship tables and explicit queries for
> ai-usage's current graph. Do not implement a generic policy DSL, recursive
> policy interpreter, or route-local permission system.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- CONTEXT.md docs/architecture.md docs/adr apps/server packages/platform-core packages/postgres-store packages/project-registry packages/authorization apps/web packages/web-contract`

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P0
- **Effort**: XL
- **Risk**: CRITICAL — defects can expose source context, prompts, Memory, Work
  handoffs, or personal activity
- **Depends on**: 100, 101, 102
- **Category**: full organization authorization and privacy boundary
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Plan status**: IN PROGRESS — implementation exists outside `main`, pending
  integration

## V1 authorization decision

V1 consists of:

1. the application-owned `Authorizer` port introduced by plan 102;
2. golden/conformance scenarios written independently before an organization
   adapter;
3. domain-specific PostgreSQL relationship tables and explicit queries for the
   current ai-usage resource graph;
4. `SingleUserAuthorizer` for local mode;
5. a test/in-memory adapter for application-service tests;
6. OpenFGA as a pre-designated escape hatch only when a measured trigger fires.

There is no generic Zanzibar-like relation/permission DSL, model interpreter,
or promise that a new permission works merely by adding a row to a declarative
table. Explicit SQL may use a recursive CTE where a real domain relation, such
as nested team membership, requires it. It must not become a general recursive
policy engine.

No permission logic lives in route handlers, MCP tools, serializers, or UI
filters. Application services call `Authorizer`; persistence adapters implement
complete authorized queries. No application-side post-filtering is permitted.

## Why PostgreSQL-native V1

- ai-usage's near-term graph is small personal/organization Space membership,
  teams, Projects, repositories, Devices, sessions, Memory, Work Threads, and
  Work handoffs—not an arbitrary customer-authored policy language;
- domain relations can commit in the same PostgreSQL transaction as their
  business entity, avoiding an external-engine dual write;
- an extra authorization service adds deployment, model-version, consistency,
  and reconciliation operations before measurement justifies it;
- the port plus conformance suite keeps a later adapter bounded.

This adapter is the production V1 design, not a temporary baseline. OpenFGA is
reconsidered only through the triggers below.

## Existing repository boundaries

- `SourceAuthority`, `authorizeRows`, and `AuthorizedSourceRow` mean local
  filesystem-trust provenance. Do not rename, reuse, or couple them to principal
  permission.
- Browser code imports only oRPC contracts. Add package-boundary rules that keep
  the authorization implementation and PostgreSQL out of Web browser modules.
- Plan 102 guarantees stable IDs and non-null Space identity for shared
  resources. Fix a nullable tenant boundary there before implementing this
  plan.
- Full organization ReBAC is intentionally not a prerequisite for plans
  105/106 or the local phase of 108; those depend on the port and
  `SingleUserAuthorizer`.

## Authorizer application contract

Keep the tri-state `check` and bounded ordinary resource listing introduced by
plan 102. Extend the port with a complete-scope operation for consumers such as
search and aggregate projection:

```ts
interface Authorizer {
  check(input: AuthorizationCheck): Promise<AuthorizationDecision>;
  listResources(input: AuthorizedResourceListQuery): Promise<AuthorizedResourcePage>;
  materializeResourceScope(input: AuthorizedResourceScopeQuery):
    Promise<AuthorizedResourceScope>;
}
```

`listResources` pagination bounds returned resources for ordinary listing.
`materializeResourceScope` is different: it must represent the complete
authorized relation for the requested resource type inside the request/DB
transaction or return a typed unavailable/unsupported error. It has no arbitrary
pre-ranking cap and never returns a partial authorization graph.

The PostgreSQL implementation may materialize the scope as:

- an authorization relation join;
- an authorized-resource CTE;
- a request-scoped temporary relation set;
- or an equivalent SQL predicate proven against the same conformance fixtures.

The public application contract treats the materialized scope as opaque and
request-scoped. Route handlers cannot inspect it or turn it into an ACL array.

Requirements for every adapter:

- allow, deny, and infrastructure error remain distinct;
- failures fail closed while preserving an operational error for observability;
- decision traces contain IDs/rule names only, never content;
- cursors and request-scoped handles are opaque and principal/model-version
  bound;
- no authorization engine client reaches browser code.

## Domain-specific relationship model

Use the existing domain tables plus focused relationship tables, for example:

```text
space_memberships
organizations
teams
team_memberships
repository_grants
project_grants
device_managers
session_content_grants
memory_content_grants
work_thread_grants
work_handoff_grants
authorization_audit_events
```

Do not create one polymorphic `authorization_relations` table intended to
interpret arbitrary resource/relation/subject triples in V1. Each relationship
table has concrete foreign keys, Space constraints, uniqueness, indexes, and
queries that a reviewer can connect to one permission.

Nested team membership may use a bounded recursive CTE. Every recursive query
must state the domain relation, maximum supported depth/cycle behavior, indexes,
and conformance scenarios. There is no generic transitive-closure cache.

Relationship mutations commit with the business operation in one PostgreSQL
transaction. There is no best-effort HTTP-handler dual write. Revocation and
resource deletion/deactivation update relation state predictably and remain
auditable.

## Resource graph

The concrete graph includes:

- Person membership/management of personal and organization Spaces;
- Team membership/management inside one organization Space;
- Repository and Project viewers/collaborators/maintainers;
- Device owner/manager without implied content access;
- Session metadata and Session content as distinct resources;
- Memory item metadata and Memory content as distinct resources;
- Work Thread and Work handoff as distinct resources;
- aggregate usage projections that have no path to content.

Repository association never exposes personal content to an SCM installation.
Capture Context determines owning Space before authorization. Membership changes
do not retroactively transfer personal resources.

## Permission vocabulary

### Organization and membership

```text
view_organization
manage_organization
manage_members
manage_teams
manage_authorization
```

### Usage and aggregate

```text
view_organization_usage_aggregate
view_project_usage_aggregate
view_project_usage_detail
view_session_metadata
```

### Sensitive content

```text
view_session_content
archive_session_content
manage_session_archive_policy
purge_session_archive
view_memory
propose_memory
accept_memory
manage_memory
view_work_handoff
create_work_handoff
accept_work_handoff
manage_work_handoff
```

### Project, repository, Device, and Work Thread

```text
view_project
manage_project
link_repository
view_repository_metadata
manage_repository_binding
view_device
manage_device
revoke_device
view_work_thread
manage_work_thread
link_session_to_work_thread
```

These names are the shared application vocabulary for Web, CLI, MCP, jobs, and
tests. Legacy permission aliases are not part of the new domain.

## Aggregate/content split

An organization `usage_auditor` may see authorized organization/project
aggregate projections. It does not gain session metadata, repository metadata,
session content, Memory, or Work handoff content by implication.

Aggregate queries read dedicated aggregate tables/projections or content-free
facts. They never load raw sessions/Memory and mask fields in a serializer.
Tests ask both halves in the same fixture: aggregate allow plus content deny.

Organization admin manages membership/authorization but is not an implicit
content wildcard. A security-auditor role must have an explicit tested
definition rather than inheriting from its name.

## Context and sensitivity

An active Space may constrain a mutation for a Person belonging to multiple
organizations. It supplements relationships; it is never the sole permission
source. Missing/mismatched active Space fails closed.

Sensitivity, temporary expiry, archive state, trusted-device requirements, and
legal/deletion state may further narrow access in one central policy layer or
explicit query predicate. They cannot grant access absent a relationship and
cannot be reimplemented differently by each adapter.

## Authorization-aware search

Shared PostgreSQL search must apply the complete authorized relation inside the
ranking query:

```text
principal + permission + active Space
  ↓ Authorizer-equivalent domain relations
authorized relation join/CTE/request-scoped relation
  ↓
all eligible authorized Memory/WorkHandoff candidates
  ↓ FTS/trigram/(gated vector) ranking
bounded results and snippets
```

Rules:

- no arbitrary authorization cap before ranking;
- pagination limits returned results, not the authorization graph;
- if complete scope cannot be represented safely, fail closed;
- no forbidden document may affect count, snippet, cursor, rank, IDF/statistics,
  trigram threshold, or semantic score;
- permission revocation and scope/query consistency are documented and tested.

If OpenFGA is adopted later, the adapter must first materialize the **complete**
authorized resource set into a relation that the PostgreSQL ranking query can
join (for example a transaction-scoped temp table populated from all
`ListObjects` pages under documented consistency). A truncated page is never a
search scope. If complete materialization cannot be guaranteed within bounded
time, search fails closed.

## OpenFGA escape hatch

Reconsider OpenFGA when one or more measured triggers occurs:

1. PostgreSQL reverse listing/materialization for Projects exceeds p95 150 ms at
   the seeded workload of 50 Spaces × 200 Projects × 20 People with realistic
   team nesting;
2. permission composition becomes materially deeper than three relation steps
   or materially harder to audit in explicit domain queries;
3. the aggregate/content split cannot be represented without an
   application-side or route-specific exception;
4. two consecutive new permissions require bespoke rewrites across the adapter
   instead of a focused domain query/table addition;
5. external consistency tokens/semantics become necessary.

When a trigger fires, stop and produce a comparison before implementation. The
comparison must prove the unchanged conformance suite, complete authorized
scope materialization for search, model rollout/rollback, read-after-write
consistency, self-hosted lifecycle, and operational cost. OpenFGA may use the
existing PostgreSQL deployment where supported, but that does not make its
datastore the application business authority.

SpiceDB is non-normative and considered only if a measured OpenFGA limitation
blocks the accepted graph. OpenFGA evaluation begins only after a measured
trigger fires; it is not a V1 implementation step.

## Defense in depth and auditability

Use PostgreSQL RLS as a coarse Space fence on tenant tables when the current DB
role/pooling design can set `SET LOCAL` verified context inside each
transaction. Missing context returns no rows. Fine-grained permissions remain
application-owned. Background jobs use explicit service principals.

If the concrete pooling/deployment spike cannot guarantee transaction-scoped
context, stop and record that RLS cannot be safely enabled; do not substitute a
session-level `SET` that can leak across pooled requests.

Audit membership/team/grant changes, Device enrollment/revocation,
aggregate-auditor assignment, archive policy, and Space moves with stable IDs,
actor, action, result, and time. Do not copy sensitive content into audit logs.

## Golden/conformance scenarios

Write these as adapter-independent fixtures before PostgreSQL queries:

1. local operator sees own personal Project, Memory, and Work handoff;
2. organization member cannot see another member's personal Space;
3. Project collaborator sees allowed Project/session metadata and only explicit
   content;
4. organization admin manages membership without implicit content;
5. usage auditor sees aggregates and is denied Session/Memory/WorkHandoff
   content in the same fixture;
6. security auditor behavior is explicit;
7. team grant and revocation take effect, including one bounded nested team;
8. active Space prevents cross-context mutation;
9. one Device publishes personal and organization captures without mixing;
10. revoked Device cannot publish/manage itself; provenance remains readable;
11. sensitive Memory requires its extra condition;
12. ordinary resource listing is pagination-safe without duplicates/omissions;
13. search scope materializes the complete authorized candidate relation before
    ranking and fails closed if it cannot;
14. adapter failure is an operational error and performs no mutation/read;
15. `SingleUserAuthorizer` works with no remote service;
16. aggregate projections never read content tables;
17. SCM installation grant never becomes Person/content permission.

Mutation-test each permission path/query so removing a relationship or
predicate fails at least one scenario.

## Steps

### Step 1: Freeze permissions and scenarios

Define principal/resource/permission contracts and the conformance fixtures as
data. Do not define a generic permission derivation DSL. Run the fixtures against
the existing `SingleUserAuthorizer` and a simple in-memory organization test
adapter.

### Step 2: Add domain-specific relationship schema

Create concrete tables/foreign keys/indexes for memberships, teams, focused
grants, and audit events. Space constraints are non-null and cross-Space edges
are impossible. Add only relations used by current permissions.

### Step 3: Implement explicit PostgreSQL authorization queries

Implement `check`, ordinary listings, and complete request-scoped scope
materialization. Each query names the permission/domain relation it implements.
Use recursive SQL only for an actual nested relation with bounded/cycle-tested
behavior. Run the unchanged conformance suite.

### Step 4: Prove one vertical and search-scope equivalence

Protect Project listing through application services with no handler
post-filter. Add an authorized-resource CTE/join fixture that plan 106 can reuse
and prove it equals the Authorizer outcomes for every candidate.

### Step 5: Add coarse RLS only if pooling is safe

Use transaction-scoped verified Space context and explicit service roles. Test
missing context returns zero. If the prerequisite fails, stop and record the
defense-in-depth gap without inventing unsafe pooling behavior.

### Step 6: Benchmark and evaluate triggers

Seed the documented scale, measure p50/p95/p99 and rows scanned for explicit
queries/materialization, evaluate all five triggers, and write the authorization
ADR with the measurements. If any trigger fires, pause V1 adapter rollout and
bring the OpenFGA comparison to the maintainer.

### Step 7: Document boundaries

Document the port, explicit query ownership, conformance suite, search scope,
RLS responsibility, audit policy, and OpenFGA escape procedure. Add boundary
rules preventing browser/route/MCP implementation imports.

## Verification

- scenarios exist before the PostgreSQL adapter commit;
- all adapters pass the same conformance fixtures;
- no generic model interpreter/DSL or polymorphic Zanzibar tuple table exists;
- explicit queries have Space/index/cycle/transaction tests;
- search-scope equivalence includes every candidate and no pre-ranking limit;
- benchmark evaluates the documented triggers;
- local adapter test supplies a platform connector that fails if invoked and
  records zero calls;
- `bun run lint`, typecheck, authorization tests, and relevant integration tests
  pass.

## Done criteria

- [ ] Application-owned port remains the only authorization seam.
- [ ] Golden scenarios precede and constrain the PostgreSQL adapter.
- [ ] V1 uses concrete relationship tables/queries, not a generic DSL/engine.
- [ ] Permission logic is absent from routes, MCP, serializers, and UI filters.
- [ ] Aggregate/content separation and mixed personal/org Device cases pass.
- [ ] Complete authorized search scope is representable before ranking.
- [ ] Relationship writes share business transactions.
- [ ] OpenFGA triggers and later complete-scope materialization are documented.
- [ ] Local single-user Memory remains independent of this plan's completion.

## STOP conditions

Stop and report when:

- a generic policy interpreter or arbitrary relation DSL is proposed for V1;
- organization admin becomes an implicit content wildcard;
- aggregate access requires content reads;
- authorization is applied after ranking/snippet/count generation;
- complete scope is truncated before search;
- application/route code maintains a second ACL system;
- relation changes require an untracked dual write;
- Device, SCM account, or SCM installation implicitly assigns Space/content
  access;
- local mode requires the PostgreSQL adapter or remote authorization service.

## Out of scope

- login and credentials (plan 104);
- public customer-authored policy language;
- SCIM/directory sync;
- authorization billing/entitlements;
- millions-of-relations scale beyond the documented trigger path.
