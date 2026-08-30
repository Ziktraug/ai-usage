# Plan 102: Introduce Stable Spaces, People, Devices, Repositories, Projects, and Checkouts

> **Executor instructions**: Build the minimal identity kernel required for the
> single-user Memory proof and the later connected model. Do not infer
> organization ownership from a path, remote, GitHub login, SCM installation,
> or Device. This plan defines the application-owned `Authorizer` port and its
> local `SingleUserAuthorizer`; plan 103 owns full organization ReBAC.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- CONTEXT.md docs/architecture.md docs/adr packages/local-machine packages/report-core packages/usage-store apps/usage-engine apps/server packages/platform-core packages/postgres-store tools/check-package-boundaries.ts`

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH — identity merges and tenant assignment can disclose or
  permanently misattribute data
- **Depends on**: 100, 101
- **Category**: minimal identity kernel, project registry, authorization port
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Plan status**: IN PROGRESS — implementation exists outside `main`, pending
  integration

## Current repository anchors

- `packages/report-core/src/session-vcs.ts` already normalizes bounded HTTPS and
  SCP-style SSH repository remotes and carries provenance. Extend its pure
  behavior; do not replace it.
- `projectSourceId` is currently machine + path. That remains correct for local
  report identity but is not the cross-device `ProjectId`.
- Existing usage rows keep string project/source identity. Platform resolution
  is an additive mapping/projection, never a destructive rewrite.
- The existing local machine record is provenance. A `Device` is a domain
  identity and, in connected mode, a credential holder; these remain distinct.
- Plan 100 must already distinguish Project source, Project group, and Project,
  and must separate SCM account, installation, and credential.

## Minimal identity kernel

The same validated IDs/value objects are used by local SQLite and shared
PostgreSQL adapters.

### Space and Person

```ts
interface Space {
  readonly id: SpaceId;
  readonly kind: "personal" | "organization";
  readonly displayName: string;
  readonly createdAt: Instant;
}

interface Person {
  readonly id: PersonId;
  readonly displayName: string;
  readonly personalSpaceId: SpaceId;
  readonly status: "active" | "suspended";
}
```

The local kernel bootstraps exactly one local Person and personal Space without
login. Connected creation ensures one active personal Space per Person.
Organization Spaces exist in the shared schema but team/membership permission
semantics are plan 103.

### Device

```ts
interface Device {
  readonly id: DeviceId;
  readonly ownerPersonId: PersonId;
  readonly owningSpaceId: SpaceId;
  readonly label: string;
  readonly status: "local" | "pending" | "active" | "revoked";
  readonly lastSeenAt: Instant | null;
}
```

The local Device is usable without enrollment. Connected credential/enrollment
is plan 104. Device ownership never assigns the Space of every captured fact.
Labels are user-controlled; hostnames are not published without consent.

### SCM account, installation, and credential

```ts
interface ScmAccount {
  readonly id: ScmAccountId;
  readonly personId: PersonId; // required
  readonly provider: "github" | "gitlab" | "generic";
  readonly providerAccountId: string;
  readonly handle: string | null;
}

interface ScmInstallation {
  readonly id: ScmInstallationId;
  readonly owningSpaceId: SpaceId;
  readonly provider: "github" | "gitlab" | "generic";
  readonly providerInstallationId: string;
  readonly selectedRepositoryIds: readonly string[];
  readonly status: "active" | "suspended" | "revoked";
}

interface ScmCredential {
  readonly id: ScmCredentialId;
  readonly accountId: ScmAccountId | null;
  readonly installationId: ScmInstallationId | null;
  readonly encryptedSecretReference: string;
  readonly createdAt: Instant;
  readonly rotatedAt: Instant | null;
  readonly revokedAt: Instant | null;
}
```

Exactly one of `accountId` or `installationId` is set. An SCM account is a
Person-scoped provider identity and therefore always has a Person. An SCM
installation is a Space-scoped organization/repository grant and never uses a
nullable `ScmAccount.personId` as a proxy. Recoverable provider secrets remain
separate credentials and are not authentication identities or Device
credentials.

Plan 102 may persist SCM account/installation metadata without credentials;
credential encryption and provider flows land in plan 104.

### Repository and alias

```ts
interface Repository {
  readonly id: RepositoryId;
  readonly owningSpaceId: SpaceId;
  readonly provider: "github" | "gitlab" | "generic";
  readonly providerRepositoryId: string | null;
  readonly canonicalHost: string;
  readonly canonicalOwner: string | null;
  readonly canonicalName: string;
  readonly status: "active" | "renamed" | "archived" | "unknown";
}

