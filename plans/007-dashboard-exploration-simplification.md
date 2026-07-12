# Plan 007: Simplify Dashboard Exploration and Dataviz

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: product / UI architecture
- **Started at**: commit `8c500fa`, 2026-07-12
- **Completed on**: 2026-07-12
- **Branch**: `feat/dashboard-ui-simplification`

## Why this matters

The report has strong data coverage but exposes too much structure at once.
Seven peer tabs, two competing time-range concepts, a wide all-purpose session
table, secondary provider cards, and multiple dense charts make common tasks
feel like report configuration rather than exploration.

This plan keeps every existing analytical capability while making the common
path legible: choose a report range, understand the overview, inspect sessions,
then opt into breakdowns or advanced analysis.

## Product decisions

1. The report has three primary destinations: **Overview**, **Sessions**, and
   **Breakdown**. Model, provider, harness, project, and Cursor attribution are
   secondary breakdown dimensions, not peer product destinations.
2. **Report range** changes the filtered data. **Chart view** only changes the
   visible graph window. Those concepts must never share an ambiguous label.
3. Chart configuration remains available behind progressive disclosure; the
   current choices stay visible in the disclosure summary.
4. Overview keeps decision-making content primary and moves exploratory
   Session shape and Punchcard views into one Advanced analysis disclosure.
5. Categorical colors are derived from stable keys. No series changes color
   merely because another filter changes ordering.
6. Existing dashboard URLs, non-empty legacy column diffs, mobile summary
   cards, static HTML export, and keyboard interactions remain compatible.
7. Work is delivered as independently tested commits. The execution log records
   behavior, tradeoffs, and verification rather than duplicating code details.

## Vertical slices

### Slice 1 — Immediate exploration fixes

- Focused Work/Tokens/Reliability session presets and identity-first columns.
- Reversible exact filters and Clear all.
- Overview drawer continuity, session-scaled Rhythm heatmap, keyboard graph
  viewport controls, improved chart-label contrast.
- Selected dashboard content before compact provider status.

### Slice 2 — Information architecture and time

- Three primary tabs with URL-compatible Breakdown dimensions.
- Visible query filter pill and consistent direct removal.
- Report range / Chart view terminology.
- Collapsed Chart options with an interpretable summary.

### Slice 3 — Dataviz hierarchy

- Advanced analysis disclosure for secondary Overview charts.
- Stable categorical color mapping.
- Readable series limits with an honest Other aggregate where totals remain
  mathematically valid.

### Slice 4 — Delivery quality

- Investigate route-level code splitting without weakening SSR/static export.
- Desktop, 1024px, and narrow-mobile visual checks.
- Focused red/green tests, full unit/type/build/E2E verification, two-axis code
  review, documentation update, and clean commits.

## STOP conditions

- Do not remove an analytical view or export field merely to simplify layout.
- Do not reinterpret API-equivalent value as actual spend, savings, or ROI.
- Do not break old `tab=` deep links or non-empty `cols=` links.
- Do not enable route splitting if it breaks static HTML export or produces a
  client-only loading failure.
- Do not introduce a charting dependency for changes supported by the existing
  Solid/Panda implementation.

## Verification

Run after each relevant slice and in full at completion:

```sh
bun x ultracite check
bun run typecheck
bun run test
bun run build
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/google-chrome bun run test:e2e
```

## Outcome

All four slices are implemented. The report now exposes three primary
destinations, separates report filtering from chart-only zoom, progressively
discloses chart options and advanced analysis, keeps model colors stable,
aggregates dense additive timeline tails without changing totals, and splits
server-only Skills/Sync UI out of the report entry while retaining the
single-file static report contract.

The following ideas were deliberately not forced into this plan:

- Session-shape harness marks are not collapsed into `Other`, because doing so
  would remove the category identity required to inspect a concrete session.
- Saved views remain a product follow-up; URL state already provides a durable,
  shareable seam and there is not yet evidence for a second persistence model.
- The root report route remains in one entry chunk because self-contained HTML
  export cannot fetch lazy assets from `file://`.
