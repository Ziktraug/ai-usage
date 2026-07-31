# apps/usage-engine

## Owns

The only production composition root for `UsageEngineRuntime`,
`usage-store/writer`, engine observability, the canonical database writer lock,
private rendezvous/inbox state, authenticated numeric-loopback control, and
process lifecycle.

## Modes

- `bun --filter @ai-usage/usage-engine start`: persistent `serve` mode. Normal
  development/production uses the root supervisors instead.
- `once <command-request-json>`: internal bounded CLI foreground mode using the
  same runtime and lock; it is not a compatibility writer.
- `check`: non-collecting path/lock/rendezvous/schema diagnostics.

## Does not own

It does not render reports or expose report/focused/Session/quota data over
HTTP. Web and CLI read the durable SQLite data plane directly.

## Operations

Use `bun run dev` for supervised development and `bun run start` after a build
for supervised production. Stop the engine cleanly before a file-level SQLite
backup. Treat writer-lock or rendezvous identity failures as fail-closed
diagnostics; never delete suspicious state by hand without validating it.

## Test strategy

Use explicit isolated homes, database/state/log/inbox paths, ports, and fixtures.
Cover serve/once/check, auth/budgets, same-database lock contention, stale
identity, signals, forced cleanup, and private event output.
