# ADR 0089: Collector-declared usage row retirement

- **Status**: Accepted
- **Date**: 2026-11-10
- **Extends**: 0009 (sole-writer usage engine), 0016 (collect everything), 0075 (preservation)

## Context

Some sessions already stored as usage rows must stop counting: a session a
harness imports from another tool (Codex desktop importing Claude sessions), or
a session counted twice under two harnesses. `usage_rows.status` has always
allowed `deleted`, and the import classifier already knows the kind, but no
collector produced retired rows: once a local collector emitted a row, it
stayed `active` forever.

The obvious shortcut, retiring any row the collector no longer emits, is
unsafe. Local sources prune their own history (Claude deletes transcripts after
a retention window, Codex compresses rollouts, OpenCode moves between schemas),
and a collector that cannot read a file in one pass sees the same absence as a
genuine reclassification. The store is the operator's durable record; a source
forgetting a session must never erase it.

## Decision

Retirement is explicit and collector-declared. Each `collect<Harness>Result`
returns `retiredSourceSessionIds`: the source session ids the collector
positively observed in this pass and deliberately classifies as "not a usage
row of this harness". An id that is merely absent, unreadable or filtered for a
transient reason is never listed.

The engine's session source imports the emitted rows, then calls
`retireLocalRows` for the declared ids. In one IMMEDIATE transaction the store
marks `deleted` every active, local-observed row of that origin machine and
harness whose `source_session_id` is listed, rewriting the stored JSON and
content hash so every report read still validates the row. Portable rows,
other machines, other harnesses and superseded rows are never touched. The
write is idempotent and advances the report and fleet generations only when a
row changed. A session the collector later emits again as a normal row is
reactivated by the ordinary import (its status differs, so it classifies as
`updated`).

A collector that both emits and retires one id in the same pass is defective.
The emitted row wins, because it was observed as usage, and the conflict is
reported as a `rowRetirement.emittedAndRetired` source warning rather than
dropped.

No schema change: the `deleted` status, the classifier and the active-only
report reads already existed.

## Consequences

- Reports stop counting retired sessions on the next publication; the rows
  remain in the store as tombstones readable with `statuses: ['deleted']`.
- Collectors own the classification and must unit-test what they declare;
  the store and the engine own only the mechanics.
- Absence remains a gap (ADR 0017): source pruning changes nothing in the
  store, and a row no collector emits any more stays active until a collector
  positively retires it or the operator does.

## Rejected alternative

Absence-based retirement, where the store retires every active local row of a
harness that the pass did not emit. It would turn every retention purge,
unreadable file and transient parse failure into data loss, and it cannot
distinguish "reclassified" from "forgotten".

## Evidence

- [Store write and reactivation](../../packages/usage-store/src/index.ts) (`retireLocalRows`, `classifyMergeRows`)
- [Engine session source](../../packages/usage-engine-runtime/src/source-adapters.ts) (`createSessionSource`)
- [Collector contract](../../packages/local-collectors/src/collectors/index.ts) (`HarnessAdapterCollection.retiredSourceSessionIds`)
- [Store regression](../../packages/usage-store/src/index.test.ts) ("targeted row retirement")
- [Engine regression](../../packages/usage-engine-runtime/src/source-adapters.test.ts) ("collector-declared row retirement")
