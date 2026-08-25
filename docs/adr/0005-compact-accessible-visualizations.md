# ADR 0005: Keep compact visuals and provide equivalent controls

- **Status**: Accepted; partially superseded by
  [ADR 0013](0013-direct-rhythm-day-controls.md) (formerly numbered 0009)
- **Date**: 2026-07-22
- **Superseded clause**: the synchronized labelled heatmap day input

## Context

The dense activity heatmap and Punchcard communicate patterns well, but tiny visual marks cannot also be comfortable touch targets or the sole semantic representation.

## Decision

Compact visualization geometry stays unchanged. The heatmap retains roving keyboard focus and gains a synchronized labelled day input; Punchcard exposes an equivalent semantic table. Shared navigation, contrast, narrow layouts, and reduced motion follow the same accessibility contract.

## Consequences

Mouse, touch, keyboard, and assistive-technology users can reach equivalent behavior without redesigning the visualizations or adding overlapping hit areas.

## Rejected alternative

Enlarging every heatmap cell to 24 pixels was rejected because it destroyed the useful GitHub-style density.

## Evidence

- [Heatmap implementation](../../apps/web/src/lib/features/report/overview/activity-heatmap.svelte)
- [Punchcard implementation](../../apps/web/src/lib/features/report/overview/punchcard.svelte)
- [Time-range interaction state](../../apps/web/src/time-range-control-state.ts)
- [Accessibility browser coverage](../../apps/web/e2e/accessibility.spec.ts)
- [Interaction coverage](../../apps/web/e2e/time-range.spec.ts)
