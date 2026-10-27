# ADR 0075: Local store schema evolution: forward-only, additive where possible, widen-only reads

- **Status**: Accepted; amended 2026-10-25 (nullable columns); rule 4 applied
  2026-10-27 by [ADR 0084](0084-retire-memory-checkout-resolution-and-replication.md) (Memory store no
  longer opened; usage schema 5 drops the outbox)
- **Date**: 2026-10-24
- **Extends**: [ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
  (the engine is the only migrator)
- **Records**: rules applied case by case in
  [ADR 0022](0022-skill-observation-tiers-and-observability.md),
  [ADR 0042](0042-local-session-distillation.md),
  [ADR 0043](0043-memory-library-and-explicit-local-promotion.md), ADR 0049 and
  ADRs 0050–0054 on `feat/work-resume-cockpit`, and
  [`docs/local-store-upgrade.md`](../local-store-upgrade.md)

## Context

The usage store and the Memory store are the operator's durable record. The
usage store can hold history that a harness has since removed from its own
files, so losing rows is not recoverable by rescanning. Each store's schema is
its SQLite `PRAGMA user_version`: usage 4 (`USAGE_STORE_SCHEMA_VERSION`) and
Memory 8 (`LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION`) today.

The rules for changing them exist only as consequences scattered across other
records. ADR 0022 found that persisted rows are re-validated when read, so a
tighter schema retroactively hides stored history. ADR 0043 made Memory schema
8 additive and forward-only. ADR 0049 on `feat/work-resume-cockpit` retired a
feature without deleting its tables. ADRs 0050–0054 on that branch add usage
tables under `user_version` 4 that are created when absent. Plan 120 phase B
needs the opposite case: dropping the usage store's replication outbox tables
(ADR 0074).

## Decision

1. **Forward-only, engine-owned.** Only `apps/usage-engine` migrates, on open,
   inside one immediate transaction per store, so an interrupted upgrade leaves
   the previous version. A binary refuses a store newer than it supports (usage:
   `Usage store schema <n> is newer than supported schema <m>`; Memory:
   `MemoryIdentityStoreError('migration-incompatible')`). The usage store's
   read-only readers in Web and CLI refuse any version but their own; Web, CLI
   and MCP reach the Memory store only through the engine. There is no
   downgrade migration. Rollback restores the backup pair together with the
   code revision that wrote it.

2. **Additive tables may keep the current version in the usage store.** A
   change that only adds tables and their indexes may keep `user_version`. Its
   migration creates them with `CREATE TABLE IF NOT EXISTS` and detects its
   work by the table's absence, as the skill-observation and quota read
   projection tables do. An older binary at the same version ignores tables it
   does not know, so such a change stays openable in both directions. A one-time
   data rewrite under the same version is recorded by a named `migration.*` key
   in `usage_store_metadata`. A change that alters, rebuilds or drops an
   existing table, or changes the meaning of stored rows, advances
   `user_version`. The Memory store already advances `user_version` for every
   schema change (its migration runs ordered `version < n` steps and returns
   early at the current version); that stricter form also satisfies this rule.

   *Amendment 2026-10-25 (plan 123):* adding a nullable column with no
   default and no backfill to an existing usage table counts as additive and
   keeps `user_version` when every writer of that table names its columns and
   every reader maps named columns, so an older binary at the same version still
   reads and writes it and leaves the new column null. Its migration detects its
   work by the column's absence (`PRAGMA table_info`). Any other alteration of an
   existing table still advances the version.

3. **Reads only widen.** Persisted facts are re-validated when read: usage rows
   must still parse as serialized merge rows, skill observations through
   `parseSkillObservation`, and a row that fails is counted in `skipped`, never
   silently dropped. A persisted shape, vocabulary or bound may therefore only
   widen. A stricter rule belongs at the presentation edge, which filters one
   row and counts it instead of refusing the response (ADR 0022). Narrowing a
   stored shape needs a versioned migration that rewrites or retires the
   affected rows, never a parser change alone.

4. **Retiring a feature keeps its data.** Retiring a feature removes its
   surfaces and writers and keeps its tables and rows, as ADR 0049 on
   `feat/work-resume-cockpit` did. A retired store is no longer opened, and code
   does not delete its file. Removing a table is an explicit operator decision,
   executed as a versioned forward-only migration after the backup procedure,
   with row counts taken on a copy and disposable-store tests. The operator took
   that decision for the usage store's replication outbox tables (usage schema 5,
   plan 120 phase B, ADR 0074).

5. **Disposable stores prove code, not stores.** Migration tests run on
   disposable stores. Upgrading an operator's real store follows
   [`docs/local-store-upgrade.md`](../local-store-upgrade.md) and needs the
   operator's authorization.

This ADR governs store tables and persisted facts. Served report revisions
carry their own `projection_schema_version`, which the reader checks on every
read (`packages/usage-store/src/served-report-store.ts`).

## Consequences

- Dead tables accumulate until the operator decides to drop them. That is the
  accepted price of never destroying history by accident.
- A bound or vocabulary chosen too wide cannot be tightened cheaply; new
  persisted facts start permissive and validate strictly at the edge.
- Readers and the writer share a version contract, so the supervised stack
  restarts together after a version change.
- Reviews of a store change check four things: the version decision (rule 2),
  read compatibility of existing rows (rule 3), the retirement path (rule 4)
  and the upgrade note in `docs/local-store-upgrade.md`.

## Rejected alternative

Down migrations were rejected. A down migration of a fact store has to discard
whatever the newer version wrote, and it cannot be tested against the real
stores it would run on. A restored backup pair gives the same rollback without
inventing data loss.

## Evidence

- [Usage store migration](../../packages/usage-store/src/index.ts) (`migrate`,
  `USAGE_STORE_SCHEMA_VERSION`) and its
  [tests](../../packages/usage-store/src/migration.test.ts)
- Memory store migration: `packages/memory-sqlite/src/identity.ts`, removed by ADR 0084 (git history keeps it)
  (`bootstrapDatabase`) and its
  tests: `packages/memory-sqlite/src/migration.test.ts`, removed by ADR 0084 (git history keeps it)
- [Skill observation store](../../packages/usage-store/src/skill-observation-store.ts)
  (re-validation on read)
- [Local store upgrade procedure](../local-store-upgrade.md)
