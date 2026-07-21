# ADR 0005: Keep compact visuals and provide equivalent controls

## Context

The dense activity heatmap and Punchcard communicate patterns well, but tiny visual marks cannot also be comfortable touch targets or the sole semantic representation.

## Decision

Compact visualization geometry stays unchanged. The heatmap retains roving keyboard focus and gains a synchronized labelled day input; Punchcard exposes an equivalent semantic table. Shared navigation, contrast, narrow layouts, and reduced motion follow the same accessibility contract.

## Consequences

Mouse, touch, keyboard, and assistive-technology users can reach equivalent behavior without redesigning the visualizations or adding overlapping hit areas.

## Rejected alternative

Enlarging every heatmap cell to 24 pixels was rejected because it destroyed the useful GitHub-style density.

## Evidence

- [Overview implementation](../../apps/web/src/overview.tsx)
- [Time-range interaction state](../../apps/web/src/time-range-control-state.ts)
- [Accessibility browser coverage](../../apps/web/e2e/accessibility.spec.ts)
- [Interaction coverage](../../apps/web/e2e/time-range.spec.ts)
