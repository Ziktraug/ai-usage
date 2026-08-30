# Platform server and PostgreSQL operations

> **Implementation status:** Accepted target specification. The runtime,
> packages, commands, routes, and verification evidence below are pending
> integration and are not available on `main`; plans 101–104 remain
> `IN PROGRESS` in `plans/README.md`.

This runbook is the accepted operational specification for the connected
platform foundation. It covers the target PostgreSQL lifecycle, migration
ledger, server health, and backup/restore behavior of plan 101. Plan 102 adds the
identity migration to that same ledger; its model and adapter behavior live in
[identity kernel and Project resolution](identity-kernel.md). Plan 103 adds the
organization authorization schema, transaction-local Space RLS, audit writes,
and authorized Project query described in [authorization](authorization.md).
Plan 104 adds GitHub-only authentication, Web sessions, and Device enrollment
described in [authentication and Device enrollment](authentication-and-device-enrollment.md).
Agent Memory and search are specified in their dedicated references. Device
replication is documented in [Device replication](device-replication.md);
WorkHandoff and session-archive extensions remain dependent-plan work.

## Authority boundary

`apps/server` is the only connected application composition root and the only
owner of a shared write-capable PostgreSQL pool. `@ai-usage/postgres-store`
owns the schema declarations, ordinal migration registry, migration runner,
validated readers, pool adapter, and test-only fixtures. It owns no HTTP,
local-machine reader, SQLite adapter, or repository harness filesystem access.

PostgreSQL does **not** replace the local usage SQLite authority or the separate
local `memory.sqlite` identity/Memory authority. Local Usage remains available
now. The accepted identity kernel and review service must preserve that
independence when integrated: CLI reads, the Web demo/build, and the usage
engine must start without an account, platform configuration, or PostgreSQL
connection attempt.

## Version and repository-owned lifecycle

The development shell pins PostgreSQL 17 through `flake.lock` and includes the
matching `initdb`, `pg_ctl`, `postgres`, and `psql` binaries. Enter it with:

```sh
nix develop
```

`tools/pg-harness.ts` creates one private disposable cluster per run under a
new temporary root. It disables TCP, listens only on a mode-0700 Unix socket,
uses trust authentication and durability shortcuts only for that disposable
cluster, and removes the entire root through an idempotent `stop()` operation.
Two-cluster isolation and cleanup are part of `bun run test:postgres`.

For an interactive connected development server, first supply the GitHub OAuth
client and stable development key rings, then run:

```sh
nix develop --command bun run dev:platform
```

That command owns both the disposable cluster and `apps/server`, forwards
termination, fixes its callback origin to `http://127.0.0.1:4318`, and removes
the cluster after the server exits. It is not a production database launcher.
The required authentication variables are not synthesized; an invalid GitHub
client can start neither a supported connected login nor first-owner bootstrap.
`bun run dev` remains the PostgreSQL-free local Usage/Web composition.

## Configuration

`apps/server` parses configuration before exposing readiness. Values are
typed; invalid values produce fixed error codes without echoing the value,
database URL, credentials, hostname, SQL, or driver exception.

