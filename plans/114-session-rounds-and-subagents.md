# 114 — Session rounds and sub-agents: reading panel with a URL

Status: IN PROGRESS on `feat/session-rounds-panel` (phase 1 committed; phase 2
route, panel and focus policy implemented, e2e in verification). Depends on nothing merged
after `6fb1d660`. Product decisions taken by the operator on 2026-09-09 from the
"Rounds & Sous-agents" proposal (audit of real local history, three directions,
peer review with Codex).

## Why

The session drawer orders information by available fields, not by the reader's
question. The chronology, the one view that says what happened, is hidden
behind an "Analyze" toggle at the bottom of a ~1,500 px panel, and for large
Claude sessions it shows up to 1,024 rows of "Turn N · Recorded duration
unavailable · 0 prompts". Measured on a real transcript (34 prompts, 500
assistant records, 13 sub-agent launches):

- `claude-session-facts.ts` walks `parentUuid` with a 64-hop cap; real rounds
  reach 145 hops, so assistants past the cap become their own `assistant:<uuid>`
  turn. 34 prompts became 117–1,024 rows.
- Recent Claude Code writes no `system/turn_duration` record, so every turn is
  "unavailable" although every record carries a timestamp.
- Sub-agent linkage exists (Task `tool_use` → `toolUseResult.agentId` →
  `<session>/subagents/agent-<id>.jsonl` with a sibling `.meta.json`; user
  records carry `promptId`; `SendMessage` continues the same agent file) and
  is not read.

## Decisions (operator, 2026-09-09)

1. **Round** is the reading unit: one user prompt and the activity attributable
   to it until the next prompt, with the sub-agents it launched or messaged.
   Native `task`/`turn` identities stay in the evidence. Add the term to
   `CONTEXT.md`; record the invariant in an ADR.
2. **Preview panel with a URL, not a dedicated page.** `/sessions/[id]` is a
   real route (full page on direct load); from the Sessions table it opens as a
   panel over the still-mounted table through SvelteKit shallow routing
   (`pushState` to open, `replaceState` while browsing with j/k, Back closes,
   Escape only when the panel owns the entry, focus returns to the selected
   row). Campaigns get their own URL. `NavigationPort` gains shallow
   operations; TanStack Query stays the only result owner (ADR 0010/0012).
3. **Campaign scope defaults to all members**, labelled, table filters kept.
4. **All three harnesses in the first data milestone.** What a harness cannot
   provide is shown as provenance (ADR 0017), never as zero or as a hidden
   category. Codex and OpenCode know the parent session of a child but not the
   spawning round.
5. **Reused agents are one session.** "Lancé agent-X" in the spawning round,
   "Message à agent-X · lancé au round N" later; one lane per agent; usage
   counted once (ADR 0018).
6. Long-prompt disclosure mode and the lane-strip bounded height are decided on
   real data after the panel exists.

## Phases

1. **Contract and derivation** (`report-core/session-detail`, `local-machine`):
   turn-level canonical cost, per-round observed span, interactions
   (spawn/message) and child links with evidence kind, coverage per dimension;
   Claude ancestry without a depth cap plus `promptId` fallback, observed bounds
   including tool results, agent `.meta.json` read within budgets; Codex rounds
   on native task boundaries with `thread_spawn_edges` children; OpenCode rounds
   on message parentage with `session.parent_id` children. Rounds are derived
   once, in `report-core`, from validated turns.
2. **Route and panel**: `/sessions/[rowId]` and `/campaigns/[campaignKey]` as
   child routes of a `(report)` layout that keeps the table mounted (the
   repository's skills-drawer precedent, chosen over shallow routing because
   the layout already exists and a direct load must render the same table);
   the owner pushes one history entry marked as opened from the report,
   replaces it while j/k browses, travels back on close, and restores focus
   after the navigation. Selection is derived from the URL through the loaded
   window, the rows the reader was looking at, an exact `session.lookup`, or a
   one-item campaign page. The drawer keeps its current content until phase 3.
3. **Reading by rounds**: windowed round rail (j/k, filter, jump), reading
   column at prose width, sub-agent interactions under each round, Members view
   for campaigns, first-class unavailable states.
4. **Observed-span lanes and agent view**; call detail; member comparison.

## STOP conditions

- A derivation change that alters a canonical report number (tokens, cost,
  turns) for an existing fixture: stop and record the discrepancy; report
  numbers stay owned by the report projection (ADR 0018).
- Any design that lets the browser read local history outside the validated
  contract (ADR 0010).
- A shallow-routing design that requires the table to refetch on panel open.

## Verification

`bun run check`, `bun run typecheck`, `bun run test` for touched packages,
Playwright e2e for the panel (navigation, Back/Forward, Escape, focus
restoration, 390 px). Real-history smoke: the 26-session Claude campaign shows
34 rounds, not 1,024 turns, and lists its 25 child sessions.

## Execution log

- 2026-09-09 — Phase 1 (contract and derivation) and phase 2 (URL-addressed
  panel, `session.lookup`) landed on `feat/session-rounds-panel`.
- 2026-09-09 — Phase 3 landed: the drawer is an identity block, a four-item
  stat strip, and tabs (Rounds by default, Members for campaigns, Timeline for
  the existing chronology, Summary for token anatomy, details, source control,
  and filters). The rounds reader shows a rail of rounds beside a reading
  column; long prompts open on their first lines and expand on request;
  sub-agent interactions list the member's own row numbers. The panel widens
  to `min(960px, 100vw - 360px)` so the table stays clickable beside it. The
  local detail loads on selection instead of behind an Analyze button. Opening
  a campaign preloads both its member page and its filtered children page, so
  the Members tab lists every member instead of only the root.
- Follow-ups for phase 4: classify prompt origin (Claude task notifications
  arrive as user records whose body starts with `<task-notification>` and are
  rounds of their own today); the rail is not yet windowed (38 rounds render
  fine, thousands would need ADR 0004 treatment); observed-span lanes; the
  agent view; the Linux visual-regression snapshot of the drawer must be
  regenerated in CI.
