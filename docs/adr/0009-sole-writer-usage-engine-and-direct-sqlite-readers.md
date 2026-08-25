# ADR 0009: Sole-writer usage engine and direct SQLite readers

- **Status**: Accepted
- **Date**: 2026-07-31
- **Amends**: host/artifact clauses only in ADR 0001, ADR 0002, ADR 0007,
  ADR 0008, and [ADR 0014](0014-effect-runtime-package-for-wide-events.md)
  (formerly the second record numbered 0002)

## Context

Collection, scheduling, source/config mutation, and revision publication were
previously composed by Web or CLI workflows. Served reads depended on copied
per-revision SQLite files, temporary Session leases, and per-query Bun
subprocesses. That made process ownership ambiguous, created avoidable I/O, and
let Web HMR/build lifecycle affect background work. Development and production
Nitro outputs also shared cleanup assumptions.

The product is local and Bun-based. It needs exact-revision consistency and a
single durable store, but it does not need a report data service or a remote
protocol.

## Decision

`apps/usage-engine` is the only production composition root that may open the
usage SQLite database read-write. A lock keyed to the canonical database path
precedes writer open and prevents two engines even when their state directories
differ. The engine owns migrations, checkpoints, collection, enrichment,
scheduling, source state/policy, usage-domain config and transfer mutations,
atomic publication, recovery, retention, and shutdown.

Complete immutable projection content is stored under revision keys in the
durable SQLite database. Publication validates the projection before atomically
advancing current. Web and CLI open only existing compatible databases through
read-only, `query_only` connections and execute bounded current/exact-revision
queries directly. There are no copied revision databases, leases, or per-query
subprocesses.

Authenticated numeric-loopback HTTP is the operational plane. It carries
command admission, status, and bounded sanitized SSE events/completions only.
It never carries report rows, focused/Session results, quota history, database
bytes, or arbitrary Web paths. Bounded Web uploads are staged in a private
inbox and cross as opaque IDs; the engine revalidates before consumption.

Web sends usage-domain mutations through the control client and continues
compatible stored reads when the engine is down. Its unrelated Skills
filesystem control plane remains web-owned and field-scoped. CLI uses a
compatible daemon when present; otherwise a command requiring fresh/mutating
work launches one bounded `once <command-request-json>` process using the same
runtime and lock. A live protocol/target mismatch fails closed and never starts
a competing writer. Pure portable and stored reads require no engine.

Root development and production commands supervise engine and Web explicitly.
Nitro/Vite development and production outputs are separate, and a narrow build
lock prevents concurrent production builders without deleting active dev
output.

The supported file-level backup path is a clean engine stop followed by a
database copy. Web/CLI do not migrate, checkpoint, repair, retain, or back up
through a write-capable connection. Missing/incompatible stores, unavailable or
expired revisions, engine unavailability, and protocol mismatch remain typed
and visible.

## Preserved decisions

- The bounded source worker pool, default concurrency, queue/backpressure,
  cadence, cancellation, dependency, and publication-generation semantics do
  not change.
- Immutable exact-revision destination consistency, browser supersession,
  atomic commit, and one expiry retry do not change.
- SSR still embeds the bounded support bootstrap and continues destination
  queries after hydration against the same revision.
- Local-observed versus portable-opaque authority, prompt/path privacy, manual
  file transfer, confirmation tokens, and provider-resolution restrictions do
  not change.
- Schema-v2 wide-event isolation, sanitization, presentation, delivery, and
  source-to-publication generation correlation do not change. Source,
  enrichment, publication, migration, retention, and engine-command events use
  surface `engine`; Web keeps HTTP/SSR/direct-read events and CLI keeps
  command/render events.

## Consequences

- Process and storage ownership are mechanically enforceable: one writer app,
  one write-side runtime, and read-only Web/CLI dependency closures.
- Engine failure can disable fresh/usage-domain mutations without discarding a
  compatible last publication. Skills remains independently available.
- Readers and writers share a schema/version contract. Durable append-only
  projection space, retention, query plans, WAL behavior, and byte budgets must
  stay measured.
- Local control stays small and private, but a future remote/multi-user/non-Bun
  reader would require a new architecture decision and likely a real data
  service.

## Rejected alternatives

- A report REST/GraphQL/tRPC endpoint was rejected because local Bun readers can
  safely query the durable data plane and a data API would expand auth, privacy,
  versioning, and failure scope.
- Dual writes or a compatibility scheduler were rejected because they make
  writer authority ambiguous and intermediate states unreleasable.
- Per-revision database copies, temporary leases, and per-query Bun children
  were rejected because revision-keyed durable projections provide the same
  exactness with bounded direct reads and less I/O/process churn.
- Separate stores per process/revision were rejected because they introduce
  replication/consistency work without a product requirement.
