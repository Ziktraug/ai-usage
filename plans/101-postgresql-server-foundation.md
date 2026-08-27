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

## Current state

### There is no PostgreSQL anywhere, and no way to run one yet

This is the plan's first real obstacle, and it is an environment problem before
it is a code problem:

```text
$ grep -rl "drizzle\|postgres" package.json packages apps   → no output
$ command -v docker podman nerdctl                          → all absent
$ command -v postgres pg_ctl initdb psql                     → all absent
```

The development machine is NixOS with `flake.nix:26-29` declaring a devShell of
exactly two packages (`biome`, `bun`), consumed through `.envrc` (`use flake`).
CI runs `ubuntu-latest` (`.github/workflows/pr-checks.yml:62,78,95`).

**There is no container runtime on the development machine.** A plan that says
"start a pinned PostgreSQL container" is unexecutable here. Step 1 resolves this.

### The hermetic-temp-directory test pattern already exists — copy it

`packages/usage-store/src/migration.test.ts:18-31` is the shape every storage
test in this repo follows:

```ts
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

// inside a test:
const root = await mkdtemp(path.join(tmpdir(), 'usage-store-served-schema-preservation-'));
temporaryRoots.push(root);
const dbPath = path.join(root, 'usage-store.sqlite');
await Effect.runPromise(initializeUsageStore({ dbPath }));
```

No shared fixture database, no ambient daemon, no cleanup ordering between test
files. The PostgreSQL harness must present the same ergonomics or storage tests
will diverge into two styles.

### The existing migration mechanism, for contrast

`packages/usage-store/src/index.ts:1035-1051` is the whole local migration
system:

```ts
const migrate = (db: SqliteDatabase): boolean => {
  const schemaVersion = db.query('PRAGMA user_version').get() as { user_version: number };
  if (schemaVersion.user_version > USAGE_STORE_SCHEMA_VERSION) {
    // refuse: the store is newer than this build
```

One integer, `CREATE TABLE IF NOT EXISTS` for 12 tables
(`index.ts:1053-1210`), forward-only, refusing to open a future schema. Do not
port this design to PostgreSQL — it works because one process owns the file.
A shared server has concurrent deployments and needs ordered, individually
recorded migrations. State that contrast in the ADR trail; it is the reason the
two stores get different mechanisms.

### The three package checks a new package must satisfy

Both packages this plan creates must satisfy all three checks:

1. `tools/check-typescript-coverage.ts:4-20` — register each `tsconfig` in
   `TYPECHECK_PROJECTS`. The checker scans tracked TypeScript and fails on
   uncovered files, so a missing registration is visible.
2. `tools/check-package-boundaries.ts:61-133` — add explicit
   `boundaryPolicies` entries for the architectural rules below; this array is
   targeted, not an automatically exhaustive package registry.
3. Each package's own `package.json` `exports` — enforced by
   `tools/check-public-package-exports.ts`; see
   `packages/usage-store/package.json:6-11`.

The allowlist idiom to copy is
`tools/check-package-boundaries.ts:153-162`:

```ts
const engineRuntimeAllowedWorkspaceDependencies = new Set([
  '@ai-usage/effect-runtime',
  '@ai-usage/local-collectors',
  ...
]);
```

An allowlist fails closed when a future plan adds a dependency; a denylist does
not. `apps/server` gets an allowlist.

### Where a new app registers its tasks

- `package.json:13-42` — root scripts. `lint` (`:24`) and `typecheck` (`:36`)
  are chained shell commands; a new tool call is appended there.
- `turbo.json:3-149` — `build`/`check`/`test`/`dev`/`start` task defaults, with
  per-package overrides keyed `@ai-usage/<name>#<task>`. Note
  `@ai-usage/usage-engine#dev` (`:82-141`) enumerates `passThroughEnv`
  explicitly — a new server app needs the same treatment for its database
  environment variables, because Turbo strips anything unlisted.
- `apps/usage-engine/package.json` is the closest template for a new app:
  one `exports` entry (`./main`), and `dev`/`start`/`build`/`check`/`test`
  scripts.

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

The following dated resolution narrows that recorded choice without deleting it.

Resolved above ("Decision this plan closes"): one repository-owned harness,
`tools/pg-harness.ts`, creating a per-run cluster with `initdb` into a temp
directory on a Unix socket. Never a developer's ambient database.

The lifecycle is a library API, not a set of shell commands, so that test files
cannot forget teardown:

