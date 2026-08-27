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

## Current state

### Remote normalization already exists — reuse it, do not rewrite it

`packages/report-core/src/session-vcs.ts:166-230` already implements most of
what this plan's "Repository remote normalization" section describes:

```ts
export const normalizeSessionVcsRepository = (
  remote: string,
  provenance: SessionVcsProvenance,
): SessionVcsRepository | null => {
  if (typeof remote !== 'string' || remote.length === 0 || remote.length > MAX_SESSION_VCS_URL_LENGTH) return null;
  if (remote.includes('://') && !remote.startsWith('https://')) return null;
  …
  host = parsed.hostname.toLowerCase();
```

It handles `https://` URLs and SCP-style SSH remotes (`SCP_REMOTE_PATTERN`,
`:187-196`), rejects non-HTTPS protocols, lowercases the host, rejects `?`/`#`
in the owner path, and enforces a length cap. Its output
(`session-vcs.ts:12-17`) is already the right shape:

```ts
export interface SessionVcsRepository {
  host: string;
  ownerPath: string;
  provenance: SessionVcsProvenance;   // 'harness-recorded' | 'local-derived'
  webUrl: string | null;
}
```

`provenance` is exactly the confidence signal this plan requires, and
`packages/report-core/src/session-vcs.test.ts` (149 lines) already covers it.
`packages/local-machine/src/local-git.ts:32-44` is the caller that reads
`.git/config` and feeds it.

**Consequence for this plan**: the normalization step is *extension*, not new
code. `report-core` is a pure package
(`tools/check-package-boundaries.ts:64-69` forbids it any `@ai-usage/*`
dependency), so it stays the home for this logic and `postgres-store` consumes
the normalized value. What is genuinely missing is the alias set, the provider
repository ID, and case-folding of `ownerPath` — see Step 2.

### What project identity is today: machine-scoped and path-based

`packages/report-core/src/project-group.ts:54-55`:

```ts
export const projectSourceId = (source: ProjectSourceIdentityInput) =>
  [source.machineId, source.sourcePath || source.project].join('|');
```

That is the entire current identity: a machine ID joined to a path. It is
correct for the local product and wrong for the platform — rename the folder and
the identity changes; use two machines and you get two identities. The selector
key (`:63-70`) already carries an optional `gitRemote`, which is the seam this
plan grows into.

`packages/usage-store/src/index.ts:1053-1080` shows the storage side:
`origin_machine_id TEXT NOT NULL` and `project TEXT NOT NULL` as separate
columns, with `idx_usage_rows_project ON usage_rows(project)` (`:1079`). Every
historical row has a project *string*, not a project *reference*. This is why
the compatibility mapping in this plan is a projection and never a rewrite.

### Vocabulary already taken

