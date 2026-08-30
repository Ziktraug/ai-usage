# Plan 101: Add the PostgreSQL Server Foundation Without Replacing the Local SQLite Engine

> **Executor instructions**: Execute after plan 100's topology ADRs are
> accepted. Establish PostgreSQL and one health/transaction vertical only. Do
> not migrate usage reporting, Agent Memory, identity, authorization,
> authentication, replication, or session data in this plan.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- flake.nix flake.lock package.json bun.lock turbo.json apps packages tools .github docs/architecture.md docs/adr`

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: MEDIUM–HIGH — introduces a second persistence technology and a new
  deployable runtime
- **Depends on**: 100
- **Category**: shared-server foundation
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Plan status**: IN PROGRESS — implementation exists outside `main`, pending
  integration

## Current repository anchors

- The baseline contains no PostgreSQL/Drizzle dependency, no `apps/server`, and
  no container runtime or PostgreSQL binary in the Nix dev shell.
- NixOS development uses `flake.nix` through `.envrc`; CI uses
  `ubuntu-latest`. The repository-owned database path must be identical in both.
- `packages/usage-store/src/migration.test.ts` already demonstrates hermetic
  temp-root creation and unconditional teardown.
- The existing local SQLite migration model is one forward schema version owned
  by one writer. PostgreSQL needs an independently ordered migration ledger and
  must not reuse SQLite's `PRAGMA user_version` design.
- New TypeScript packages/apps must be registered in the TypeScript coverage
  list, focused boundary rules, and public exports.

## Target result

- `apps/server` owns process/config/HTTP composition and the only shared
  write-capable PostgreSQL pool;
- `packages/postgres-store` owns Drizzle schema, deterministic migrations,
  transaction/pool adapters, and test fixtures;
- development and CI use a repository-owned disposable PostgreSQL 17 cluster;
- `/health/live` and `/health/ready` prove lifecycle and migration readiness;
- production schema contains only migration metadata and minimal platform
  metadata needed by this plan;
- existing local Usage and the future local Memory composition can run with no
  platform configuration and no PostgreSQL connection attempt.

## PostgreSQL lifecycle decision

Use one repository-owned `tools/pg-harness.ts` that creates a per-run cluster
with `initdb` in `mkdtemp`, listens on a Unix socket with TCP disabled, and
returns an idempotent `stop()` function. Add PostgreSQL 17 to `flake.nix` so
development and CI run the same binaries.

```ts
interface PostgresCluster {
  readonly url: string;
  readonly socketDir: string;
  readonly stop: () => Promise<void>;
}

declare function startPostgresCluster(label: string): Promise<PostgresCluster>;
```

The harness owns `initdb`, `pg_ctl`, cleanup, missing-binary diagnostics, and
manual inspection support. Tests never depend on an ambient cluster. If cluster
startup is measured above roughly two seconds and dominates the suite, retain
the harness but switch to one cluster per test process and one database/schema
per test. Record the measurement before changing lifecycle.

Rejected alternatives are non-normative:

- container-first development is unavailable on the baseline machine and
  would diverge from Nix;
- a GitHub Actions service is not the primary path because local/CI behavior
  would differ;
- an ambient system PostgreSQL cannot provide hermetic isolation.

## Package and process boundaries

### `packages/postgres-store`

Owns schema declarations, SQL migrations, migration runner, pool/transaction
adapters, shared-domain repositories added by later plans, and testing helpers.
It owns no HTTP, MCP, authorization policy, local SQLite, or harness filesystem
access.

Initial public subpaths are explicit, for example `./migrations`, `./reader`,
`./writer`, `./schema`, and `./testing`. Cross-package imports use only declared
exports. Add the narrowest boundary policy and its mutation test.

### `apps/server`

Owns typed secret/config parsing, external HTTP, startup/migration readiness,
graceful shutdown, one shared application composition root, and one PostgreSQL
write composition root. It may not import the existing usage SQLite writer,
local collectors, CLI, Web implementation, or machine-local harness readers.

### `packages/platform-core`

Create only if plan 101 has a concrete cross-domain value object. It remains
pure and never imports Drizzle or runtime adapters. Empty speculative packages
are forbidden.

## Production configuration

Parse configuration through typed failures:

- database URL/fields and TLS requirements;
- pool size/connect/query/shutdown timeouts;
- migration mode (`apply` or `verify`);
- server bind host/port and runtime environment.

No database URL, credential, hostname, raw SQL, or exception text appears in
public health responses, logs, browser payloads, or wide events. Secret-bearing
configuration uses a redacted representation.

## Deterministic migration model

Migration order is an explicit ordinal, never a timestamp, directory order, or
assumed insertion order.

```ts
interface PlatformMigration {
  readonly id: string;
  readonly ordinal: number;
  readonly up: string;
}