| Capability | Surface |
|---|---|
| start an isolated cluster | `startPostgresCluster(label)` → `{ url, socketDir, stop }` |
| apply migrations from empty | `applyMigrations(url)` from `@ai-usage/postgres-store/migrations` |
| apply migrations over a fixture | `applyMigrations` after `seedFixture(url, name)` from `./testing` |
| run integration tests | `bun test packages/postgres-store` |
| reset / stop | `await cluster.stop()` in `afterEach`, mirroring `migration.test.ts:20-22` |

The one shell entry point is `bun tools/pg-harness.ts --start`, for manual
inspection with `psql`. It is not used by tests.

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

The dated resolution below selects that recorded alternative.

Resolved: plan 101 creates `platform_schema_metadata` and `platform_migrations`
only. Plan 102 creates the first domain tables. Do not add a
`server_instances` table — nothing reads it yet, and an unused table in the
first migration sets the precedent that migrations are speculative.

The schema for this plan is the smallest one that proves:

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

## Decision this plan closes: how to run PostgreSQL in dev and CI

The parent program left this open ("a pinned PostgreSQL container **or an
equivalent hermetic service**"). It is closed here because the machine has no
container runtime and an unresolved choice blocks every later plan.

**Decision: a per-run cluster created with `initdb` into a temp directory, on a
Unix socket, in both dev and CI.** PostgreSQL enters `flake.nix`'s devShell.

Why this over the alternatives:

| Option | Verdict |
|---|---|
| `initdb` + `pg_ctl` into `mkdtemp` | **Chosen.** No daemon, no root, no port allocation (Unix socket), identical code path in dev and CI, and it mirrors `migration.test.ts:18-31` exactly. Nix pins the version for free. |
| Docker/Podman container | Rejected: absent on the development machine, and adding a container runtime to a NixOS devShell to run one database is a heavier dependency than the database. |
| GitHub Actions `services:` block | Rejected as the primary path: it only exists in CI, so the dev and CI code paths would differ — the exact split that makes "works on my machine" bugs. |
| A developer's ambient `postgresql.service` | Rejected: the program forbids depending on an ambient database, and shared state breaks test isolation. |

**Reversal condition**: if per-test-file cluster startup exceeds ~2 s and
dominates the suite, switch to one cluster per `bun test` process with a
database-per-test inside it. That is a change to `tools/pg-harness.ts` only —
no test file changes. Record the measurement before switching.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Enter the shell after Step 1 | `direnv reload` (or `nix develop`) | `command -v initdb` resolves |
| PostgreSQL version pinned | `initdb --version` | `initdb (PostgreSQL) 17.x` |
| Start a scratch cluster by hand | `bun tools/pg-harness.ts --start` | prints a socket dir and `PGHOST=…` |
| Migrations from empty | `bun run --cwd packages/postgres-store migrate:test` | applies all, exit 0 |
| postgres-store tests | `bun test packages/postgres-store` | all pass |
| server tests | `bun test apps/server` | all pass |
| Health endpoints by hand | `bun run --cwd apps/server dev` then `curl -s localhost:4319/health/ready` | `200` with `{"status":"ready"}` |
| **Local-mode regression (the gate)** | `bun run test:packages` with **no** cluster running | all pass |
| Typecheck (must list new packages) | `bun run typecheck` | exit 0 |
| Boundaries | `bun run lint` | exit 0 |
| Format | `bun x ultracite fix` | exit 0 |
| Full verification | `bun run check && bun run lint && bun run typecheck && bun run test` | exit 0 |

## Git workflow

- Branch `plan/101-postgres-foundation`, cut from the branch carrying plan 100's
  accepted ADRs. Stage by explicit path; never `git add -A`.
- Expect three commits, in this order, each independently green:
  1. `build(nix): add postgresql to the devShell and a hermetic cluster harness`
  2. `feat(postgres-store): add the shared schema package with ordered migrations`
  3. `feat(server): add the platform composition root with health and readiness`
- `flake.lock` changes in commit 1. Commit it — it is the version pin.
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Make PostgreSQL available, hermetically

1. Add to `flake.nix:26-29`:

   ```nix
   packages = with pkgs; [
     biome
     bun
     postgresql_17
   ];
   ```

   Then `direnv reload` and confirm `initdb --version`. Commit the resulting
   `flake.lock`.

2. Create `tools/pg-harness.ts`. It is the single owner of cluster lifecycle;
   no test file calls `initdb` directly.

   ```ts
   export interface PostgresCluster {
     readonly url: string;        // postgresql://…?host=<socketDir>
     readonly socketDir: string;
     readonly stop: () => Promise<void>;
   }

   /** Creates an isolated cluster in a fresh temp directory. Unix socket only — no TCP port. */
   export const startPostgresCluster = async (label: string): Promise<PostgresCluster> => { … };
   ```

   Implementation notes that matter:
   - `mkdtemp(path.join(tmpdir(), \`ai-usage-pg-${label}-\`))`, mirroring
     `migration.test.ts:26`.
   - `initdb -D <dir>/data --auth=trust --no-sync --username=ai_usage`.
     `--no-sync` is safe and materially faster **because the cluster is
     discarded**; never let this flag reach a production path.
   - `pg_ctl -D <dir>/data -o "-k <dir>/sock -h ''" -w start` — `-h ''` disables
     TCP entirely. This is what makes concurrent test files safe: there is no
     port to collide on.
   - `stop()` runs `pg_ctl stop -m immediate` then `rm -rf`, and is idempotent.
   - Throw a typed error naming the missing binary when `initdb` is absent, with
     the remedy (`direnv reload`). A confusing ENOENT here will cost the next
     executor an hour.

3. Add `tools/pg-harness.test.ts`: start two clusters concurrently, assert
   distinct socket dirs, write and read a row in each, stop both, assert both
   temp directories are gone.

**Verify**: `bun test tools/pg-harness.test.ts` → passes.
`ls /tmp | grep ai-usage-pg` → empty afterwards.

### Step 2: Create `packages/postgres-store`

1. `packages/postgres-store/package.json`, mirroring
   `packages/usage-store/package.json`'s subpath-as-capability idea. The
   read/write split is expressed in the module graph from day one:

   ```json
   {
     "name": "@ai-usage/postgres-store",
     "version": "0.1.0",
     "private": true,
     "type": "module",
     "exports": {
       "./migrations": "./src/migrations.ts",
       "./reader": "./src/reader.ts",
       "./schema": "./src/schema.ts",
       "./testing": "./src/testing.ts",
       "./writer": "./src/writer.ts"
     },
     "dependencies": {
       "drizzle-orm": "^0.44.0",
       "effect": "^3.21.4",
       "postgres": "^3.4.0"
     },
     "scripts": {
       "build": "tsc --noEmit",
       "check": "tsc --noEmit",
       "test": "bun test",
       "lint": "biome check .",
       "format": "biome format --write ."
     }
   }
   ```

   Pin the exact resolved versions from `bun.lock` after install; the carets
   above are placeholders to replace.

2. `packages/postgres-store/tsconfig.json` — copy
   `packages/usage-store/tsconfig.json` verbatim (extends `../../tsconfig.json`,
   `include: ["src/**/*.ts"]`, `strictNullChecks: true`).

3. **Register in `tools/check-typescript-coverage.ts:4-20`**, alphabetically
   between `local-machine` and `report-core`:
   ```ts
   'packages/postgres-store/tsconfig.json',
   ```
   Forgetting this is silent — the package simply never typechecks.

4. **Register in `tools/check-package-boundaries.ts:61`**, appended to
   `boundaryPolicies`:
   ```ts
   {
     packageName: '@ai-usage/postgres-store',
     forbiddenDependencies: ['@ai-usage/*'],
     forbiddenImports: ['@ai-usage/*'],
     reason: 'postgres-store owns shared schema and adapters only; it must not know about HTTP, MCP, authorization policy, or local SQLite.',
   },
   ```
   Start fully closed. Plan 102 relaxes it to exactly `@ai-usage/platform-core`
   if and when that package exists — and that relaxation is a reviewable diff.

5. Also add a policy forbidding the reverse direction, so the two data planes
   can never be composed in one module:
   ```ts
   {
     packageName: '@ai-usage/usage-store',
     forbiddenDependencies: [/* existing */, '@ai-usage/postgres-store'],
     forbiddenImports: [/* existing */, '@ai-usage/postgres-store'],
     ...
   }
   ```
   Amend the existing `usage-store` entry (`:78-83`) rather than adding a second
   one, and extend its `reason` string.

**Verify**: `bun run typecheck` → exit 0 (proves registration).
`bun run lint` → exit 0.

### Step 3: Ordered migrations, and the test that proves they are ordered

1. `src/schema.ts` — Drizzle table declarations. For this plan, exactly one
   table:

   ```ts
   export const platformSchemaMetadata = pgTable('platform_schema_metadata', {
     key: text('key').primaryKey(),
     value: text('value').notNull(),
     updatedAt: timestamptz('updated_at').notNull().defaultNow(),
   });
   ```

   Use `timestamptz`, never `timestamp`. A naive timestamp column in a
   multi-device product is a defect that surfaces months later as
   off-by-one-hour report rows.

2. `src/migrations.ts` — an explicit ordered array, not a directory scan:

   ```ts
   export interface Migration {
     readonly id: string;   // '0001_platform_schema_metadata'
     readonly up: string;   // SQL
   }
   export const MIGRATIONS: readonly Migration[] = [ … ];
   ```

   The runner:
   - creates `platform_migrations(id text primary key, applied_at timestamptz not null default now())`;
   - takes `pg_advisory_lock(<constant>)` for the whole run — this is the
     single-owner lock the plan requires, and it is one line rather than a
     deployment procedure;
   - applies each unapplied migration **in its own transaction**, recording the
     id in the same transaction;
   - refuses to start when the database contains an applied id that is not in
     `MIGRATIONS` (the older-binary-meets-newer-database case, the PostgreSQL
     analogue of `index.ts:1037-1041`);
   - releases the lock in a `finally`.

3. `src/migrations.test.ts`, using `startPostgresCluster`:
   - **from empty** → every migration applies, `platform_migrations` has one row
     per id;
   - **idempotent** → running twice applies nothing the second time;
   - **ordered** → ids are applied in array order (assert `applied_at` ordering
     and insertion order, not just set membership);
   - **unknown applied id** → insert `'9999_from_the_future'`, run, expect the
     typed refusal error;
   - **concurrent** → run two migration runners simultaneously against one
     cluster; exactly one applies, the other waits and then finds nothing to do.
     This is the test that proves the advisory lock works, and it is the reason
     the lock exists.

**Verify**: `bun test packages/postgres-store/src/migrations.test.ts` → all pass.

### Step 4: Prove the ORM cannot smuggle a bad row into a public type

This is the plan's contract rule, and it needs a failing-first test rather than
a paragraph.

1. Add a `status` column typed as plain `text` in the migration — deliberately
   *not* a PostgreSQL enum, so the database can hold a value the domain rejects.
2. `src/reader.ts` exposes a repository function returning a **validated** domain
   type, not the inferred Drizzle row.
3. `src/contract-boundary.test.ts`:
   - insert `status = 'not-a-real-status'` with raw SQL;
   - call the reader;
   - assert it fails with a typed validation error naming the column;
   - assert the invalid value never appears in a returned object.

If this test passes trivially, the reader is returning the Drizzle row and the
boundary does not exist. It must fail before the validation is added.

**Verify**: `bun test packages/postgres-store/src/contract-boundary.test.ts`
→ passes, and passes for the right reason (confirm by temporarily removing the
validation and watching it fail).

### Step 5: Create `apps/server`

1. `apps/server/package.json` modelled on `apps/usage-engine/package.json`:

   ```json
   {
     "name": "@ai-usage/server",
     "exports": { "./main": "./src/main.ts" },
     "dependencies": {
       "@ai-usage/effect-runtime": "workspace:*",
       "@ai-usage/postgres-store": "workspace:*",
       "effect": "^3.21.4"
     },
     "scripts": {
       "dev": "bun --no-env-file src/dev.ts",
       "start": "bun --no-env-file src/main.ts serve",
       "build": "tsc --noEmit",
       "check": "tsc --noEmit",
       "test": "bun test",
       "lint": "biome check .",
       "format": "biome format --write ."
     }
   }
   ```

   `--no-env-file` matches the engine and is deliberate: configuration is
   explicit, not ambient.

2. `src/config.ts` — typed parsing with typed failures, per the repo's
   Effect conventions. Required: `AI_USAGE_PLATFORM_DATABASE_URL`,
   `AI_USAGE_PLATFORM_PORT`, `AI_USAGE_PLATFORM_HOST`,
   `AI_USAGE_PLATFORM_MIGRATION_MODE` (`apply` | `verify`).
   - A missing variable produces a typed error naming it. No defaults for the
     database URL — a silent default here is how a test run writes to a real
     database.
   - Add a `config.test.ts` asserting the parsed value **and** that
     `String(error)` / the wide event payload contain no password. Take the
     assertion seriously: it is easy to interpolate a URL into an error message.

3. `src/main.ts` — one composition root. It is the only file that constructs a
   write-capable pool. Mirror the engine's shape (`apps/usage-engine/src/main.ts`).

4. Health endpoints:
   - `GET /health/live` → `200` whenever the process serves, no dependency
     checks, no body detail;
   - `GET /health/ready` → `200 {"status":"ready"}` only when config parsed,
     the pool connects, and applied migrations match `MIGRATIONS`; otherwise
     `503 {"status":"not-ready"}` with **no** reason string.
   - The reason goes to a wide event, never the response body. Readiness is
     reachable unauthenticated by a load balancer, so it is an information
     disclosure surface.

5. `src/health.test.ts`:
   - ready with a migrated cluster;
   - **not** ready when a migration is missing (start a cluster, skip the runner);
   - **not** ready when the pool is down (stop the cluster while serving);
   - the 503 body contains no hostname, SQL, credential, or exception text —
     assert against a explicit deny-list of substrings from the config.

6. Register `apps/server/tsconfig.json` in
   `tools/check-typescript-coverage.ts:4` (alphabetically first, before
   `apps/cli`), and add the boundary policy — an **allowlist**, copying
   `tools/check-package-boundaries.ts:153-162`:

   ```ts
   const serverAllowedWorkspaceDependencies = new Set([
     '@ai-usage/effect-runtime',
     '@ai-usage/postgres-store',
   ]);
   ```
   plus a `boundaryPolicies` entry forbidding
   `@ai-usage/usage-store`, `@ai-usage/local-collectors`, `@ai-usage/cli`,
   `@ai-usage/web`, and `@ai-usage/usage-engine*`, with the reason
   "the platform server must never reach machine-local harness files or the
   local usage store."

7. `turbo.json` — add `@ai-usage/server#dev` and `@ai-usage/server#start` with
   `"cache": false`, `"persistent": true` for dev, and an explicit
   `passThroughEnv` listing the four `AI_USAGE_PLATFORM_*` variables plus
   `PATH`, `HOME`, `NODE_ENV`, `CI`, `TMPDIR`, `TZ`. Turbo strips anything
   unlisted (see `:82-141`), and the symptom is a config error that looks like a
   parsing bug.

**Verify**: `bun test apps/server` → all pass. `bun run typecheck` → exit 0.

### Step 6: The local-mode gate — run it before declaring anything done

This is the plan's real acceptance test, and it is easy to pass accidentally by
having a cluster running.

1. Ensure **no** PostgreSQL is running: `! pgrep -x postgres` → exit 0.
2. `bun run test:packages` → all pass.
3. `bun run dev` → engine and web start; open the report; confirm data renders.
4. `bun run demo` → the synthetic runtime starts (ADR 0003 keeps it isolated).
5. `bun run build && bun run start` → production start works.

Then prove it holds in CI. Add a step to the existing **Unit, Build, Client
Boundary** job (`.github/workflows/pr-checks.yml:76-91`) that runs
`bun run test:packages` with no database service attached, and add a **separate**
job for the PostgreSQL suites:

```yaml
  platform-store:
    name: Platform Store
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cachix/install-nix-action@v31
      - run: nix develop --command bun install --frozen-lockfile
      - run: nix develop --command initdb --version
      - run: nix develop --command bun test packages/postgres-store apps/server tools/pg-harness.test.ts
```

The version assertion must report PostgreSQL 17.x, matching `postgresql_17` in
`flake.nix`. CI must not fall back to an ambient `ubuntu-latest` PostgreSQL; the
same flake and harness own both development and CI paths.

Keeping these in separate jobs is what makes "local mode still works" a
continuously enforced claim instead of a sentence in a document.

Note `.github/workflows/pr-checks.yml:5-9` ignores `plans/**` and `docs/**` for
`pull_request` — plan-only commits do not run CI, which is why plan 100 needed
no CI change and this one does.

**Verify**: push nothing; run the job's commands locally in order.

### Step 7: Document the operational layer

1. `packages/postgres-store/README.md` — the writer/reader split, the migration
   contract, the advisory lock, how to run the harness, and the explicit
   statement that this package never touches the local SQLite store.
2. `apps/server/README.md` — configuration variables, health semantics, what the
   composition root owns, and the statement that it has no filesystem access to
   harness history.
3. `docs/architecture.md` — a `### apps/server` block under `## Package
   ownership` (`:159`) and a `### @ai-usage/postgres-store` block; extend
   `### SQLite backup and recovery` (`:139`) with a sibling
   `### PostgreSQL backup and recovery` covering `pg_dump`, PITR expectations,
   and restore-then-verify-migrations ordering.
4. `docs/public-package-interfaces.md` — document the five new subpath exports.
5. `docs/architecture.md:467` Guardrails — one line: the platform server and the
   usage engine never open each other's database.

**Verify**: `bun run check` → exit 0.

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