interface RepositoryAlias {
  readonly id: RepositoryAliasId;
  readonly owningSpaceId: SpaceId;
  readonly repositoryId: RepositoryId;
  readonly normalizedRemote: string;
  readonly source: "local-git" | "provider-api" | "manual";
  readonly firstObservedAt: Instant;
  readonly lastObservedAt: Instant | null;
}
```

Stable provider repository IDs are preferred locators when verified. URL/slug
aliases remain Space-scoped and preserve rename/transfer history. Matching
owner/name across unrelated hosts or mirrors never auto-merges repositories.

### Project and Checkout

```ts
interface Project {
  readonly id: ProjectId;
  readonly owningSpaceId: SpaceId;
  readonly kind: "repository" | "local";
  readonly displayName: string;
  readonly repositoryId: RepositoryId | null;
  readonly repositorySubpath: string | null;
  readonly status: "active" | "archived";
}

interface Checkout {
  readonly id: CheckoutId;
  readonly projectId: ProjectId | null;
  readonly deviceId: DeviceId;
  readonly localPath: string;
  readonly repositoryId: RepositoryId | null;
  readonly observedRemote: string | null;
  readonly status: "available" | "missing" | "unknown";
  readonly lastObservedAt: Instant;
}
```

`ProjectId` survives repository rename/transfer, later repository attachment,
checkout path changes, and device changes. `repositoryId + subpath` is a strong
candidate key inside a Space, not the Project primary key. Non-Git Projects and
unresolved Checkouts are valid from the first schema.

### Capture Context

```ts
interface CaptureContext {
  readonly id: CaptureContextId;
  readonly deviceId: DeviceId;
  readonly personId: PersonId;
  readonly spaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly scmAccountId: ScmAccountId | null;
  readonly scmInstallationId: ScmInstallationId | null;
  readonly source: "explicit" | "project-rule" | "personal-fallback" | "unassigned";
}
```

Assignment is attached before/during publication. An organization Space is
never inferred later from repository host, SCM identity, or Device ownership.
Unresolved work stays personal or explicitly unassigned according to policy.

## Authorizer port and local adapter

Plan 102 introduces the application-owned port before Memory exists:

```ts
interface Authorizer {
  check(input: AuthorizationCheck): Promise<AuthorizationDecision>;
  listResources(input: AuthorizedResourceListQuery): Promise<AuthorizedResourcePage>;
}

type AuthorizationDecision =
  | { readonly kind: "allow"; readonly reason: string }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "error"; readonly error: AuthorizationUnavailable };
```

The port belongs to the application/domain boundary, not HTTP or PostgreSQL.
Infrastructure failure is distinct from deny and never becomes allow.

`SingleUserAuthorizer` implements the port for the bootstrapped local Person and
personal Space. It allows only the local principal over resources in that
personal Space and fails/denies non-local or organization principals. It is not
an unconditional allow-all stub.

Plan 102 defines the initial permission names required by plans 105, 106, and
the local phase of 108, including Memory permissions and:

```text
view_work_handoff
create_work_handoff
accept_work_handoff
manage_work_handoff
```

Full teams, grants, aggregate/content separation, PostgreSQL relationship
queries, complete search-scope materialization, and OpenFGA triggers belong to
plan 103. Their absence must not block the single-user local Memory proof.

## Persistence direction

### Shared PostgreSQL

The first domain migration introduces at least:

```text
spaces
people
devices
scm_accounts              person_id NOT NULL
scm_installations         space_id NOT NULL
scm_credentials           exactly one account_id/installation_id (plan 104 may add secrets)
repositories
repository_aliases
projects
checkouts
capture_contexts
identity_events
```

Requirements:

- tenant-scoped tables have `space_id NOT NULL`;
- composite constraints prevent cross-Space references;
- active personal Space uniqueness is enforced;
- SCM account uniqueness uses provider + stable provider account ID;
- SCM installation uniqueness uses provider + installation ID + Space;
- repository aliases are unique inside a Space and cannot point across Space;
- Project/Checkout nullable repository/project fields represent legitimate
  non-Git/unresolved state;
- referenced identities use restricted/soft lifecycle, not destructive cascades;
- every timestamp is `timestamptz`;
- migration ordinal follows plan 101.

### Local Memory SQLite kernel

The dedicated Memory SQLite adapter stores the minimal Person/personal Space,
local Device, Project, Repository, and Checkout identities needed by local
Memory and Work handoffs. It uses the same validated IDs and service contracts,
but it does not emulate organization membership or connected credentials.

One local process owns this writer. Web, CLI, and MCP call local application
services. The local kernel must work with an injected platform connector that
fails if called.

## Repository resolution

Extend the existing pure remote normalizer with an alias key that normalizes
`.git`, case according to provider rules, and trailing separators without
changing display/provenance output.

Resolution order:

1. validate the observed checkout;
2. resolve a verified provider repository ID inside the Capture Context Space;
3. otherwise match normalized aliases inside that Space;
4. one match resolves;
5. multiple matches return every candidate as `ambiguous` and never auto-pick;
6. no match creates a candidate/local Project or stays unassigned by policy;
7. never move an existing Project between Spaces implicitly.

The pure outcome union must make ambiguity explicit. The adapter only loads
Space-scoped inputs and persists the outcome; it does not duplicate decisions.

Rename/transfer with the same verified provider ID updates display identity,
retains aliases, preserves Project/Session/Memory/WorkHandoff IDs, and writes an
identity event. Manual merge previews affected Spaces/Projects before mutation.

## Compatibility with current usage data

```text
origin_machine_id + local project string
  ↓ existing projectSourceId
