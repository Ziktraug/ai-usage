# ADR 0050: Work attention facts stay outside the served revision

- **Status**: Accepted; amended by [ADR 0056](0056-native-records-may-settle-a-derived-wait.md) (a dated native record may settle a derived wait)
- **Date**: 2026-10-21
- **Extends**: 0009, 0016, 0017

## Context

Claude Desktop keeps a registry file per session (`claude-code-sessions/
<account>/<org>/local_<uuid>.json`) with the Session's own last-turn
declaration (`postTurnSummary`: blocked, completed, review ready, and the
action it asked for), the sessions it spawned, the proposals it offered and
the pull requests it declared. Together with the collected Session, this is
what a Work view needs to say what is waiting on a person. The data is
rewritten on every turn, carries free text (a proposal's full prompt among
it), and is wanted on its own cadence, not on the report's. The served
report revision (ADR 0009) is immutable, exported, replicated, and
re-assembled when any of its inputs changes; nothing in the registry belongs
to that contract.

## Decision

The Desktop registry is a fact family of its own, additive to the usage store
and outside the served revision:

- `claude_desktop_sessions` and `claude_desktop_collection_state` are created
  under the current `user_version` when absent (the `skill_observations`
  precedent); one bounded row per desktop session, upserted when the file
  mtime or the normalized content changes. An import never advances the store
  generation and the `claude.desktop-sessions` source never reports a change,
  so no Desktop turn wakes a publication.
- The rows never enter `served_report_rows`, the replication outbox or the
  merge bundle. The Work view reads them directly through `report-data`
  (`queryWorkAttention`) on a collection-SWR policy, and joins the collected
  Session by `(machine, 'claude', cliSessionId)` against the current revision
  only to attach `rowId`, `campaignKey` and the project label; when no
  revision exists the dataset says so in `coverage.sessions`.
- Text is bounded at collection to `WORK_ATTENTION_BOUNDS` and refused above
  them on read; a proposal's `prompt` is never read into memory. A file whose
  required identity is present but whose shape is unknown is kept as a
  `format: 'unsupported'` row, so the coverage gap is visible rather than a
  value invented.
- Three vocabularies stay apart in code and in CONTEXT.md: a **declaration**
  (what the Session said, dated by it), a **fact** (one dated observation with
  provenance), and an **interpretation** (computed on read, never persisted,
  carrying its own uncertainty). Children fold under their root through the
  whole `spawnedFrom` chain; a child whose parent is absent is shown as a root
  with a coverage gap, never promoted silently.

## Consequences

- A registry of a few dozen files costs one bounded read per minute and no
  report re-assembly; the Work view is current within its own cadence.
- A binary from before this change reopens the upgraded store unchanged; a
  newer binary creates the tables on first open. There is no downgrade step
  because nothing else references the tables.
- Interpretation rules can change without a migration, and a stricter contract
  bound hides rows already on disk, which is why bounds are only ever raised.
- The join to Sessions depends on the served revision being published; the
  dataset reports the join's revision and how many roots it covered instead
  of failing when none exists.

## Rejected alternative

Folding the Desktop declaration into the Session row of the served revision
was rejected: every Desktop turn would have invalidated the revision and
re-assembled the report, the free text would have entered the exported and
replicated capture, and a declaration would have been presented beside
measured usage as if it were a current state.

## Evidence

`packages/local-collectors/src/claude-desktop-sessions.ts` (bounded
collector), `packages/usage-store/src/claude-desktop-session-store.ts` and
`work-session-join.ts` (tables, import, join), `packages/report-core/src/
work-attention.ts` and `work-attention-interpretation.ts` (contract, rules),
`packages/report-data/src/work-attention-read.ts` (read model),
`packages/usage-engine-runtime/src/work-attention-chain.integration.test.ts`
(end-to-end), `docs/local-store-upgrade.md` (additive tables note).