| Variable | Default | Contract |
| --- | --- | --- |
| `AI_USAGE_AUTH_SECRETS` | none | Required ordered `version:base64urlSecret[,old...]` ring; each decoded secret is 32–128 bytes and is redacted after parsing. |
| `AI_USAGE_DEVICE_TOKEN_KEYS` | none | Required ordered `version:base64urlKey[,old...]` ring; first version creates new HMAC verifiers, retained versions verify existing credentials/grants. |
| `AI_USAGE_GITHUB_CLIENT_ID` | none | Required non-empty GitHub OAuth application client ID. |
| `AI_USAGE_GITHUB_CLIENT_SECRET` | none | Required redacted GitHub OAuth client secret. |
| `AI_USAGE_PLATFORM_BASE_URL` | none | Required external origin only; production requires HTTPS and no path/query/credentials. |
| `AI_USAGE_FIRST_OWNER_BOOTSTRAP` | `false` | Explicit boolean policy; effective only for the first successful GitHub identity while zero People and no permanent marker exist. |
| `AI_USAGE_PLATFORM_DATABASE_URL` | none | Required `postgres:` or `postgresql:` URL; represented as `[REDACTED]` after parsing. |
| `AI_USAGE_PLATFORM_DATABASE_TLS` | `disable` outside production; `require` in production | `production` rejects `disable`; `require` validates the server certificate. |
| `AI_USAGE_PLATFORM_MIGRATION_MODE` | `apply` outside production; `verify` in production | `apply` installs compiled pending migrations; `verify` refuses any pending migration. |
| `AI_USAGE_PLATFORM_POOL_SIZE` | `10` | Integer from 1 through 100. |
| `AI_USAGE_PLATFORM_CONNECT_TIMEOUT_MS` | `5000` | Integer from 100 through 120000. |
| `AI_USAGE_PLATFORM_QUERY_TIMEOUT_MS` | `5000` | Integer from 100 through 120000. |
| `AI_USAGE_PLATFORM_SHUTDOWN_TIMEOUT_MS` | `10000` | Bound for request drain, forced listener stop, and pool closure. |
| `AI_USAGE_PLATFORM_HOST` | `127.0.0.1` | Non-empty bind host; never included in public diagnostics. |
| `AI_USAGE_PLATFORM_PORT` | `4318` | Port 1–65535; port 0 is accepted only by the test runtime. |
| `NODE_ENV` | `development` | `development`, `test`, or `production`. |

Production secret delivery belongs to the process environment or a secret
manager. Do not place a credential-bearing URL in checked-in files, command
arguments, issue text, or health checks.

The server emits only the active Device token key **version**, never its value,
as `device-token-key-version-active` at successful startup. Retain those
diagnostics as the deployment-key rotation audit trail. Follow the key-ring
procedure in the authentication reference before removing an old version.

## Deterministic migrations

`platform_migrations` is the independent PostgreSQL ledger. Every compiled
migration has an explicit stable ID and positive unique ordinal. Runtime order
comes only from that ordinal—never filename, timestamp, `applied_at`, directory
order, or row insertion order.

One reserved pool client acquires the fixed PostgreSQL advisory lock before it
creates/reads the ledger. The runner then:

1. validates the compiled IDs and strictly increasing unique ordinals;
2. validates that applied rows are an exact prefix of the compiled sequence;
3. refuses unknown IDs, future ordinals, gaps, and ID/ordinal disagreements;
4. applies each pending migration in its own transaction and records the ledger
   row in that same transaction;
5. releases the advisory lock in every success or failure path.

Readiness remains false until migration compatibility, connectivity, and the
schema metadata probe all pass. `verify` mode creates no pending business
schema; on a fresh database it may create only the migration ledger needed to
prove that a migration is pending.

Plan 101's ordinal-1 foundation migration contains exactly:

- `platform_migrations`;
- `platform_schema_metadata`.

Plan 102's ordinal-2 migration adds the identity-kernel tables documented in
[identity kernel and Project resolution](identity-kernel.md). Plan 103's
ordinal-3 migration adds concrete organization membership/Team/resource grant
tables, dedicated Session/Memory/Work authorization scopes, content-free audit
events, their indexes, and forced RLS policies. It does not add a generic
authorization tuple table, login identity, Agent Memory content, replication,
server-instance, or test-status table. The invalid stored-domain-value test uses
`platform_contract_fixture`, a table created only by the test adapter and never
by a production migration. No PostgreSQL extension is required yet; `pg_trgm`
and any later extension are provisioned only by the first plan that exercises
them.

Plan 104's ordinal-4 migration adds Better Auth principal/provider/state rows,
domain Authentication identities, digest-only Web sessions, the permanent
first-owner marker, 15-minute enrollment grants, and versioned Device
credential verifiers. The earlier ordinal-2 SCM account, installation, and
credential tables remain separate and retain their required Person/Space/XOR
ownership constraints. No plaintext Web session, enrollment grant, Device
credential, deployment key, or unencrypted provider token belongs in these
tables.

Ordinal 8 adds per-Device/stream replication state, immutable batch and event
receipts, and current fact-key projections. Receipt triggers reject updates and
deletes. Forced Space RLS applies to stream, receipt, and projection rows. An
ACK is stored only in the same transaction as receipts, projection changes, and
generation advancement.

## Authorization role and RLS context

