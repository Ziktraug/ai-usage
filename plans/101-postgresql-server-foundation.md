# Plan 101: Add the PostgreSQL Server Foundation Without Replacing the Local SQLite Engine

> **Executor instructions**: Execute only after plan 100’s topology and ADRs are
> accepted. This plan establishes infrastructure and one real vertical health
> path; it must not migrate usage reporting, Agent Memory, authentication, or
> synchronization business data. Preserve the current SQLite writer/readers and
> prove local mode remains independent of PostgreSQL.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- package.json bun.lock turbo.json apps packages tools .github docs/architecture.md docs/adr`
> Re-read plan 100 and the current package-boundary checker on any drift.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: MEDIUM–HIGH — introduces a second persistence technology and a new
  deployable runtime
- **Depends on**: 100
- **Category**: shared-server foundation
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

The shared platform needs transactional multi-user persistence, durable
migrations, authorization resources, search extensions, and concurrent device
ingestion. PostgreSQL is a strong fit for that layer. It is not a reason to
replace the local SQLite engine, whose machine-local ownership, offline behavior,
and immutable report publication are already heavily tested.

This plan creates a clean second data plane rather than turning every existing
package into a dual-dialect abstraction.

## Target result

At the end of this plan the repository has:

- a runnable `apps/server` composition root;
- a PostgreSQL adapter package with Drizzle schema and migrations;
- a deterministic local development/test database workflow;
- health/readiness endpoints and one transaction smoke test;
- migration, backup, and failure behavior documented;
- no product table beyond minimal platform metadata needed to prove the stack;
- no change to current local usage collection or report behavior.

## Proposed boundaries

### `apps/server`

Owns:

- process lifecycle and configuration parsing;
- external HTTP listener and graceful shutdown;
- shared application-service composition;
- PostgreSQL connection pool and migration readiness check;
- structured observability for request/job boundaries;
- dependency health/readiness presentation.

Does not own:

- Drizzle table declarations;
- domain business rules;
- local harness collectors;
- direct local SQLite access;
- browser UI modules.

### `packages/postgres-store`

Owns:

- Drizzle PostgreSQL schema;
- migration files and migration runner;
- transaction/pool adapter;
- repository implementations for shared domains;
- PostgreSQL extension setup that is explicitly required;
- database-level tests and reset fixtures.

Does not own:

- HTTP routing;
- MCP tools;
- authorization policy decisions;
- public protocol types;
- local SQLite schema or migrations.

### `packages/platform-core`

Only introduce this package if plan 100 accepted it and there are concrete
cross-domain value objects needed by plan 101, such as `SpaceId`, `PersonId`,
`DeviceId`, canonical instants, or pagination limits. It must remain pure and
must not import Drizzle or runtime adapters.

## Database strategy

### Development and test

Provide one repository-owned workflow that works in CI and locally. Acceptable
implementations include a pinned PostgreSQL container or an equivalent hermetic
service; do not depend on a developer’s ambient database.

Required commands should cover:

```text
start test database
apply migrations from empty
apply migrations from previous fixture
run integration tests
reset/stop database
```

The exact command names should follow existing Bun/Turbo conventions.

### Production configuration

Use explicit environment/config parsing with typed failures for:

- database URL or connection fields;
- pool size and timeouts;
- migration mode;
- server bind host/port;
- runtime environment;
- optional TLS requirements.

No secret may be rendered in logs, diagnostics, browser payloads, or wide events.

### Migration ownership

- one ordered migration history for the shared server schema;
- migrations run in a dedicated startup/deployment step or under an explicit
  single-owner lock, never concurrently from every request process;
- application readiness remains false until schema compatibility is proven;
- destructive migrations require an explicit compatibility/rollback plan;
- disabled capabilities do not skip migrations.

### Extensions

Enable only extensions required by current work. Plan 101 may provision:

- `pg_trgm`, because later project/repository identity and fuzzy search use it;
- full-text search needs no separate extension;
- `vector` must **not** be required yet — plan 106 may add it after an evaluation
  justifies embeddings.

The migration must fail clearly when a required extension is unavailable.

## Minimal schema for this plan

Do not prebuild the complete future model. A minimal schema may contain:

```text
platform_schema_metadata
server_instances or migration_probe
```

A stronger alternative is to let plan 102 create the first domain tables and
keep plan 101’s schema to migration metadata only. The executor should prefer the
smallest schema that proves:

- generated SQL is reviewed;
- migration up from empty works;
- a transaction commits and rolls back correctly;
- constraints and timestamp mapping are stable;
- tests can isolate data.

## ORM and contracts

Use Drizzle for schema and repository adapter implementation, subject to plan
100’s contract rule:

```text
Explicit command/result schema
          ↓ map/validate
Application service
          ↓ repository port
Drizzle repository adapter
          ↓
