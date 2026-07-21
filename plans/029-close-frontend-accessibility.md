# Plan 029: Close the verified accessibility gaps

> **Status: DONE** — verified accessibility gaps are closed with regression coverage.
>
> **Baseline**: commit `6135fe7`. Re-check the named tokens and components after
> plan 028; preserve its demo navigation contract.

## Outcome

The report and supporting routes work with keyboard, screen reader, touch, both
themes, reduced motion, and a narrow viewport without changing the compact
visual identity of the data visualizations.

## Current evidence

- `packages/design-system/src/preset.ts` contains text/background token pairs
  that need contrast verification in both themes.
- `apps/web/src/overview.tsx` exposes Punchcard information primarily through
  visual cells/tooltips.
- The calendar heatmap already implements roving keyboard focus and deliberately
  follows the familiar dense GitHub contribution-graph rhythm.
- Shared header layout lives in
  `packages/design-system/src/components/layout.ts`; some routes patch wrapping
  locally, notably `apps/web/src/routes/skills.tsx`.
- Drawer and tooltip transitions do not consistently honor reduced motion.

## Non-negotiable heatmap decision

Do **not** enlarge heatmap cells to 24 px and do not add oversized overlapping
hit areas. The compact grid and its GitHub-like visual cadence are part of the
design intent.

Keep the existing roving keyboard interaction. For touch target-size guidance,
provide an equivalent accessible day-selection control adjacent to the heatmap
(for example a labelled date input/select that moves the same focused day and
updates the same detail). Document in the component test why this equivalent
control satisfies the exception without distorting the visualization.

## Scope

- Fix confirmed WCAG AA text contrast failures in light and dark themes.
- Give Punchcard a structured accessible summary for non-empty cells while
  keeping the visual grid concise.
- Preserve heatmap density and add the equivalent day-selection control.
- Make the shared app header wrap cleanly and expose one navigation landmark;
  remove route-specific patches made redundant by the shared fix.
- Add a global `prefers-reduced-motion: reduce` override for nonessential
  transitions and animations.
- Verify the report, Skills, Sources, and Sync at desktop and narrow widths.

Out of scope: redesigning charts, changing information architecture, making
every visual cell 24 px, or introducing a component-test framework.

## Implementation

1. Measure the actual token pairs and change the smallest set of semantic
   tokens needed to reach 4.5:1 for normal text and 3:1 for large text/UI.
2. Expose Punchcard's non-empty day/hour/count values as a screen-reader
   structure linked to its heading. Avoid 168 noisy focus stops.
3. Connect the heatmap's existing focus state to a labelled equivalent control.
   Mouse, keyboard, and equivalent-control selection must show the same day.
4. Move header wrapping and landmark semantics into the shared layout owner,
   then delete redundant local header CSS.
5. Add reduced-motion behavior without disabling meaningful state feedback.
6. Add ordinary Playwright coverage for roles, keyboard flow, the equivalent
   heatmap control, and narrow viewports.

## Verification

- Automated contrast checks cover changed semantic pairs in both themes.
- Playwright proves keyboard navigation, Punchcard accessible text, synchronized
  heatmap selection, shared navigation, no horizontal overflow at 390 px, and
  reduced-motion behavior.
- Run `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:e2e`, and `bun run test:e2e-demo`.
- Manually inspect the heatmap before/after: cell density and overall rhythm are
  visually unchanged.

## Done

- [x] Confirmed contrast pairs pass in both themes.
- [x] Punchcard is understandable without relying on color or hover.
- [x] Heatmap cells retain their compact dimensions and spacing.
- [x] The equivalent day control and roving keyboard focus stay synchronized.
- [x] Shared navigation, narrow layouts, and reduced motion pass.

## STOP conditions

Stop if a proposed fix changes chart meaning, enlarges the heatmap cells, or
requires a broad redesign. Do not waive a confirmed accessibility failure; use
the smallest equivalent interaction that preserves the visualization.

## Maintenance

Keep accessibility semantics near the state they describe. Future heatmap work
must test the visual grid and its equivalent control as one interaction.
