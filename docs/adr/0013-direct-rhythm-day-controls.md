# ADR 0013: Use direct Rhythm day controls

- **Status**: Accepted
- **Date**: 2026-08-01
- **Formerly**: numbered ADR 0009; renumbered 2026-08-25 to resolve the
  collision with the sole-writer usage-engine ADR
- **Supersedes**: the synchronized labelled heatmap day input required by ADR 0005

## Context

ADR 0005 added a native date input beside the Rhythm heatmap so the compact
visual marks were not the only way to select a day. The heatmap subsequently
made every populated and empty day a real button with a descriptive accessible
name, roving keyboard focus, arrow-key navigation, direct pointer activation,
and a synchronized textual readout. Keeping a second native date input now
duplicates the same activity-day action and introduces a control whose calendar
UI does not reflect the bounded set of days rendered by the report.

## Decision

Rhythm uses its heatmap day buttons as the single activity-day control. The
toolbar exposes one tab stop at a time, arrow keys move by day or week, focus
updates the visible day description, and activation focuses the report on that
exact day. Every button retains a complete accessible name containing its date,
session count, API-value presentation, provenance when applicable, and action.

Punchcard's equivalent semantic representation and the remaining shared
navigation, contrast, narrow-layout, and reduced-motion decisions from ADR 0005
remain unchanged.

## Consequences

Mouse, touch, keyboard, and assistive-technology users operate the same bounded
set of report days, and Rhythm no longer presents two controls for one action.
The compact geometry remains unchanged, so automated accessibility and direct
keyboard/pointer interaction coverage are required whenever the heatmap changes.

## Rejected alternative

Retaining the native date input was rejected because it duplicated the direct
day buttons and could suggest dates outside the heatmap's rendered report data.

## Evidence

- [Heatmap implementation](../../apps/web/src/lib/features/report/overview/activity-heatmap.svelte)
- [Accessibility browser coverage](../../apps/web/e2e/accessibility.spec.ts)
- [Interaction coverage](../../apps/web/e2e/time-range.spec.ts)
- [Presentation regression plan](../../plans/061-close-reopened-presentation-regressions.md)
