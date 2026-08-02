# @ai-usage/usage-store

## Owns

The durable SQLite schema, normalized usage and dataset persistence, enrichment
contributions, provider-quota observations, transfer mutations, source
checkpoints/attempts, and immutable revision-keyed served projections.

## Does not own

It does not choose or read harness files, schedule collection, authorize app
commands, render output, expose HTTP, or create per-revision database files.

## Public interface

- `./reader`: opens only an existing compatible database read-only with
  `query_only`, finite busy timeout, and typed missing/schema/revision/busy/
  corrupt failures. It never creates, migrates, changes journal mode,
  checkpoints, or writes.
- `./writer`: migrations, imports, enrichment, transfer mutation, publication,
  recovery, retention, and checkpoints. Production composition is restricted
  to usage-engine-runtime.
- `./testing`: mixed temporary-store helpers for tests/E2E only.

There is no mixed root export.

## Data boundary

A publication inserts and validates one complete immutable projection before
atomically advancing the current pointer. Every served query includes the
revision key, so a reader pinned to A cannot observe B. Retention preserves
current, tolerates WAL readers, bounds retained rows/bytes/revisions, and
removes abandoned incomplete work.

Merge preview and confirmation use the same canonical preparation and one
bounded, versioned, opaque, stateless token bound to the document and relevant
logical store state. A first preview may initialize an empty current-schema
private store; preview of an existing store may migrate, but preview never
imports rows or advances semantic generation. Confirmation is atomic and
returns `preview-stale` when its bound state changed. Semantic generation
advances only when the active composed report projection changes.

## Backup and recovery

Do not copy only the main database while its WAL writer may be active. The
supported backup procedure is to stop the usage engine cleanly, then copy the
database. ai-usage exposes no online-backup command. Readers never perform
backup, repair, migration, retention, or checkpoint work.

## Test strategy

Use isolated temporary databases for migrations, publication fault injection,
reader byte-for-byte immutability, WAL concurrency, exact-revision isolation,
retention, corruption, query plans, and 5,000+ Session fixtures.