PostgreSQL
```

Tests must prove that a storage row containing an invalid enum/value cannot cross
into a public result merely because TypeScript inferred it.

## Server HTTP foundation

The first server surface should be deliberately small:

```text
GET /health/live
GET /health/ready
```

- liveness answers whether the process event loop/runtime is alive;
- readiness verifies compatible configuration, database connectivity, and
  migration state;
- neither endpoint exposes credentials, hostnames, SQL, tenant data, or detailed
  internal failures to unauthenticated callers;
- full diagnostic detail may go to private structured logs.

Do not expose a generic SQL-backed CRUD API in this plan.

## Process lifecycle

Mirror the rigor already present in `apps/usage-engine`:

- signal ownership and bounded graceful shutdown;
- pool closure and in-flight request deadline;
- startup failure is fail-closed;
- no detached child process survives test or production shutdown;
- one process-level structured execution result per startup/migration/shutdown
  boundary where current observability conventions apply.

## Local-mode compatibility gate

Add a test or CI command proving all existing local commands can run without any
PostgreSQL environment variable or server process:

- current package/unit tests;
- local usage-engine check/start fixture;
- Web demo/local fixture build;
- CLI read paths.

Do not make root `bun run dev` start PostgreSQL or `apps/server` by default unless
plan 100 explicitly selected that developer experience. Prefer a separate
connected-mode command, for example conceptually:

```text
bun run dev                # current local product
bun run dev:connected      # local engine + shared server + web connected mode
```

Final naming is an implementation decision, not a requirement.

## Testing requirements

### Migration tests

- empty database migrates to current;
- migration rerun is a no-op/safe failure as designed;
- previous-version fixture migrates without data loss;
- incompatible future schema reports a typed failure;
- required extension absence reports actionable diagnostics;
- rollback behavior is documented, and reversible migrations are tested where
  supported.

### Repository/transaction tests

- commit and rollback;
- uniqueness and foreign-key enforcement;
- concurrent transaction behavior for one representative operation;
- connection timeout and server-unavailable classification;
- test isolation does not share rows across tests.

### Process tests

- liveness before/after DB failure behaves as specified;
- readiness stays false before migrations;
- SIGTERM drains and closes the pool;
- secrets do not appear in logs or HTTP bodies;
- local-only startup is unaffected.

## Operational documentation

Document:

- supported PostgreSQL version;
- migration command and deployment order;
- minimum required extensions;
- backup/restore procedure and ownership;
- connection pool sizing assumptions;
- readiness semantics;
- how to run local and connected development;
- failure modes when PostgreSQL is unavailable;
- the explicit statement that this database does not replace local SQLite.

Avoid selecting a proprietary managed provider in architecture docs. Provider
configuration belongs to deployment documentation later.

## Package-boundary changes

Update `tools/check-package-boundaries.ts` with narrow rules when packages exist:

- only `apps/server` (or one dedicated migration tool) may compose the
  write-capable PostgreSQL adapter;
- Web browser modules, CLI, local collectors, report-core, and usage-store may
  not import `postgres-store`;
- `postgres-store` may depend on pure domain contracts but not apps;
- `platform-core` remains domain/runtime independent.

Mutation-check at least one new boundary rule so the guard proves it can fail.

## Done criteria

- [ ] Plan 100 ADRs are accepted and referenced.
- [ ] `apps/server` starts, reports liveness/readiness, and shuts down cleanly.
- [ ] Drizzle schema and migrations are reviewed and tested from an empty DB.
- [ ] PostgreSQL test/dev lifecycle is repository-owned and reproducible.
- [ ] One transaction/repository smoke path is typed and tested.
- [ ] No Drizzle row type leaks into a public HTTP/oRPC/MCP contract.
- [ ] `pg_trgm` is provisioned only if plan 102/106’s accepted design requires it;
      `pgvector` is not required.
- [ ] Existing local mode passes without PostgreSQL or server configuration.
- [ ] Package boundaries prevent accidental shared-store imports.
- [ ] Backup, migration, readiness, and failure behavior are documented.

## STOP conditions

Stop and report when:

- the chosen server stack requires Web browser code to import server/database
  modules;
- local startup cannot remain independent of PostgreSQL;
- migrations would run concurrently from uncoordinated application instances;
- the only proposed reuse strategy is to convert `usage-store` into a generic
  SQLite/PostgreSQL ORM package;
- required extensions are unavailable in the intended self-hosted baseline;
- Drizzle cannot express a required invariant and the workaround silently moves
  data integrity out of both database constraints and application validation;
- secret-bearing configuration reaches a public error response.

## Out of scope

- production tenancy tables (plan 102);
- authorization engine integration (plan 103);
- login and sessions (plan 104);
- Agent Memory schema (plan 105);
- search and MCP (plan 106);
- device ingestion (plan 107);
- hosted deployment or billing.
