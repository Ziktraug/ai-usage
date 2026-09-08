# ADR 0038: Local Memory store writer lease and startup coupling

- **Status**: Accepted
- **Date**: 2026-09-07

## Context

ADR 0009 gives `apps/usage-engine` the only write-capable connection to the
usage SQLite database and keys its writer lock to the canonical usage database
path, not to the state directory. ADR 0024 and plan 099 make the dedicated
`memory.sqlite` store a separate authority that the same engine process
composes by default, and plan 099 names "a second process writes either local
SQLite store without a documented lifecycle and ownership decision" as a STOP
condition.

The integrated runtime places `memory.sqlite` inside the engine state
directory. Two engines started with different `AI_USAGE_DATABASE_PATH` values
but one `AI_USAGE_ENGINE_STATE_DIR` (a real configuration when a newer store
schema is tested beside the default one) would each hold their own usage lock
and both open `memory.sqlite` read-write. The usage lock therefore does not
prove Memory ownership.

Separately, the engine currently treats any Memory bootstrap failure (a newer
`memory.sqlite` schema, a rendezvous that cannot be published, a replication
composition error) as an engine startup failure and releases the usage writer.
ADR 0024 asks that availability be named per database, so this coupling needs
an explicit decision rather than an implicit one.

## Decision

1. **Dedicated writer lease.** After the usage writer lease is established and
   before `memory.sqlite` is opened, the engine acquires a second writer lease
   with the same lock mechanism, keyed to the Memory database path
   (`<state directory>/memory.sqlite.engine.lock`, the same suffix as the usage lock). Contention is
   `UsageEngineWriterLockContendedError` and reports as
   `writer-lock-contended`, exactly like the usage lock. The lease is released
   after the Memory kernel closes and before the usage writer is released.
   Ownership of `memory.sqlite` is therefore proven by its own lock file, not
   inherited from the usage database path or from the state directory.

2. **Fail closed at startup, by design.** Memory bootstrap failure remains a
   startup failure of the whole engine. The engine does not start a usage-only
   degraded mode, because a silently absent Memory service would present to
   Web, CLI, and MCP as "no local service" rather than as the typed cause, and
   because the supervisor already surfaces a closed
   `startupFailureKind` vocabulary. Separate availability in the sense of
   ADR 0024 applies to the three durable authorities (usage SQLite, Memory
   SQLite, PostgreSQL): a PostgreSQL or replication outage never degrades local
   readiness, but the two local stores share one process lifetime.

3. A separate Memory process still requires the new lifecycle decision that
   ADR 0024 describes; this ADR does not introduce one.

## Consequences

- `apps/usage-engine` tests prove lease ordering (usage lease, Memory lease,
  kernel open; kernel close, Memory lease release, usage release) and that a
  second engine keyed to the same `memory.sqlite` contends.
- `bun run check` / `bun run dev` behavior is unchanged for one engine; a
  second engine sharing a state directory now fails visibly instead of
  corrupting Memory. While the first engine serves, the earlier orphan-
  rendezvous check already refuses the second one as `startup-failure`; the
  Memory lease is what refuses it, as `writer-lock-contended`, when only that
  lease is held (for example between a crash and the next recovery).
- Reopening the degraded-mode question is a new ADR, not a code-only change.
