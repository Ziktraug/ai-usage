# Identity kernel and Project resolution

This is the living reference for the identity kernel introduced by plan 102. It
defines stable identities shared by the local SQLite and connected PostgreSQL
adapters, the local single-user authorization boundary, repository resolution,
and the smallest review workflow. Organization ReBAC is documented in
[authorization](authorization.md); connected GitHub login and Device enrollment
are documented in [authentication and Device enrollment](authentication-and-device-enrollment.md).
Agent Memory content, replication, and Work handoffs remain dependent work.

## Stable identity model

All public identity IDs are canonical UUIDs parsed into distinct branded types.
Timestamps crossing the domain boundary are canonical UTC ISO instants. Paths,
remote URLs, hostnames, provider handles, and display labels are locators or
provenance, never primary identities.

| Identity | Stable meaning | Explicitly separate from |
| --- | --- | --- |
| `Space` | Personal or organization ownership/authorization root | Repository owner, SCM login, Project group |
| `Person` | One human with one personal Space | Authentication identity, SCM account, Device |
| `Device` | One local ai-usage runtime | Usage machine label, hostname, credential |
| `ScmAccount` | Person-scoped provider identity | Installation, login identity, secret |
| `ScmInstallation` | Space-scoped provider grant | Account, organization ownership inference |
| `ScmCredential` | Secret reference attached to exactly one account or installation | Identity and Device credential |
| `Repository` | Space-scoped source-control identity | Remote URL and Project |
| `Project` | Stable cross-device work identity | Repository, Checkout, Project source/group |
| `Checkout` | Device-local working-copy observation | Project and filesystem authority |
| `CaptureContext` | Explicit Person, Device, Space, optional Project and SCM assignment | Post-hoc ownership inference |

`ProjectId` remains unchanged when a repository is attached later, when the
checkout path or Device changes, and when a provider repository is renamed or
transferred. Non-Git Projects and unresolved Checkouts are valid states.
Repository aliases preserve historical remote locators; identity events record
repository rename/transfer facts without rewriting historical identity.

## Local and connected authorities

The local identity kernel lives in the dedicated `memory.sqlite`, not the usage
SQLite data plane. On first open it atomically creates exactly one local Person,
personal Space, and opaque local Device, then preserves their IDs across
restarts. The database is owner-only, uses SQLite foreign keys, WAL, strict
tables, and one schema version. The usage engine owns its only write-capable
connection.

The local schema intentionally contains only the identity subset needed before
Agent Memory: Space, Person, Device, Repository and aliases, Project, Checkout,
Capture Context, identity events, resolution candidates, and acknowledged
Project-source mappings. It does not emulate organization membership, login,
SCM credentials, or connected Device enrollment.

The connected adapter uses PostgreSQL migration ordinal 2,
`0002_identity_kernel`. Tenant-scoped records carry a non-null `space_id`, and
composite foreign keys prevent Repository, alias, Project, Checkout, Capture
Context, and mapping references from crossing Spaces. PostgreSQL additionally
stores the separately constrained SCM account, installation, and credential
records. Every connected timestamp is `timestamptz`; lifecycle references use
restricted deletion rather than destructive cascades, except ephemeral
resolution candidates owned by a Checkout.

Both adapters consume domain contracts from `@ai-usage/platform-core` and pure
resolution/review contracts from `@ai-usage/project-registry`. Storage row
shapes and database clients do not escape their adapters.

## Authorization boundary

`@ai-usage/authorization` owns the application-level `Authorizer` port. A
decision is explicitly `allow`, `deny`, or `error`; unavailable infrastructure
never becomes a denial or an allow.

`SingleUserAuthorizer` permits only the bootstrapped local Person over compatible
resources in that Person's personal Space. It denies foreign Spaces,
non-local/service principals, and permission/resource mismatches. Resource
listing is Space-scoped, deterministic, cursor-based, and bounded to 100 items
per page. Complete opaque scope, organization relations, explicit PostgreSQL
queries, RLS, and the authorized Project vertical are documented in
[authorization](authorization.md).

## Repository resolution

Repository resolution is pure and adapter-independent:

1. validate the Checkout path and optional monorepo subpath;
2. normalize a credential-free SSH or HTTPS remote while preserving the
   existing VCS display/provenance behavior;
3. restrict every candidate to the Capture Context Space;
4. prefer a verified provider repository ID;
5. otherwise match the normalized alias;
6. resolve exactly one match, return every match when ambiguous, or create an
   explicit candidate/unassigned outcome;
7. never choose across Spaces or infer organization ownership.

Known GitHub/GitLab aliases normalize provider case and `.git`/separator
differences. Self-hosted hosts and case-sensitive paths stay distinct. A
provider-ID match reports alias disagreement so a rename can retain the old
alias rather than silently merging another Repository.

Adapters persist the pure outcome and keep ambiguity visible. A new resolution
observation resets any previous review acknowledgement. Explicit review actions
can create a local Project, link the Checkout to a candidate Repository (and
optionally an existing Project), or leave it unassigned.

## Compatibility with usage reports

Existing usage rows and Project groups are unchanged. Their established
machine-plus-source `projectSourceId` remains the local report identity. An
acknowledged, Space-scoped mapping may add a `ProjectId` and `CheckoutId`:

```text
origin machine + local project string
  -> existing projectSourceId
  -> optional acknowledged ProjectId + CheckoutId mapping
```

No migration rewrites usage rows, changes Project-group semantics, or guesses a
global Project when the mapping is absent.

## Local Memory service and review UI

The usage engine starts the identity kernel after acquiring and starting its
usage writer, then exposes it through a separately named Memory service. This
is not the usage-engine control plane. The service binds only to numeric
`127.0.0.1`, publishes an owner-only `memory-service.json` rendezvous with an
independent bearer token and protocol version, enforces bounded JSON, and runs
`SingleUserAuthorizer` before reads or mutations. Shutdown removes the
rendezvous and stops the service before closing `memory.sqlite` and the usage
runtime.

The generic rendezvous publisher preserves an existing file by default. The
production engine may replace the stale Memory rendezvous left by a crash only
after its usage writer lease has established exclusive runtime ownership; the
real-process crash-recovery test fixes that ordering.

The current protocol exposes only two bounded repository-resolution operations:

- `GET /v1/repository-resolutions`;
- `POST /v1/repository-resolutions/actions`.

Web loads the rendezvous only in server code. Browser code imports the oRPC
contract, and TanStack Query owns the named `projects/resolution-reviews/v1`
identity. `/projects` shows only the source Device label, an opaque
`checkout:<id-prefix>` label, normalized remote, candidate labels, and
destination Space. It never returns the local Checkout path. Successful
create/link/leave-unassigned actions acknowledge only that review in the cache
and leave the query stale for a later authoritative read.

## Verification

The focused gates are:

```sh
bun run test:local-platform
nix develop --command bun run test:postgres
flock /tmp/ai-usage-e2e.lock bash -lc \
  'cd apps/web && bun --bun playwright test e2e/projects.spec.ts --workers=1'
```

The local-platform gate injects a PostgreSQL connector that records and fails
every consultation; local package/runtime/CLI/Web operations must pass with an
exact call count of zero. PostgreSQL integration tests cover migration order,
Space fences, SCM separation, stable identity, additive mappings, and the
review actions against repository-owned PostgreSQL 17 binaries.
