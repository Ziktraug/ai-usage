# ADR 0039: Rounds are derived once from native turns, and child links carry their evidence

- **Status**: Accepted
- **Date**: 2026-09-09 (records the product decisions of plan 114)

## Context

The session chronology rendered one row per derived "turn". For Claude Code
that unit degraded to one row per API call: the transcript walk stopped at 64
`parentUuid` hops while real rounds reach 150, recent transcripts carry no
`turn_duration` record, and sub-agent launches were not read at all. A 26-member
campaign root showed 1,024 rows, none timed, none linked to the 25 child
sessions the report already listed. The operator reads a session as *rounds*:
what was asked, what followed, which agents were launched, at what cost.

## Decision

- **Round** is the reading unit across harnesses (see `CONTEXT.md`). It is
  derived exactly once, in `report-core`, from the validated native turns each
  reader already groups per prompt (`deriveSessionRounds`). No surface re-groups,
  re-prices, or re-sums activity; turn-level canonical cost and call counts are
  computed by the readers with the shared pricing.
- **Unattributed activity stays visible** as a round of its own (ADR 0017). A
  reader must not invent a prompt for it, and a conflicting record resolves to
  a prompt only when every parent it was recorded with agrees.
- **Child links carry their evidence kind** (`claude-agent-link`,
  `claude-agent-meta`, `codex-thread-edge`, `opencode-session-parent`) and a
  nullable spawning turn. A harness that knows the parent session but not the
  launching turn says so; the UI shows the gap, never a guessed round.
- **A messaged agent is the same child session.** Interactions distinguish
  `spawn` from `message`; usage belongs to the child's canonical row once
  (ADR 0018) and is never redistributed across the rounds that messaged it.
- **Coverage is stated per dimension** (grouping, prompt bodies, recorded
  timing, child discovery, interaction attribution) with a closed reason list,
  so an omission is a fact the browser can render, not a silent cap.
- **Observed span is not active time.** A round's `observedSpanMs` comes from
  timestamps; recorded harness intervals stay a separate, optional fact.

## Consequences

- Prompt identities are budgeted separately from prompt bodies: an identity
  past the body budget keeps an empty body flagged `truncated` so late rounds
  still group.
- Readers scan bounded sidecars (`agent-*.meta.json`, one level of workflow
  run directories) to discover children; budgets are counted into coverage.
- The browser joins child links to campaign member rows for numbers; it never
  reads local history outside the validated contract (ADR 0010).

## Rejected alternative

Shipping pre-aggregated `rounds[]` in the payload was rejected: every reader
already yields one turn per prompt, so a second array would duplicate the turn
list and need its own consistency validation. Raising the ancestry depth cap
was rejected because it only moves the failure.

## Evidence

- [Plan 114](../../plans/114-session-rounds-and-subagents.md)
- [Contract](../../packages/report-core/src/session-detail.ts)
- [Claude derivation](../../packages/local-machine/src/claude-session-facts.ts)
