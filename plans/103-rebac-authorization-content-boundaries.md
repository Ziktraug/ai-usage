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

## Core decision

Adopt a ReBAC model behind an application-owned port. Prototype OpenFGA first
because its tuple/rewrite model and resource-list APIs fit a multi-tenant SaaS,
but preserve implementation substitutability and evaluate SpiceDB if the model
or consistency requirements expose a concrete limitation.

No application service may treat “organization admin” as an implicit wildcard
for every content resource. Permissions must be named and tested.

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
