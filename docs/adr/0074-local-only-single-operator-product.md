# ADR 0074: Local-only, single-operator product; manual transfer bundles are the only cross-machine path

- **Status**: Accepted
- **Date**: 2026-10-24
- **Supersedes**: [ADR 0023](0023-one-product-local-and-shared-compositions.md),
  [ADR 0030](0030-postgresql-domain-authorization-before-openfga.md),
  [ADR 0031](0031-outbound-only-device-replication.md),
  [ADR 0033](0033-separate-person-auth-scm-and-device-identities.md),
  [ADR 0034](0034-authorize-complete-search-scope-before-ranking.md),
  [ADR 0035](0035-opt-in-normalized-session-archives.md) and
  [ADR 0036](0036-github-authentication-and-hmac-device-credentials.md) entirely
- **Amends**: the connected clauses of
  [ADR 0024](0024-separate-usage-memory-and-shared-data-authorities.md),
  [ADR 0026](0026-db-native-agent-memory-with-file-adapters.md),
  [ADR 0027](0027-mcp-is-an-edge-adapter.md),
  [ADR 0028](0028-stable-project-identity-and-repository-locators.md),
  [ADR 0029](0029-application-owned-authorizer.md) and
  [ADR 0038](0038-local-memory-store-writer-lease-and-startup-coupling.md), listed below
- **Carries**: the guardrails of the retired
  [ADR 0025](0025-trusted-capabilities-before-public-plugins.md) and
  [ADR 0032](0032-work-handoffs-before-native-session-conversion.md)
