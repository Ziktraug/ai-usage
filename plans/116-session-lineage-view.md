# 116 — Session lineage view: campaign lanes, then project × time

Status: TODO, promoted 2026-10-20 from the 2026-10-17 lineage exploration; nothing
implemented.
Baseline: `main` at `8f7ac54a`, 2026-10-17. Re-check against current `main` before
executing.
Depends on: plan 114 phases 1–3 (merged, PR #55). The Codex part of phase 1 and
phases 3–4 also depend on compressed-rollout discovery from
[PR #62](https://github.com/Ziktraug/ai-usage/pull/62) (ADR 0047), not merged at promotion
and merged into `main` on 2026-10-21 (`1464b6fd`).
Delivers: part of plan 114 phase 4 ("observed-span lanes and agent view"). Call detail
and member comparison stay in plan 114 phase 4.
Authorization: local implementation and isolated verification; no real-store upgrade,
commit, push, or PR unless the operator asks.
Evidence: `.agent-memory/viz-lineage-exploration-2026-10-17/` (gitignored): per-harness
audit, verification ledger, design note with the Codex cross-critique, library
evaluation, throwaway prototype and its screenshots.

## Why

The operator wants to see sessions linked to each other: which session launched which
agent, when, with what overlap, grouped by project. Today the Agent Map lists a
campaign's members with span bars and an indented tree. The Campaigns timeline groups
campaigns by project, and the session panel reads rounds. None of them draws a launch,
a message or a review target, and none shows the fleet across projects over time.

The audit of the real local history (9,395 sessions, 109 project sources, 2 machines)
found a shallow lineage: depth ≤ 1 for 97 % of sessions, maximum depth 3. Campaigns
stay readable as lanes. The largest Claude campaign has 48 members, the largest
OpenCode campaign 23. The largest Codex campaign has 267 members once reviews attach
to their declared target, 163 of them reviews; another has 250 spawned children at
depth 2. The evidence is richer than the readers assume:

- Claude Code declares the launch round, which the detail reader already reads. It
  also declares an immediate agent parent in 29 of 359 sidecars (`parentAgentId`),
  which the collector flattens to the enclosing session.
- Codex declares the parent edge, which is read. It also declares the launching turn
  through the `spawn_agent` output (`agent_id` in 142 outputs, `task_name` in 1,665
  joining `threads.agent_path`), covering 1,806 of 1,858 edges; this is not read. Its
  2,097 review sessions on this machine declare their target, and served
  normalization keeps only the campaign root.
- OpenCode declares the launching message in `task` tool parts
  (`state.metadata.sessionId`, 241 of 244 resolve). Plan 114's
  `harness-no-spawn-evidence` is wrong for OpenCode.
- Cursor declares 3 parent links and 3 launches in 351 composers, plus workspace
  bindings for 40 composers and 99 more by an inferred join. The collector keeps none.
- Codex 0.163 compressed 4,869 rollouts to `.jsonl.zst` on 2026-10-17 and discovery
  accepts `.jsonl` only. PR #62 fixes it; this plan does not.

## Decisions (proposed by the exploration, confirmed by the Codex cross-review)

1. **Two levels, two increments, one renderer.** Campaign lanes come first, on the
   existing Agent Map; the project × time aggregate view comes second. Both use plain
   Svelte DOM/SVG with Panda tokens. No graph library: sigma, cosmos and deck.gl are
   rejected, and d3 is not needed.
2. **Evidence is drawn, never flattened.** A connector sits on the time axis only when
   the harness declares the event with a timestamp. A parent-only edge sits in a
   relationship gutter labelled "launch time not recorded". An unresolved parent, a
   declared child without a parent, a review and a fork each keep their own label and
   evidence kind (ADR 0017, 0040). Tiers are shown as counts side by side, never summed.
3. **Reviews fold, never vanish.** Codex automated reviews collapse into one counted,
   expandable group row per campaign. Usage totals are unchanged (ADR 0018).
4. **Macro is aggregate by default.** Cells per Project source × bin come from one
   bounded revision-keyed projection. Counts are member-attributed, and the rule is
   written in the contract next to the root-attributed Campaigns grouping. Bars with
   nested children appear only inside a narrow brushed window. A permanent "Project not
   collected" band holds Cursor today. Undated sessions are counted outside the bins.
5. **Accessibility follows ADR 0005/0013.** Every mark is a named button, the list rows
   are the equivalent table, connectors are decorative, the lanes use roving focus, and
   axe runs in e2e at 390 px.
6. **Project identity is labelled as what it is** (Project source or Project group).
   The stable Project of ADR 0044 is not promised until the report exposes it.
7. **Decisions 1–4 get an ADR** when phase 2 lands. Take the next free number at that
   time: 0046–0048 are already claimed by open branches.

## Phases

1. **Derivation fixes (report-core, local-machine).**
   - New evidence kinds `opencode-task-part`, `codex-spawn-output` and
     `claude-agent-parent`, extending ADR 0040's vocabulary.
   - OpenCode: a `task` part decoder for spawn and message interactions, with
     `spawnTurnIndex` and reuse of a child referenced several times.
   - Codex: join `spawn_agent` call and output by `call_id`, select `agent_path` and
     `agent_role` in `THREAD_METADATA_SQL`, and map `turn_id` to the round.
   - Claude: read `parentAgentId` and `isFork` from sidecars; keep an unresolved
     `SendMessage` destination as an interaction without a child.
   - Coverage reasons are extended, never widened silently. Fixtures per harness cover
     completed, failed, running and repeated launches. Report numbers stay unchanged
     (STOP otherwise).
2. **Campaign lanes on the Agent Map (web).** A relationship gutter, timed
   connectors, the review group row, round links to the rounds reader for the selected
   session, and a zoom to the children's observed span. Rows are virtualised (proof at
   267 members). Tooltips and focus readouts name the evidence tier. The Linux visual
   baseline is regenerated in CI.
3. **Fleet projection (web-contract, report-data, usage-store).** One oRPC procedure,
   `campaign.fleet` (revision, range, bin unit, grouping), returns per Project source ×
   bin the session count, harness mix, review count and coverage. When the window is
   narrow it also returns root and child spans. It has one Query policy, stays bounded
   (ADR 0004), and its fingerprint is checked in the production protocol spec.
4. **Project × time view (web).** Cells in one sequential hue with a numeric legend,
   drill-down to 7-day bars with nested children and connectors, and the "Project not
   collected" band. A keyboard grid moves by bin and lane, and Enter opens the
   campaign. An equivalent table exists. Layouts cover 768–1279 px and 390 px.

## STOP conditions

- A derivation change alters a canonical report number (tokens, cost, turns, rows) for
  an existing fixture: stop and record (ADR 0018).
- A design lets the browser read local history outside the validated contract
  (ADR 0010), or fetches every member's detail to draw the macro view.
- A default filter, grouping or threshold removes `origin-absent`,
  `origin-unsupported`, unresolved parents, reviews or Cursor from the picture
  (ADR 0017).
- The `/` initial closure exceeds the ceiling or the drift guard (ADR 0020). Panda CSS
  is global, so even route-local work must be measured.
- The Codex part of phase 1, or phase 3 or 4, starts before compressed-rollout
  discovery is merged (PR #62 or an equivalent). A projection built on a store that a
  fresh scan cannot rebuild is a trap.

## Verification

- `bun run check`, `bun run typecheck` and `bun run test` for touched packages.
- Playwright e2e for the Agent Map lanes: keyboard traversal beyond 100 members, focus
  restoration, Back/Forward, 390 px, axe. Playwright e2e for the fleet view: grid
  navigation, drill-down, revision continuity.
- Bundle guard re-measured after each phase.
- Real-history smoke:
  - the 267-member Codex campaign shows its 163 reviews folded into one row;
  - the 251-member Codex campaign shows its 250 launches at their declared turns;
  - the 48-member Claude campaign shows 47 timed connectors;
  - the 23-member OpenCode campaign shows launches at their task-part times;
  - Cursor rows stay visible with "lineage not collected".

## Not in this plan

- Codex `.jsonl.zst` and archive discovery, and cache invalidation (PR #62).
- Cursor workspace binding and its 3 declared links.
- OpenCode and Claude metadata-only sessions as `usageUnavailable` rows.
- Preserving the Codex review target in served rows.
- Prompt-origin classification of task notifications (plan 114 phase 4).
- Call detail and member comparison (plan 114 phase 4).

## Execution log

- 2026-10-20 — Promoted from the exploration draft. Nothing implemented.
