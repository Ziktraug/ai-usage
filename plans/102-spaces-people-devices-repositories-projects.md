# Plan 102: Introduce Stable Spaces, People, Devices, Repositories, Projects, and Checkouts

> **Executor instructions**: Execute after the shared PostgreSQL foundation is
> green. This plan establishes identity and tenancy primitives only. It must not
> infer organization ownership from a path, Git remote, GitHub login, or machine
> name. Do not add broad authorization behavior here; plan 103 consumes these
> resource identities.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- CONTEXT.md docs/architecture.md docs/adr packages/local-machine packages/local-collectors packages/report-core packages/usage-store apps/usage-engine apps/server packages/platform-core packages/postgres-store`
> Reconcile changes to machine identity, project grouping, VCS provenance, or
> server schema before proceeding.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH — mistaken identity merges or tenant assignment can disclose or
  permanently misattribute data
- **Depends on**: 100, 101
- **Category**: identity, tenancy, project registry
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

Today the local path is often the practical identity for a project. That works
on one machine, but not across:

- `/home/.../ai-usage`, `/Users/.../ai-usage`, and `D:\dev\ai-usage`;
- repository rename or organization transfer;
- SSH and HTTPS remotes for the same repository;
- mirrors and alternate remotes;
- monorepos containing several logical projects;
- non-Git projects;
- one person using personal and professional SCM identities on the same device.

The shared platform needs stable internal identities while treating Git metadata
as strong evidence, not an irreversible primary key.

## Domain model

### Space

A Space is the ownership and authorization root.

```ts
type SpaceKind = "personal" | "organization";

interface Space {
  id: SpaceId;
  kind: SpaceKind;
  displayName: string;
  createdAt: Instant;
}
```

Rules:

- every Person receives exactly one personal Space during bootstrap;
- an organization Space may have many members and teams;
- shared resources belong to one owning Space;
- moving a resource between Spaces is an explicit audited operation, not a field
  silently rewritten during ingestion.

### Person

A Person represents a human in ai-usage. It is not a GitHub account, email
address, login session, or device.

```ts
interface Person {
  id: PersonId;
  displayName: string;
  personalSpaceId: SpaceId;
  status: "active" | "suspended";
}
```

### Device

A Device represents one installed machine runtime and its publication identity.
It is not necessarily a physical asset inventory record.

```ts
interface Device {
  id: DeviceId;
  ownerPersonId: PersonId;
  owningSpaceId: SpaceId;
  label: string;
  status: "pending" | "active" | "revoked";
  lastSeenAt: Instant | null;
}
```

Rules:

- one Person may own several Devices;
- a Device credential is plan 104’s concern and is stored separately;
- Device ownership does not automatically assign every observation to the same
  Space;
- server-visible device labels must be user-controlled and not derived from a
  hostname without consent.

### SCM account

Define the identity now even if plan 104 adds credentials later.

```ts
interface ScmAccount {
  id: ScmAccountId;
  personId: PersonId;
  provider: "github" | "gitlab" | "generic";
  providerAccountId: string | null;
  handle: string | null;
  visibility: "personal" | "organization-managed";
}
```

An SCM account may help resolve repository IDs, but it does not determine the
owning Space of a session.

### Repository

A Repository represents one durable SCM repository identity.

```ts
interface Repository {
  id: RepositoryId;
  provider: "github" | "gitlab" | "generic";
  providerRepositoryId: string | null;
  canonicalHost: string;
  canonicalOwner: string | null;
  canonicalName: string;
  status: "active" | "renamed" | "archived" | "unknown";
}
```

Provider repository IDs are preferred when an authenticated provider has
confirmed them. A normalized URL is not the primary key.

### Repository alias

```ts
interface RepositoryAlias {
  id: RepositoryAliasId;
  repositoryId: RepositoryId;
  normalizedRemote: string;
  firstObservedAt: Instant;
  lastObservedAt: Instant | null;
  source: "local-git" | "provider-api" | "manual";
}
```

Aliases support:

- SSH/HTTPS equivalence;
- case/`.git`/default-port normalization;
- historical URLs after rename or transfer;
- additional remotes and mirrors without forced merge.

### Project

A Project is the logical unit ai-usage reports and remembers.

```ts
interface Project {
  id: ProjectId;
  owningSpaceId: SpaceId;
  kind: "repository" | "local";
  displayName: string;
  repositoryId: RepositoryId | null;
  repositorySubpath: string | null;
  status: "active" | "archived";
}
```

Rules:

- `repositoryId + repositorySubpath` is a strong uniqueness candidate inside one
  Space, not the Project ID;
- a repository root and two package subpaths can be three Projects;
- a local Project can later be attached to a Repository without changing its ID;
- project merge/split operations are explicit and audited.

### Checkout

A Checkout binds a Project to one Device path.

```ts
interface ProjectCheckout {
  id: ProjectCheckoutId;
  projectId: ProjectId;
  deviceId: DeviceId;
  localPath: string;
  repositoryId: RepositoryId | null;
  observedRemote: string | null;
  status: "available" | "missing" | "unknown";
  lastObservedAt: Instant;
}
```

`localPath` is opaque outside the source Device. The server must not use it to
read a filesystem or authorize a resource.

### Capture context

A Capture Context records the explicit assignment under which a device publishes
facts.

```ts
interface CaptureContext {
  id: CaptureContextId;
  deviceId: DeviceId;
  personId: PersonId;
  spaceId: SpaceId;
  projectId: ProjectId | null;
  scmAccountId: ScmAccountId | null;
  source: "explicit" | "project-rule" | "personal-fallback" | "unassigned";
}
```

The capture context is attached before or during ingestion. It is not inferred
later by an organization report query.

## PostgreSQL schema direction

Plan 102 should add concrete tables with foreign keys and uniqueness rules,
likely including:

```text
spaces
people
scm_accounts
devices
repositories
repository_aliases
projects
project_checkouts
capture_contexts
identity_merge_events
```

The exact table names may follow repository conventions. Requirements:

- stable generated IDs independent of mutable display fields;
- canonical timestamps and soft status rather than destructive deletion for
  referenced identities;
- unique active personal Space per Person;
- normalized alias uniqueness scoped to provider/host where appropriate;
- no cross-Space project merge through a plain update;
- no cascade deleting historical session or memory provenance when an identity
  is deactivated.

## Repository remote normalization

Implement a pure, tested normalizer before persistence.

It should understand at minimum:

```text
git@github.com:Owner/Repo.git
ssh://git@github.com/Owner/Repo.git
https://github.com/Owner/Repo.git
https://github.com/Owner/Repo
```

Output should separate:

- provider/host;
- owner/name where meaningful;
- normalized comparison form;
- original observed value retained as provenance.

Do not normalize unrelated self-hosted forges into one identity merely because
owner/name matches. Do not silently merge mirrors.

## Resolution algorithm

When a device reports a checkout:

1. validate and canonicalize the local checkout observation;
2. if a trusted provider repository ID is present, resolve by that ID;
3. otherwise normalize all observed remotes and search repository aliases;
4. if one unambiguous Repository matches, attach the Checkout;
5. if several candidates match, create an identity-review conflict rather than
   choosing one;
6. if no Repository matches, create a candidate Repository/Project in the
   capture context’s Space or leave it unassigned according to policy;
7. never move an existing Project to an organization merely because a matching
   remote was later observed there.

The resolver result must expose provenance and confidence; do not hide
ambiguity behind a boolean.

## Rename and transfer handling

When GitHub/GitLab confirms a stable provider repository ID with a new slug:

- update the canonical display identity;
- retain the previous normalized remote as an alias;
- preserve Project, Session, Memory, and Handoff IDs;
- write an identity event with actor/source/time;
- do not rewrite historical raw observations.

When no provider ID is available, a manual merge flow may associate aliases, but
must preview affected Projects and Spaces before confirmation.

## Non-Git projects

Support local projects from the first migration:

- generated Project ID;
- owning Space and display name;
- one or more Checkouts;
- optional stable local fingerprint that is device-scoped only;
- later Repository attachment without ID replacement.

Do not force a synthetic Git remote.

## Compatibility with current data

The existing local database and report rows must remain readable. Plan 102 does
not rewrite every local `project` string immediately.

Introduce an explicit mapping layer:

```text
existing local project/source identity
        ↓
