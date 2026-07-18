# Future Work

Global backlog for known follow-ups that should survive individual refactor logs.

## Report Data Architecture

- Preserve the delivered compatibility split: the served app reads exact immutable revisions through focused Overview, Breakdown, bounded-support, Session page, campaign, and neighbor queries, while compatible CLI consumers retain the complete `UsageReportPayload` path.
- Continue deepening served report surfaces into bounded, destination-specific queries with canonical request fingerprints; do not make the full compatibility payload the live refresh protocol again.
- Keep CLI quota output on the report-data one-shot application port if quota output becomes part of additional reporting surfaces.

## Report UI Models

- Move the small `Hero` and `TokenAnatomy` presentation calculations out of `Overview.tsx` if those components grow again.
- Keep adding pure model tests when dashboard or overview calculations change.

## Manual Transfer

- Improve `/sync` file import review with clearer bundle identity, generated-at, row-count, and conflict summaries before the user confirms a bounded import.
- Consider a documented encrypted-file workflow for users whose existing file-transfer tools do not already protect merge bundles at rest.
- Keep transfer explicit and file-based. Do not add machine discovery, a non-loopback listener, credentials, or background replication without a separate security design.

## Skill Management

- Add safe adoption/import flows for unmanaged target skills once the core source scan, diagnostics, and reconciliation flows have settled.
- Add a git-diff view for the `SKILL.md` editor after the bounded editor flow has real use.
- Add editing for non-`SKILL.md` skill files only after there is a clear safety model for reference files and scripts.
- Add per-target reconcile actions if operators need more granular control than skill-level reconcile.
- Revisit disabled default target locations for Cursor and GitHub Copilot after real local use verifies their system skill paths.

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

- "Wrapped"-style shareable report: a celebratory PNG/PDF recap of a period.
  The app's thesis is "if I had to pay API rates, how impossible would it be" —
  frame the recap around that, not ROI optimization.
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
  into `UsageRow`, then cluster sessions by intent. Parent linking is already in
  place (see below); the remaining work is the intent signal and grouping UI.
- Timeline charts now collapse additive tails beyond 12 categories into a
  non-filterable `Other` series while retaining its member keys in the UI model.
  Add an explicit expand/drill-down interaction only if users need to inspect
  those members directly; do not turn `Other` into an exact dimension filter.
- Add saved dashboard views only if URL-backed state is insufficient in real
  use. A saved view needs naming, overwrite/delete behavior, schema migration,
  and a clear distinction from a shareable URL before local persistence is
  justified.
- Further split the root report bundle only when HTTP route loading remains
  well-covered; Plan 007 intentionally splits server-only Skills and `/sync`
  file-transfer components and keeps `/` intact.

## Session Linking And Titles

- Codex parent-link propagation now exists through `parentSourceSessionId` on
  `UsageRow.source`, and report normalization derives `rootSourceSessionId` via
  `packages/report-core/src/session-lineage.ts`. The remaining useful work is
  around `firstPrompt` propagation, campaign-level intent/title display, and how
  child sessions inherit or group under parent titles.
- Claude Code remains harness-asymmetric: raw logs do not expose the same
  cross-session parent pointer (only the in-file `isSidechain` flag and
  `agent-*` filename convention). Reflect that as a per-metric limitation
  rather than pretending parity across harnesses.
- Titles are already extracted per harness (Claude `ai-title` event, Codex
  `threads.title`, OpenCode `session.title`, Cursor `composerData.name`) and
  shown in Top Sessions. Remaining gap is narrower: subagent/orchestrator
  children fall back to generic ids — children could inherit the parent's title
  once campaign grouping is surfaced in the UI.
