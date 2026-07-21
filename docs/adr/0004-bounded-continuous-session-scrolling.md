# ADR 0004: Page data and window continuous session scrolling

## Context

Rendering 5,000 mobile session cards exceeded the DOM budget, while a full query would violate the existing 200-row response cap.

## Decision

Sessions use 100-row exact-revision pages coordinated by one cancellable request owner. Desktop rows and mobile cards are DOM-windowed behind the same continuous scrolling interaction.

## Consequences

All stable IDs remain reachable exactly once without a Load more product step. Stale requests, revision changes, and unmount cancel safely; only a bounded window remains mounted.

## Rejected alternative

A full-query render was rejected because it broke the response and mobile DOM budgets.

## Evidence

- [Decision measurements](../session-scroll-benchmark.md)
- [Paging coordinator](../../apps/web/src/session-query-client.ts)
- [Window model](../../apps/web/src/session-row-window.ts)
- [5,000-session proof](../../apps/web/e2e/session-scroll.scale.ts)