- **Preserves**: [ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
  (two planes, manual file transfer) and
  [ADR 0003](0003-isolated-synthetic-runtime.md) (synthetic runtime)

## Context

ADR 0023 made ai-usage one product with two compositions: a local one and a
connected one with a shared server, PostgreSQL, GitHub login through Better
Auth, organization authorization, Device enrollment and outbound replication
(plans 100–110). PR #53 integrated the connected runtime of plans 101–107;
plans 108–110 never started. The product has one operator, and that operator
decided on 2026-10-24 to delete the connected platform (plan 120, operator
decisions 0, 1, 5 and 6).

The connected half was not free while unused. It owns `apps/server` (1,198
source lines), `packages/postgres-store` (8,837), the PostgreSQL tools and
tests (5,999 lines under `tools/`), two CI jobs (`local-platform-independence`,
`postgres-foundation`), PostgreSQL 17 in the flake, and dependency upgrade work
such as ADR 0036's 2026-10-22 Better Auth amendment. Local decisions since
ADR 0023 also had to account for a third authority and a second composition
(ADRs 0024, 0026, 0027 and 0038).

## Decision

ai-usage is a **local-only, single-operator product**. It has no account,
login, server application, shared database, organization or tenant model, and
no outbound replication. Every listener stays on numeric loopback (ADR 0009,
ADR 0072); nothing it runs is reachable from another machine.

**Manual transfer is the only cross-machine path.** Usage moves between the
operator's machines only as an explicit export of a usage snapshot or merge
bundle, an out-of-band file copy and an explicit import: the `/sync` workspace
and the CLI `snapshot`, `merge`, `machine` and `cursor import` commands. There
is no discovery, pairing or background synchronization. ADR 0009's
local-observed versus portable-opaque authority and its bounded, staged upload
path apply unchanged.

**Operator-installed clients are the only network-facing surface.** They act
with the operator's own credentials and own their communication: the engine's
quota sources run the installed Codex CLI app-server and the Claude Agent SDK
([architecture](../architecture.md)), and the Web server runs a bounded
`gh pr list` on demand for one Session's VCS context
(`apps/web/src/server/session-vcs.server.ts`). PR #67 adds further such reads
and an engine-launched review attempt under its own ADRs (0051–0054 on
`feat/work-resume-cockpit`). ai-usage operates no service of its own.

Guardrails carried from retired records:

- no public plugin SDK, and no arbitrary user code loaded into a trusted
  process (from ADR 0025);
- production code never writes a harness's native session store; it reads them
  (from ADR 0032).

### What this supersedes and amends

- ADR 0023 (two compositions), 0030 (PostgreSQL authorization), 0031 (Device
  replication), 0033 (Person/authentication/SCM/Device identities), 0034
  (multi-principal search scope), 0035 (session archives, never implemented)
  and 0036 (GitHub authentication, HMAC Device credentials) are superseded
  entirely.
- ADR 0024 loses the shared PostgreSQL authority; ADR 0026 its PostgreSQL
  adapter and "both modes"; ADR 0027 its connected MCP composition; ADR 0028
  its cross-device motivation, leaving one constant personal Space in the
  local schema; ADR 0029 its organization model and PostgreSQL adapters,
  leaving `SingleUserAuthorizer` as a fail-closed fence; ADR 0038 its
  PostgreSQL and replication availability clause.

### Phase A (plan 120, branch `refactor/remove-connected-platform`)

Delete `apps/server`, `packages/postgres-store`, `packages/project-application`,
the PostgreSQL tools and tests, `tools/run-connected-server.ts`,
`tools/check-local-platform-independence.ts`, both platform CI jobs,
`postgresql_17` in the flake, the platform root scripts (`dev:platform`,
`dev:server`, `start:server`, `test:postgres`, `test:local-platform`,
`benchmark:authorization`) and their dependencies. Strip Better Auth from
`packages/identity` and the organization half from `packages/authorization`.
The Device token and private credential modules of `packages/identity` stay
until phase B because the dormant replication client imports them; that client
starts only when `AI_USAGE_PLATFORM_BASE_URL` is set
(`apps/usage-engine/src/main.ts`), and no supported server exists to set it to.

### Phase B (after PR #67 lands on `main`)

- Remove replication end to end: the engine replication runtime, the outbox
  writers of both stores, the `replication-status` control command, CLI
  `replication status`, the Sources replication panel and the
  `replication.status` procedure, `packages/replication-*` and what remains of
  `packages/identity`.
- Drop the usage store's `replication_outbox_state` and
  `replication_outbox_events` tables with a forward-only schema change (usage
  schema 5), after the backup procedure of
  [`docs/local-store-upgrade.md`](../local-store-upgrade.md), row counts taken
  on a copy, and disposable-store tests. This is the operator's explicit
  exception to ADR 0075's rule that retiring a feature keeps its tables.
- Remove accepted Memory (`/memory`, `memory search`, the MCP memory tools, the
  Memory service and store) and the `/projects` checkout resolution review,
  together with the Memory listener and writer lease (ADR 0038), the
  Memory-kernel half of Checkout observation (ADR 0044), `project-registry`,
  and `packages/authorization` if nothing else needs it. ADRs 0024, 0026, 0028,
  0029 and 0038 then retire. MCP stays for `work.context` (ADR 0058 on
  `feat/work-resume-cockpit`). The checkout status producer of ADR 0051 on that
  branch enumerates canonical paths and worktrees on its own, without the
  Memory store, and is unaffected.

Report Session grouping is unaffected by either phase: it comes from the report
projection (`packages/report-data/src/project-projection.ts`: linked worktrees
under their parent repository, project aliases, project groups edited in
Analysis) and never reads the Memory store.

## Consequences

- ADR 0023's offline guarantee holds by construction instead of by a CI probe:
  after phase B no code that could contact a platform remains, and
  `test:local-platform` is deleted with phase A.
- Local decisions name at most two authorities until phase B (usage SQLite,
  Memory SQLite) and one after it.
- The Space, Person and Device rows already written to `memory.sqlite` stay
  as data. No migration removes them; under ADR 0075 the code that retires
  Memory stops opening the store but does not delete the file.
- A second operator, a shared view or a hosted deployment is out of scope. It
  would need a new ADR with its own authentication, authorization and storage
  decisions; restoring the deleted packages from history is not such a plan.

## Rejected alternative

Keeping the connected composition dormant (code kept, CI jobs dropped) was
rejected. It keeps Better Auth and PostgreSQL dependencies that must be
upgraded for no user, a third authority in every store and identity decision,
and PostgreSQL suites outside `verify` whose only job would be keeping unused
code green.

## Evidence

- [Merge bundle package](../../packages/usage-merge/src/index.ts) and the
  [manual merge endpoints](../../apps/web/src/routes/api/manual-merge)
- [`/sync` workspace](../../apps/web/src/routes/sync/+page.svelte) and the
  [CLI commands](../../apps/cli/src/cli.ts)
- [Report project projection](../../packages/report-data/src/project-projection.ts)
- [Local store upgrade procedure](../local-store-upgrade.md)
- Plan 120 (`plans/120-local-only-cleanup.md`, operator decisions table)