const PLATFORM_MIGRATIONS: readonly PlatformMigration[] = [/* explicit order */];
```

```sql
CREATE TABLE platform_migrations (
  id          TEXT PRIMARY KEY,
  ordinal     INTEGER NOT NULL UNIQUE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Runner requirements:

- validate IDs and strictly increasing unique ordinals in code before SQL;
- acquire one PostgreSQL advisory lock for the migration run;
- apply each missing migration in ordinal order, one transaction per migration,
  recording `id`, `ordinal`, and `applied_at` in that transaction;
- refuse a database containing an unknown applied ID/ordinal or an ID whose
  ordinal disagrees with the compiled sequence;
- keep readiness false until compatibility is proven;
- always release the lock.

Tests assert the explicit ordinal sequence and an observed application trace.
They must not prove ordering through coincident `applied_at` values or storage
insertion order.

## Minimal production schema

Plan 101 creates only:

- `platform_migrations`;
- `platform_schema_metadata(key, value, updated_at timestamptz)` if a real
  readiness/transaction probe needs it.

Do not create `server_instances`, speculative identity tables, or an artificial
production `status` column merely to test invalid-enum mapping. Prove the
contract/storage boundary with a test-only fixture table/schema, or defer the
invalid-domain-value case to plan 102's first real domain table. Production
migrations remain minimal.

Drizzle rows are adapter-private. Repository readers map/validate into explicit
domain results, and a test-only invalid value must fail with a typed validation
error rather than crossing the boundary.

## Extensions

- Full-text search needs no extension.
- Provision `pg_trgm` when plan 102/106 first needs it; provisioning in plan 101
  is acceptable only if the minimal foundation test exercises availability.
- Do not require `vector`. Plan 106 gates `pgvector` on measured recall failure.
- A missing required extension is a typed readiness/migration error.

## HTTP and lifecycle contract

```text
GET /health/live
GET /health/ready
```

- liveness reports only that the process/event loop is serving;
- readiness is 200 only after config, DB connectivity, and compiled/applied
  migration compatibility pass;
- not-ready is a bounded generic 503 with no internal reason;
- detailed reasons go only to private structured observability;
- no generic CRUD endpoint exists in this plan.

The process owns signals, bounded request drain, pool closure, migration startup
failure, and child cleanup. No detached process survives teardown.

## Local-mode independence contract

The test must prove **PostgreSQL was not consulted**, not that no PostgreSQL
process exists on the machine.

Required test setup:

1. remove all `AI_USAGE_PLATFORM_*` variables from the test environment;
2. inject the platform connection/factory adapter with an implementation that
   records calls and immediately fails if invoked;
3. run representative local package, usage-engine, Web demo/build, and CLI read
   paths;
4. assert every local command passed and the adapter call count is zero.

Do not use `pgrep`, a reserved port, or global process inspection as a product
correctness gate. An unrelated developer PostgreSQL must not fail local tests.

Keep `bun run dev` local. A separate connected command may compose PostgreSQL
and `apps/server`; final naming is an implementation detail.

## Steps

### Step 1: Add the hermetic PostgreSQL harness

Add PostgreSQL 17 to the Nix shell. Implement `tools/pg-harness.ts` using a
private temp data directory, private socket directory, `--auth=trust` only for
the disposable local cluster, `--no-sync` only for disposable tests, TCP
disabled, typed missing-binary errors, and unconditional idempotent teardown.

Test two concurrent clusters for isolation and verify their temp roots are gone
after teardown.

### Step 2: Create the store package

Add `packages/postgres-store` with explicit subpath exports, its TypeScript
project registration, dependency boundary, and package tests. Add only pinned
dependencies actually used by the foundation.

### Step 3: Implement ordered migrations

Implement the ordinal ledger and advisory-lock runner. Test empty, idempotent,
previous fixture, unknown future migration, ordinal mismatch, and two concurrent
runners. Assert order by ordinal/application trace.

### Step 4: Prove the contract boundary without polluting production schema

Use a test-only fixture or the first real plan-102 domain table. Insert an
invalid domain value through raw SQL, call the validated reader, and assert a
typed mapping failure. Do not add unused production columns.

### Step 5: Create `apps/server`

Add typed config, one write-pool composition root, health endpoints, graceful
shutdown, explicit Turbo environment passthrough, project registration, and
strict package boundaries. Tests cover ready, missing migration, stopped pool,
secret-free errors, and shutdown.

### Step 6: Prove local independence

Run the adapter-call-count gate above with no platform configuration. Add CI
coverage that separates local suites from PostgreSQL suites without assuming
the runner has no unrelated database process.

### Step 7: Document operations

Document PostgreSQL version, migration order/lock, extensions, config,
readiness, backup/restore ordering, connected development, and the explicit
statement that PostgreSQL does not replace either local SQLite authority.

## Verification

- hermetic harness starts/stops two isolated clusters;
- migration tests cover empty, idempotent, prior, future, ordinal mismatch, and
  concurrency;
- production schema has no test-only status column;
- server health/lifecycle tests pass without secret disclosure;
- injected platform adapter records zero calls in local mode;
- `bun run lint`, typecheck, package tests, and relevant full checks pass.

## Done criteria

- [ ] Plan 100 ADRs are accepted and referenced.
- [ ] Repository-owned PostgreSQL 17 lifecycle works in Nix development and CI.
- [ ] Migration order is represented and tested through a unique ordinal.
- [ ] Minimal production schema contains no speculative business table/column.
- [ ] `apps/server` owns the only shared write pool and has bounded health and
      shutdown behavior.
- [ ] Drizzle rows cannot escape into public contracts.
- [ ] Local commands prove zero PostgreSQL adapter calls without global process
      inspection.
- [ ] Package boundaries and operational backup/migration docs are complete.

## STOP conditions

Stop and report when:

- local startup consults PostgreSQL;
- migration order depends on timestamps, filesystem ordering, or row insertion;
- migrations run concurrently without one explicit owner/lock;
- a test-only validation need adds unused production schema;
- the store abstraction tries to make the existing SQLite and PostgreSQL one
  dual-dialect package;
- required secrets reach public errors;
- Web browser code must import the server/store.

## Out of scope

- identity/tenancy tables (plan 102);
- full organization authorization (plan 103);
- login/enrollment (plan 104);
- Agent Memory (plan 105);
- search/MCP (plan 106);
- replication (plan 107);
- hosted deployment/provider selection.
