# ADR 0090: One harness owns a session's usage

- **Status**: Accepted
- **Date**: 2026-11-10
- **Extends**: 0075 (preservation and widen-only reads)

## Context

OpenCode 2.x offers a `claude-agent` provider that drives the Claude Agent SDK
on the operator's Claude Code login. The SDK writes every turn as an
`entrypoint: "sdk-ts"` transcript under `~/.claude/projects`, which the Claude
collector already reads as harness `claude`. OpenCode records the same turns in
`session_message` with the model `claude-agent/opus`. On the operator's store
the two records match token for token (one checked session: input 50, output
19 316, cache read 1 796 063, cache write 195 410 on both sides), so counting
the OpenCode copy as OpenCode usage doubled 110 sessions and 2.77 G tokens
(measured 2026-11-10), 56 of which were already stored as OpenCode rows
carrying 434 M tokens.

A session can mix providers: a `claude-agent` turn followed by an `openai` one.
Only the second is usage OpenCode is the system of record for.

## Decision

When two harnesses record the same model turn, the harness that executed the
model call owns the usage; the harness that merely orchestrated it keeps the
session as a transcript but not as a usage row. For OpenCode this means:

- Assistant messages of a foreign-owned provider (`claude-agent`, listed in
  `OPENCODE_FOREIGN_USAGE_PROVIDER_IDS`) are excluded from token, cost, model
  segment, call and tool-count accounting in every OpenCode schema. The report
  collector and the on-demand session analysis partition facts with the same
  function, so their projections stay identical.
- A session whose only usage-bearing messages are foreign-owned emits no usage
  row. Its id is reported in `retiredSourceSessionIds`, the explicit retirement
  channel every collector result exposes: the store marks a row it previously
  held for it `deleted`, and re-activates it if the session is ever re-emitted.
  Retirement is declared only for a session positively read in this pass; a
  session that is absent or unreadable is never retired. A session emitted as a
  row by one OpenCode database is never retired on account of another.
- A mixed session keeps its owned usage and is marked `partial`, the existing
  lower-bound marker, because the row understates the session's activity.
- The session detail still lists foreign-owned turns: it is a transcript view.
  A session with no owned usage has no detail, since there is no row to
  reconcile it against.
- The legacy `message` table and `session_message` are deduplicated by message
  id, the current schema first. On the operator's database every one of the
  18 984 messages present in both tables carries identical tokens, and no
  legacy-era session has a `session_message` row the legacy table lacks, so
  legacy totals are unchanged.

## Consequences

The OpenCode row cache is re-parsed (version 15). The 56 double-counted rows
are retired on the first cold pass after the upgrade; a warm pass served from
the row cache declares no retirement, which is harmless because retirement is
sticky until re-emission. The `Claude sub (OC)` provider label disappears:
no OpenCode row can be dominated by `claude-agent` any more. Skill observations
from a `claude-agent` session are still OpenCode's: the skill tool is OpenCode's
own, and observations are not usage.

## Rejected alternative

Keeping both rows and labelling the OpenCode one as a subscription copy would
have kept every total (tokens, calls, cost lower bound) double counted, and
would have asked each consumer to know which label to subtract.

## Evidence

- [Fact partition](../../packages/local-machine/src/opencode-session-facts.ts)
- [OpenCode collector](../../packages/local-collectors/src/collectors/opencode.ts)
- [OpenCode session analysis](../../packages/local-machine/src/opencode-session-analysis.ts)
- [Fixture scenario](../../packages/local-machine/src/testing/opencode-v2-database.ts)
