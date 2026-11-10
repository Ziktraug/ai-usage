# ADR 0091: Imported transcripts are not usage of the importing harness

- **Status**: Accepted
- **Date**: 2026-11-10
- **Extends**: 0009 (one durable store, collectors as the only writers' input), 0075 (preservation and widen-only reads)

## Context

The ChatGPT desktop app imports every Claude Code session under
`~/.claude/projects` into Codex: it writes a rollout whose tasks are
`external-import-turn-N`, whose single `token_count` reports zero input, cached
and output tokens, and records the pair in
`~/.codex/external_agent_session_imports.json`. On the operator's machine
(2026-11-10) 309 such rollouts exist; they are exactly the registry's entries
and no genuine Codex rollout carries such a task. The Codex collector emitted
each as a `codex` row with model `codex`, zero tokens and `partial: true` —
100 of the 176 November Codex rows — while the same conversations were already
counted as Claude Code rows by the Claude collector.

Six of the imports were later continued inside Codex: the rollout then holds
native turns with a `turn_context` and real usage after the imported ones.

## Decision

A harness's collector reports only the usage that harness produced. A rollout
Codex materialized from another harness's transcript is not a Codex session:
the parser counts its `external-import-turn-N` tasks without opening them, so
they attribute no tokens, prompts or evidence, and
`isCodexExternalImport` (imported tasks present, no native turn with a
`turn_context`, no token usage) excludes the session from rows, skill
observations and work observations. A thread the operator continued in Codex keeps its native turns
and stays a Codex row; the imported turns in it still count for nothing.

The collector returns the ids it classified this way in
`retiredSourceSessionIds`: only rollouts it positively read this pass, never a
session that is merely absent or unreadable. The store marks the matching
local-observed rows of that machine and harness deleted (the store-side
contract lives with `HarnessAdapterCollection`); a session re-emitted later as
a native row becomes active again. The Codex session cache version is bumped so
cached rollouts are re-parsed with the new fact.

## Consequences

- Imported conversations are counted once, under the harness that ran them.
- The classification rests on an in-rollout marker, not on the import
  registry, so it holds on a machine where the registry is absent and does not
  depend on reading another file. The registry remains the way to audit it.
- No schema change. Existing import rows are retired by the store, not deleted,
  per the preservation rule; nothing is rewritten in the rollouts.

## Rejected alternatives

- **Keep the rows and mark them partial.** They are not partial Codex usage;
  they are another harness's usage, and the partial flag would hide a double
  count behind a completeness signal.
- **Detect imports by `originator: "Codex Desktop"` and zero usage.** Genuine
  Codex Desktop sessions share the originator, and a session that was imported
  then continued has real usage; the turn id is the only marker that names the
  provenance of each task.
- **Let the store retire rows the collector stopped emitting.** Source
  retention pruning also stops emission; silent retirement would erase history
  (0075). Retirement must be declared.

## Evidence

- [Codex rollout parser: imported tasks and `isCodexExternalImport`](../../packages/local-machine/src/internal/codex-history.ts)
- [Codex collector: `retiredSourceSessionIds`](../../packages/local-collectors/src/codex-history.ts)
- [Collector tests: imported, continued and cached rollouts](../../packages/local-collectors/src/codex-history.test.ts)