Project resolution candidate
        ↓
shared ProjectId + CheckoutId when acknowledged
```

Requirements:

- local reports continue using current data while mapping is incomplete;
- shared reports show unresolved/project-candidate state honestly;
- historical rows receive shared identity through a separate mapping/projection,
  not destructive mutation of source facts;
- import/merge bundles remain portable and do not treat remote paths as local
  authority.

## UI/product decisions

This plan need not build a complete project-management UI, but it must define
minimum review surfaces for ambiguous identity:

- candidate repository/project;
- source device and observed remote/path label;
- proposed existing match;
- destination Space;
- explicit create, link, or leave unassigned action;
- no automatic organization sharing.

Any UI delivered must follow the existing presentation gate with deterministic
DOM/geometry assertions.

## Testing requirements

### Pure identity tests

- SSH and HTTPS forms normalize to the same GitHub repository;
- host, owner, repository case rules are provider-aware;
- `.git`, trailing slash, and default port handling;
- self-hosted hosts do not collide;
- malformed remotes return typed failures;
- monorepo subpaths remain distinct Projects.

### Persistence tests

- repository rename retains aliases and Project ID;
- local Project attaches to a Repository without ID change;
- cross-Space plain reassignment is rejected;
- deleting/deactivating an SCM account does not delete Person or Project;
- Device revocation does not delete published provenance;
- duplicate active personal Space is rejected.

### Resolution tests

- provider ID wins over URL alias;
- one alias resolves deterministically;
- multiple candidates produce review-required;
- no remote creates a valid local Project;
- ambiguous capture context remains personal/unassigned;
- a professional SCM account on a personal Device does not expose personal
  projects to the organization.

## Done criteria

- [ ] All domain terms are added to `CONTEXT.md`.
- [ ] Stable IDs and PostgreSQL constraints exist for all accepted entities.
- [ ] Repository URL normalization and alias history are tested.
- [ ] GitHub/provider IDs are locators, not Person or Project primary keys.
- [ ] Non-Git projects and monorepo subpaths are first-class.
- [ ] Capture Context prevents implicit organization assignment.
- [ ] Existing local project strings remain compatible through a mapping layer.
- [ ] Rename/transfer and manual identity review preserve historical references.
- [ ] Plan 103 has stable resource IDs to consume.

## STOP conditions

Stop and report when:

- an implementation proposes using normalized repository URL as the Project
  primary key;
- provider login identity is reused as the Person record;
- Device ownership is used as automatic data Space ownership;
- a resolver can publish to an organization without explicit capture context;
- repository mirrors cannot be distinguished from renames;
- an identity merge would require rewriting or deleting historical provenance;
- local paths are sent or displayed beyond their intended privacy boundary
  without a policy decision;
- current project-group behavior would be silently reinterpreted as global
  Project identity without a migration/review path.

## Out of scope

- relationship permissions (plan 103);
- login/session flows and provider tokens (plan 104);
- device credential enrollment (plan 104);
- replication protocol (plan 107);
- full project settings UI;
- automatic organization repository discovery.
