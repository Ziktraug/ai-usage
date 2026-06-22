# Future Work

Global backlog for known follow-ups that should survive individual refactor logs.

## Report Data Architecture

- Add fine-grained reporting query functions in `@ai-usage/report-data` for rows, analytics, harness status, facets, quota snapshots, and project/source summaries.
- Expose those fine-grained queries through TanStack Start server functions without leaking Effect services or collector internals to client code.
- Move the report UI from one compatibility `UsageReportPayload` signal toward independently loaded slices once the query seams exist.
- Keep `UsageReportPayload` for static HTML export and current bootstrapping until the app has migrated safely.
- Revisit the CLI quota adapter exception to `@ai-usage/local-collectors/codex-history` if quota output becomes part of shared reporting.

## Report UI Models

- Move the small `Hero` and `TokenAnatomy` presentation calculations out of `Overview.tsx` if those components grow again.
- Keep adding pure model tests when dashboard or overview calculations change.

## Sync UI

- Add optional live polling on `/sync` once manual refresh/start/stop flows have had real use.
- Add copy-to-clipboard affordances for served snapshot URLs if selectable text is not enough in practice.
- Consider richer inline editing for remote renames; the current edit form intentionally keeps the remote name fixed.
- Keep persistent config using `tokenEnv`; raw tokens should remain process-local or one-shot only.

## Design System

- Audit `@ai-usage/design-system/report` after another app exists or a second report surface appears.
- Promote genuinely reusable primitives from `@ai-usage/design-system/report` to the root `@ai-usage/design-system` API only when there is a concrete second consumer.
- Keep report-specific style slots in `@ai-usage/design-system/report` rather than making the root API app-specific.

## Tooling And Generated Files

- Revisit direct `bun --filter @ai-usage/design-system build` calls in `apps/web` scripts if all local workflows move through `turbo run`.
- Keep `docs/generated-tooling-ownership.md` updated when Panda, TanStack Router, Vite, Nitro, or Turbo generated outputs change.

## Dashboard And Product

Ideas captured during product brainstorming. Guiding constraints: the dashboard
already shows many numbers, so hierarchize ruthlessly and prefer inductive /
on-hover explanation over adding always-visible figures; sources are
heterogeneous, so carry data limitations per-metric, never as a single global
"data quality" flag. The leverage metric is the emotional hook but is imprecise
(ignores subscription cost, mixes pro/perso usage, has lossy data) — do not
over-emphasize it or build ROI/break-even features on top of it.

- "Wrapped"-style shareable report: a celebratory PNG/PDF recap of a period that
  leans on the existing HTML-export rendering path. The app's thesis is "if I had
  to pay API rates, how impossible would it be" — frame the recap around that, not
  ROI optimization.
- Filter-aware period-over-period comparison: deltas + sparklines derived from the
  same aggregation over `[t-Δ, t]` in `dashboard-model.ts`, computed against the
  *current* filter set. Must respect data hierarchy — surface a delta only where it
  changes a decision; push the full explanation to hover/tooltip.
- Universal drill-down: clicking a Rhythm day, a Model-migration band, or a
  Session-shape point applies the corresponding filter and scrolls to the session
  list. The filter bar already supports title/project/model.
- Outlier sessions framed as *ambitious work*, not "runaway": the top-right of the
  Session-shape scatter (long + expensive) usually means planning-heavy /
  orchestrator-driven efforts. Highlight them as a positive signal worth inspecting.
- Per-metric provenance/limitations: instead of a global completeness badge, let
  individual columns/cards carry their own caveats (partial Cursor counters,
  ambiguous reconciliation, usage-unavailable sessions) where they apply.
- Session intention via `firstPrompt` + parent linking: propagate `firstPrompt`
  into `UsageRow`, then cluster sessions by intent. Gated by the session-linking
  work below — orchestrator-spawned sessions fragment today.

## Session Linking And Titles

- Codex already parses the full parent/child tree (`thread_spawn_edges` SQLite
  table + `payload.source.subagent.thread_spawn.parent_thread_id` in JSONL) in
  `packages/local-collectors/src/codex-history.ts` and marks children
  `subagent: true`, but drops the parent id at the output boundary. Propagating a
  `parentSessionId` onto `UsageRow` would let an orchestrator + its spawned sessions
  collapse into one logical "campaign" — the cheapest path to de-fragmenting
  ambitious multi-session work.
- Claude Code has no cross-session parent pointer in the raw JSONL — only the
  in-file `isSidechain` flag and `agent-*` filename convention. Full tree
  reconstruction is therefore harness-asymmetric; reflect that as a per-metric
  limitation rather than pretending parity across harnesses.
- Titles are already extracted per harness (Claude `ai-title` event, Codex
  `threads.title`, OpenCode `session.title`, Cursor `composerData.name`) and shown
  in Top Sessions. Remaining gap is narrower: subagent/orchestrator children fall
  back to generic ids — once parent linking exists, children could inherit the
  parent's title.

## Source Logs

- `docs/report-data-architecture-refactor-log.md` contains the original report-data refactor history and the first set of follow-ups.