Project-source identity
  ↓ additive mapping
shared ProjectId + CheckoutId when acknowledged
```

Do not rewrite the existing usage store or reinterpret Project groups. Missing
mapping is a visible gap, not an error and not a guessed global Project.

## Steps

### Step 1: Add pure IDs, `Authorizer`, and `SingleUserAuthorizer`

Define validated identity/resource/principal types, the tri-state port, the
local adapter, and conformance fixtures for personal-space allow, foreign-space
deny, non-local principal deny, and infrastructure error. Register real
packages/boundaries/exports.

### Step 2: Extend repository normalization and write the resolver truth table

Add provider-aware alias keys and a pure resolution union. Test provider-ID
precedence, alias disagreement, SSH/HTTPS equivalence, ambiguity, Space
isolation, no remote, monorepo subpaths, and self-hosted host separation.

### Step 3: Add minimal identity schemas to both adapters

Add the PostgreSQL tables/constraints and the local Memory SQLite kernel. Keep
SCM account, installation, and credential separate. Migration tests cover empty,
ordinal order, forward fixtures, and cross-Space constraint failures.

### Step 4: Implement project/checkout repositories

Persist each pure resolver outcome. Test rename, transfer, ambiguity, non-Git
Project creation, later repository attachment without Project ID replacement,
and identical aliases in two Spaces.

### Step 5: Add the compatibility mapping

Project existing local sources additively. Prove no existing usage rows or
project-group semantics were rewritten.

### Step 6: Add the smallest ambiguity review surface

Show source Device, opaque local label, observed remote, candidate matches,
destination Space, and explicit create/link/leave-unassigned actions. It cannot
publish to an organization without later plan-103 permission. Follow existing
oRPC/Query/accessibility/presentation gates.

### Step 7: Document and hand off

Update language/architecture/package docs. Plan 103 consumes the stable resource
IDs; plans 105/106 consume the port and local adapter without waiting for full
ReBAC/authentication.

## Verification

- existing `session-vcs` tests stay green;
- pure resolver covers every outcome and cross-Space isolation;
- SCM account requires Person; installation is Space-scoped and separate;
- PostgreSQL constraints reject cross-Space references;
- local identity kernel performs zero platform connection calls;
- existing usage store/report mappings remain additive;
- `bun run lint`, typecheck, package tests, and relevant e2e gates pass.

## Done criteria

- [ ] Minimal local/shared identity contracts exist for Space, Person, Device,
      Repository, Project, and Checkout.
- [ ] `Authorizer` and `SingleUserAuthorizer` exist before plan 105.
- [ ] SCM account, SCM installation, and SCM credential are distinct and
      correctly scoped.
- [ ] Stable Project identity survives rename/transfer/path/device changes.
- [ ] Non-Git Projects and unresolved Checkouts are first-class.
- [ ] Capture Context prevents implicit organization assignment.
- [ ] Existing usage identity stays compatible through an additive mapping.

## STOP conditions

Stop and report when:

- URL, path, username, email, or provider handle becomes a primary identity;
- an SCM installation is represented by weakening the required Person owner of
  an SCM account;
- SCM credential, auth identity, or Device credential is merged with an SCM
  account/installation record;
- local Memory waits for plan 103/104 or a server;
- `SingleUserAuthorizer` becomes unconditional allow-all;
- Device/SCM/remote implicitly determines organization ownership;
- an identity merge rewrites/deletes historical provenance.

## Out of scope

- full organization/team ReBAC (plan 103);
- login/provider credential/enrollment flows (plan 104);
- Agent Memory schema/application behavior (plan 105);
- replication (plan 107);
- automatic organization repository discovery.
