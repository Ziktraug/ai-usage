# Local store upgrade

This is the operator procedure for moving the two local SQLite stores across
code versions. It applies to every checkout that runs the real stores, not to
the demo runtime or to PostgreSQL (see
[`platform-server-operations.md`](platform-server-operations.md) for the
connected database).

The two stores and their owners (ADR 0009, ADR 0024, ADR 0038):

| Store | Location | Writer | Lock file |
| --- | --- | --- | --- |
| usage store | `AI_USAGE_DATABASE_PATH` (default `~/.config/ai-usage/usage-store.sqlite`) | `apps/usage-engine` only | `<database>.engine.lock` |
| Memory store | `<AI_USAGE_ENGINE_STATE_DIR>/memory.sqlite` (default `~/.config/ai-usage/engine/`) | `apps/usage-engine` only | `<state directory>/memory.sqlite.engine.lock` |

Both use WAL. Web, CLI, and MCP open the usage store read-only or go through
the engine's loopback services; they never migrate a store. The engine also
publishes two rendezvous files in the state directory while it runs:
`rendezvous.json` (control plane) and `memory-service.json` (Memory service).

Schema versions are the SQLite `user_version` pragma:

| Store | Before PR #53 (`main` at `b2411c21`) | After PR #53 | What the step adds |
| --- | ---: | ---: | --- |
| usage store | 3 | 4 | `replication_outbox_state` and `replication_outbox_events` (empty in local-only mode) |
| Memory store | absent | 6 | the store itself; #53-era stores at 5 are brought to 6 by an index rebuild only (`repositories_provider_identity_unique` becomes Space-scoped), no row change |

Migrations are forward-only and run inside one transaction per store, so an
interrupted upgrade leaves the previous version in place. Code refuses a store
that is newer than it supports: the usage store fails with
`Usage store schema <n> is newer than supported schema <m>`
(`packages/usage-store/src/index.ts`), and a newer `memory.sqlite` raises
`MemoryIdentityStoreError('migration-incompatible')`, which is an engine
startup failure with no usage-only degraded mode (ADR 0038). An older binary
therefore cannot reopen a migrated store; rollback means restoring the
backup together with the code that wrote it.

PR #53 also raised the engine control-plane protocol from 2 to 3. A Web or
CLI process from the previous revision fails closed against the new engine,
so the whole supervised stack restarts together.

## Backup

1. Stop the supervised stack (`bun run start` or `bun run dev`) with SIGTERM
   and wait until both `.engine.lock` files and both rendezvous files are
   gone. `bun --no-env-file apps/usage-engine/src/main.ts check` must report
   the lock and rendezvous as `absent` and the store as `compatible`.
2. Copy each store with `VACUUM INTO` (from the `sqlite3` shell or any SQLite
   client, for example `bun:sqlite`): `VACUUM INTO '<backup>/usage-store.sqlite'`
   on the usage store and `VACUUM INTO '<backup>/memory.sqlite'` on the Memory
   store. Never copy a live database file or its `-wal`/`-shm` siblings by
   hand, and never back up one store without the other. Keep the copies
   owner-only (`0600`).
3. Record, next to the copies, the code revision that last wrote the stores
   (`git rev-parse HEAD`) and both `PRAGMA user_version` values. The backup
   and that revision are one pair.

## Update

- Check out the target revision and run `bun install --frozen-lockfile`
  (`bun run build` for a production start).
- To test a branch without touching the real stores, point the engine at
  copies: `AI_USAGE_DATABASE_PATH=<copy>` plus a distinct, `0700`, owned
  `AI_USAGE_ENGINE_STATE_DIR`, and a distinct `AI_USAGE_HOME` if the harness
  caches must stay separate too. Two engines sharing one state directory are
  refused by design (ADR 0038).

## Start / migrate

The engine is the only migrator. On start it acquires the usage writer lease,
migrates the usage store, acquires the Memory writer lease, then opens or
creates `memory.sqlite` (first open creates exactly one local Person, personal
Space, and Device; a later open keeps those identities). A Memory bootstrap
failure stops the engine and releases both leases; that is the designed
outcome, not a partial start. Start Web and CLI from the same revision after
the engine is up.

## Verify

- The engine's stderr carries no `usage-engine startupFailureKind=…` line; both
  lock files and both rendezvous files exist while it runs; the `check`
  command reports `ok: true`.
- `PRAGMA user_version` reads 4 (usage) and 6 (Memory); `PRAGMA
  integrity_check` returns `ok` on both.
- `usage_rows` count and the single `spaces` / `people` / `devices` rows match
  the pre-upgrade figures; the report Overview renders the same totals;
  `/memory` and `/projects` render.
- `bun run cli replication status` prints `Replication: local-only` when
  `AI_USAGE_PLATFORM_BASE_URL` is unset.

## Recover

- `startupFailureKind=writer-lock-contended`: another engine is alive on one of
  the stores. Stop it; do not delete a lock whose PID is alive.
- `startupFailureKind=startup-failure` with `check` reporting the store as
  `unavailable`: a schema or store problem. Stop and restore; do not edit the
  databases.
- Restore: stop the engine, put both store files back from the backup pair,
  remove any `-wal`/`-shm` siblings left beside the restored files, check out
  the recorded code revision, then start.
- An older binary that was pointed at a migrated usage store refuses it but can
  leave a dead `<database>.engine.lock` behind; the next compatible start
  recovers that lease automatically.

Never edit `user_version` by hand, never run an older revision against a
migrated store, never restore one store without the other, and never delete
`memory.sqlite`: its identities bind the replication outboxes, and recreating
it restarts the Memory stream at generation 1 for the same enrolled Device.

## Limits

- Forward-only: there is no downgrade migration for either store.
- One process lifetime for both stores: the engine has no usage-only mode when
  Memory cannot open (ADR 0038).
- The procedure covers the two local stores only. PostgreSQL has its own
  backup/restore order and migration ledger; the harness caches beside the
  usage store (`*-cache.json`, `codex-session-cache.sqlite`, `machine.json`) are
  not part of either store and are untouched by PR #53.
- Local-only mode never contacts PostgreSQL, a server, or an account
  (`bun run test:local-platform` proves it); the outbox tables stay empty.
- Proof of the paths above lives in `packages/memory-sqlite/src/migration.test.ts`,
  `packages/usage-store/src/migration.test.ts`, and
  `apps/usage-engine/src/process-child-stores.test.ts`.