`CONTEXT.md:96-103` defines **Project source** ("identity combines the machine
and source path so similarly named folders stay distinct") and **Project group**
("an explicit local configuration that presents multiple project sources as one
named project"). Plan 100 Step 1 adds **Project** as a third, distinct term. If
plan 100 has not landed, stop — this plan is unexecutable without that
distinction, and executing it anyway produces three colliding meanings of
"project" in one schema.

### Machine identity

`packages/local-machine/src/machine-config.ts` owns the local machine record;
`packages/usage-store/src/index.ts:1087` has `usage_machine_fleet_order` and
`:1093` `usage_local_machine`. A **Device** in this plan is not the same object
as a machine row: a machine is an observed provenance label, a device is an
enrolled credential holder. One machine may predate enrollment and must remain
readable when it is never enrolled at all.

### Prerequisite state

- Plan 100's `CONTEXT.md` terms and ADR 0027 accepted.
- Plan 101's `packages/postgres-store` with `MIGRATIONS`, `tools/pg-harness.ts`,
  and the contract-boundary test in place.

If `packages/postgres-store/src/migrations.ts` does not exist, stop.

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
  owningSpaceId: SpaceId;
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

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite check | `test -f packages/postgres-store/src/migrations.ts && grep -c '^\*\*Project\*\*' CONTEXT.md` | file exists, count `1` |
| Existing normalization still green | `bun test packages/report-core/src/session-vcs.test.ts` | all pass |
| report-core suite | `bun test packages/report-core` | all pass |
| Identity resolver tests | `bun test packages/postgres-store/src/project-resolution.test.ts` | all pass |
| Migrations from empty | `bun test packages/postgres-store/src/migrations.test.ts` | all pass |
| Local regression, no cluster | `! pgrep -x postgres && bun run test:packages` | all pass |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint / boundaries | `bun run lint` | exit 0 |
| Format | `bun x ultracite fix` | exit 0 |
| Full verification | `bun run check && bun run lint && bun run typecheck && bun run test` | exit 0 |

## Git workflow

- Branch `plan/102-platform-identity`, cut from plan 101's branch.
- Stage by explicit path. Never `git add -A`.
- Three commits:
  1. `feat(report-core): add repository alias identity and provider repository ids`
  2. `feat(postgres-store): add spaces, people, devices, repositories, projects, and checkouts`
  3. `feat(postgres-store): resolve checkouts to projects with explicit ambiguity`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Write the resolver's truth table before any schema

The resolution algorithm below has seven branches and is the highest-risk
surface in the plan — a wrong branch silently merges two people's projects.
Encode it as data first, in `packages/report-core/src/project-resolution.ts`:

```ts
export type ProjectResolutionOutcome =
  | { kind: 'resolved-by-provider-id'; repositoryId: RepositoryId }
  | { kind: 'resolved-by-alias'; repositoryId: RepositoryId; alias: string }
  | { kind: 'ambiguous'; candidates: readonly RepositoryId[] }   // never auto-pick
  | { kind: 'candidate'; normalized: SessionVcsRepository }
  | { kind: 'unassigned'; reason: 'no-remote' | 'policy' };

export interface ProjectResolutionInput {
  readonly observedRemotes: readonly string[];
  readonly providerRepositoryId?: { host: string; id: string };
  readonly knownAliases: ReadonlyMap<string, RepositoryId>;
  readonly captureContext: { spaceId: SpaceId; policy: 'create-candidate' | 'leave-unassigned' };
}
```

`resolveProject(input): ProjectResolutionOutcome` is pure — no database, no
Effect, no IO. It lives in `report-core` alongside `session-vcs.ts` and is
directly unit-testable.

The `ambiguous` variant carries **all** candidates. This is the plan's "do not
hide ambiguity behind a boolean" requirement expressed as a type: there is no
way to write a caller that silently picks one, because the variant has no single
`repositoryId` field to read.

Test matrix in `project-resolution.test.ts`, one case per branch, plus:
- two aliases pointing at different repositories → `ambiguous`, both listed;
- provider ID present **and** an alias pointing elsewhere → provider ID wins,
  and the outcome records that the alias disagreed;
- the same normalized remote reached via `https://` and `git@` → one candidate,
  not two (this is the case that proves normalization is applied before lookup);
- empty remotes with `policy: 'leave-unassigned'` → `unassigned`;
- a remote observed in another Space → **never** returns that Space's
  repository. Assert this explicitly; it is rule 7 of the algorithm and the one
  with disclosure consequences.

**Verify**: `bun test packages/report-core/src/project-resolution.test.ts`
→ all pass, with a case per outcome variant.

### Step 2: Extend normalization with aliases and provider IDs

Add to `packages/report-core/src/session-vcs.ts`, next to the existing
normalizer so the two stay reviewable together:

```ts
/** The lookup key for a repository alias. Case-folded because GitHub owner/name are case-insensitive. */
export const repositoryAliasKey = (repository: SessionVcsRepository): string =>
  `${repository.host}/${repository.ownerPath.replace(/^\/+|\/+$|\.git$/g, '').toLowerCase()}`;
```

Three things the existing normalizer does not do, and each needs a test:

1. **`.git` suffix** — `github.com/a/b.git` and `github.com/a/b` are one
   repository. Strip it in the alias key only; leave `ownerPath` untouched so
   the display identity stays faithful to what was observed.
2. **Case** — `ownerPath` is currently preserved as observed (`:185`,
   `:195`). Fold it in the key, not in the stored value.
3. **Trailing slashes** — normalize in the key.

Do **not** modify `normalizeSessionVcsRepository` itself. It is covered by
`session-vcs.test.ts` and consumed by the live session-analysis path
(`packages/local-machine/src/local-git.ts:43`); changing its output is a
report-visible behavior change that belongs in no part of this plan.

**Verify**: `bun test packages/report-core/src/session-vcs.test.ts` → still all
pass (unchanged). New alias-key tests pass.

### Step 3: The schema, with tenancy non-nullable from the first migration

Add migration `0002_platform_identity` to
`packages/postgres-store/src/migrations.ts`. Table order matters — it is the
dependency order:

```text
spaces            (id, kind: 'personal'|'organization', display_name, created_at)
people            (id, display_name, created_at)
space_memberships (space_id, person_id, role, created_at)          -- PK (space_id, person_id)
devices           (id, space_id NOT NULL, person_id NOT NULL, label, enrolled_at, revoked_at)
scm_accounts      (id, space_id NOT NULL, person_id NULL, provider, provider_account_id, created_at)
repositories      (id, space_id NOT NULL, host, owner_path, provider_repository_id NULL, created_at)
repository_aliases(id PK, space_id NOT NULL, alias_key, repository_id NOT NULL,
                   first_observed_at, last_observed_at,
                   UNIQUE (space_id, alias_key))
projects          (id, space_id NOT NULL, repository_id NULL, subpath NULL, display_name, created_at)
checkouts         (id, device_id NOT NULL, project_id NULL, local_path, fingerprint NULL, observed_at)
capture_contexts  (id, device_id NOT NULL, person_id NOT NULL, space_id NOT NULL,
                   project_id NULL, scm_account_id NULL, source, created_at)
identity_events   (id, space_id NOT NULL, subject_kind, subject_id, actor, source,
                   occurred_at, payload jsonb)
```

Rules that must be in the SQL, not just in prose:

- **`space_id` is `NOT NULL` on every tenant-scoped table.** The program's
  "tenancy is explicit" invariant is enforceable only if the column cannot be
  null. A nullable tenant column becomes a permanent "unassigned" bucket that
  authorization has to special-case forever.
- `(repository_aliases.space_id, alias_key)` is unique, so one alias
  cannot point at two repositories **inside one Space**, while the same remote
  can resolve independently in another Space. `repository_aliases.space_id`
  must match the referenced Repository's `space_id`; enforce that with a
  composite foreign key/unique key, not application discipline. On
  `repositories`, add a partial unique index on
  `(space_id, host, provider_repository_id) WHERE provider_repository_id IS NOT
  NULL`.
- `projects.repository_id` is nullable — that is the non-Git project case, and it
  is present from the first migration, not retrofitted.
- `checkouts.project_id` is nullable — an observed checkout that resolved to
  `ambiguous` or `unassigned` is stored with a null project and is **not** an
  error state. It is a review queue.
- `capture_contexts` persists the exact assignment later carried by replication.
  Its Device, Person, Project, and optional SCM Account must all resolve inside
  `space_id`; cross-Space combinations fail a database constraint. `source` is a
  checked value matching the domain union above.
- Every timestamp is `timestamptz`.
- `ON DELETE`: `RESTRICT` everywhere for now. Deletion semantics belong to plan
  109's retention work; a `CASCADE` written speculatively here will delete
  audit history later.

Add to `src/schema.ts` as Drizzle declarations, and export domain types from
`src/reader.ts` that are validated, not inferred — the contract-boundary test
from plan 101 Step 4 is the pattern.

**Verify**: `bun test packages/postgres-store/src/migrations.test.ts` → the
from-empty, idempotent, ordered, and concurrent cases all still pass with the
new migration appended.

### Step 4: The repository adapter, with the cross-space test that matters

`src/project-resolution-repository.ts` loads `knownAliases` **scoped to one
Space** and calls the pure `resolveProject` from Step 1. The adapter does no
decision-making; it supplies inputs and persists outcomes.

```ts
/** Alias lookups are Space-scoped. A remote observed in another Space is invisible here by construction. */
export const loadAliasesForSpace = (spaceId: SpaceId) => …;
```

Persist each outcome:

| Outcome | Effect |
|---|---|
| `resolved-by-provider-id` / `resolved-by-alias` | attach checkout to project; refresh `last_observed_at` |
| `ambiguous` | store the checkout with `project_id = NULL`; write an `identity_events` row listing every candidate |
| `candidate` | create repository + project in the capture context's Space; record the alias |
| `unassigned` | store the checkout with `project_id = NULL`, no repository created |

`project-resolution-repository.test.ts` must include:

- **the isolation test**: seed Space A with `github.com/acme/api`; resolve the
  same remote from a device in Space B; assert a *new* repository is created in
  B and A's row is untouched. Assert by querying A's repository ID directly —
  not by counting rows.
- **rename**: same `provider_repository_id`, new `owner_path` → the repository's
  display identity updates, the old alias is retained, and `projects.id` is
  unchanged. Assert the project ID by value, before and after.
- **transfer**: `acme/api` → `newco/api` with the same provider ID → same
  outcome, plus an `identity_events` row with actor and source.
- **no provider ID, two candidates** → `ambiguous`, no mutation to either
  repository, one event row.
- **non-Git**: no remotes, `policy: 'create-candidate'` → project created with
  `repository_id IS NULL`, one checkout attached.
- **later attachment**: that same project later observes a remote → the
  repository is attached and `projects.id` is unchanged.

The last two are the "identity continuity" program gate. Write them now; they
are cheap here and expensive to retrofit after plan 107 replicates real data.

**Verify**: `bun test packages/postgres-store/src/project-resolution-repository.test.ts`
→ all pass.

### Step 5: The compatibility projection — read-only, additive

The existing local database is not migrated. Add a mapping that is a *projection*
of local identity onto platform identity:

```text
usage_rows.origin_machine_id + usage_rows.project    (local, unchanged)
        ↓  projectSourceId()  — report-core/project-group.ts:54
project source identity
        ↓  mapping table, platform side
(space_id, project_id) when acknowledged
```

Implement it as a `checkout_source_mappings` table on the platform side keyed by
`(device_id, project_source_id)`. Nothing in `packages/usage-store` changes —
verify that claim mechanically:

```bash
git diff --stat packages/usage-store   # must be empty for this plan
```

Reads that have no mapping must present as unresolved, not as an error and not
as a guess. `CONTEXT.md` **Absence is a gap** (ADR 0017) applies directly: an
unmapped project is a gap, and a filter default must never hide it.

**Verify**: `git diff --stat packages/usage-store packages/report-data` → empty.
`bun run test:packages` with no cluster running → all pass.

### Step 6: The review surface

Build the minimum ambiguity queue and nothing more. It lists checkouts with
`project_id IS NULL` and, for each: the source device label, the observed
remote or path, the proposed matches, the destination Space, and three actions
— create, link, leave unassigned.

Constraints from the record:

- ADR 0010/0012 — browser code imports the oRPC contract only, and each new data
  identity gets **one named Query policy**. `identity-review-queue` is one
  identity; do not reuse a report policy.
- The presentation gate (`plans/README.md:268`) applies to any delivered UI:
  deterministic DOM/geometry assertions, and axe in e2e (ADR 0005/0013).
- No action on this surface may publish to an organization Space. The "link"
  action targets only Spaces the caller already belongs to; assert this in a
  test *before* plan 103 exists, because until then nothing else enforces it.

**Verify**: `bun run test:e2e -- e2e/<new-spec>.spec.ts` → passes, axe clean.
On NixOS set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary;
`--channel chrome` does not work here.

### Step 7: Documentation

- `CONTEXT.md` — plan 100 added the terms; if executing 102 revealed a term that
  does not survive contact with the schema, amend it here rather than diverging.
- `docs/architecture.md` `## Package ownership` — extend the
  `@ai-usage/postgres-store` block with the identity domain.
- `docs/adr/README.md` — if the resolver diverges from ADR 0027, amend the ADR;
  do not let code and record drift.
- This file's `## Status` → **Implementation status: DONE**, and the
  `plans/README.md:66` row.

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