The application database role must be a non-superuser without `BYPASSRLS`.
Authorization operations reserve one pool client, begin a transaction, set and
verify `ai_usage.active_space_id` with transaction-local `set_config`, and end
the transaction before returning the client. Never replace this with a
session-level `SET`; pooled context could cross requests.

Missing context returns no rows from ordinal-3 authorization tables. A row
whose `space_id` differs from the active context is rejected by `WITH CHECK`.
Fine-grained permissions still come from the application Authorizer queries;
RLS is defense in depth only.

The pending migration verifier executes `CREATE TABLE IF NOT EXISTS` for the
ledger after taking its advisory lock. A combined runtime/migration role needs
`USAGE, CREATE` on its schema plus only the table privileges exercised by the
application. A deployment may instead perform compatibility checking with a
separate migration role before starting the restricted runtime role. Never use
superuser or `BYPASSRLS` to avoid explicit grants.

## Health, application routes, and lifecycle

Foundation health routes are:

- `GET /health/live` — `200 {"status":"live"}` when the event loop is serving;
- `GET /health/ready` — `200 {"status":"ready"}` only when startup completed
  and a fresh pool/schema probe passes, otherwise the bounded generic
  `503 {"status":"not-ready"}`.

Unknown paths return a bounded 404 and non-GET health requests return 405.
Responses never contain the database URL, hostname, credentials, SQL,
migration ID, exception text, or private readiness reason.

After readiness, the server also exposes the application-owned auth/session and
Device routes listed in the [authentication HTTP surface](authentication-and-device-enrollment.md#http-surface-and-audit).
Batched Device publication is the separate bounded
`POST /api/replication/batches` surface described in the replication reference.
Bodies are bounded to 16 KiB, responses are `no-store`, cookie mutations
require exact Origin, and error bodies contain fixed codes. OAuth/provider,
session, enrollment, and Device secrets never enter health or domain-list
responses.

Shutdown stops HTTP admission and drains requests within the configured bound.
If graceful drain fails or times out, the process requests a forced listener
stop, then closes the pool within the same explicit bound. Signals are owned by
`apps/server`; the connected-development launcher additionally owns and reaps
its server child and disposable PostgreSQL cluster.

## Backup and restore order

Use PostgreSQL-native logical or physical backup tooling appropriate to the
deployment. The minimal foundation is compatible with a custom-format logical
backup. Configure libpq credentials through an owner-only service/pass file so
the database URL is not written into shell history:

```sh
pg_dump --format=custom --no-owner --no-acl --dbname="service=$PGSERVICE" --file=platform.dump
```

Before backup, confirm `/health/ready` is 200 and record the deployed
application revision. Do not copy individual table files, edit the migration
ledger, or back up metadata and ledger independently.

Restore in this order:

1. stop every `apps/server` process that targets the database;
2. create a new empty PostgreSQL 17 database with the intended owner;
3. restore the complete dump with `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`;
4. start the recorded compatible application revision in `verify` mode;
5. require `/health/ready` to return 200 before routing traffic;
6. take a fresh backup, then run a newer revision in `apply` mode only as a
   deliberate forward migration; return production to `verify` afterward.

Migrations are forward-only. If compatibility or readiness fails, preserve the
restored database and use the recorded application/database backup pair; never
delete or renumber ledger rows to force readiness.

## Verification and CI

Run the PostgreSQL suite through the flake so local and CI binaries match:

```sh
nix develop --command bun run test:postgres
nix develop --command bash -lc 'bun run benchmark:authorization'
```

The PR workflow has a separate PostgreSQL 17 job that installs Nix and executes
that command through the repository flake. A distinct local-mode job runs
`bun run test:local-platform`: it removes every platform/authentication value,
injects factories that record and fail on any PostgreSQL or
shared-authentication consultation, and runs a local package, usage-engine, CLI
read, Web demo preparation, and Web production build. All commands must pass
with exact PostgreSQL and authentication factory call counts of zero; no
process or port inspection participates in that proof.

The authorization benchmark seeds 50 Spaces × 200 Projects × 20 People with a
three-level Team relation and evaluates the p95 150 ms OpenFGA trigger. Its
dated measurements and interpretation live in [authorization](authorization.md#measured-postgresql-baseline).
