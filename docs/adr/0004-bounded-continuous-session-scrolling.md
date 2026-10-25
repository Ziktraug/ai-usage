# ADR 0004: Page data and window continuous session scrolling

- **Status**: Accepted
- **Date**: 2026-07-22
- **Amended by**: [ADR 0039](0039-continuous-campaign-exploration.md)
  (continuous campaign exploration), itself amended by
  [ADR 0041](0041-exact-detail-selection-with-continuous-exploration.md)
  (exact detail identity); paging lifecycle ownership is in
  [ADR 0076](0076-browser-boundary-orpc-contract-and-tanstack-query.md)
  (formerly ADR 0012)

> Consolidation note 2026-10-24: bounded exploration is three records with
> distinct scopes, not three versions of one rule. This record owns Sessions
> paging and DOM windowing, ADR 0039 owns campaign and member continuity and
> revision pinning, and ADR 0041 owns detail identity, which never consumes
> scroll recovery. Since the SvelteKit migration (PR #27) a served Sessions
> page is 200 rows, equal to the response cap (`SERVED_SESSION_PAGE_SIZE`,
> `MAX_SESSION_QUERY_PAGE_SIZE`), rather than the 100 rows recorded below; the
> decision is unchanged.

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
- [Paging query options](../../apps/web/src/lib/query/options/session-window.ts)
  (paging lifecycle ownership moved to TanStack Query by
  [ADR 0012](0012-tanstack-query-browser-server-state-ownership.md))
- [Window model](../../apps/web/src/session-row-window.ts)
- [5,000-session proof](../../apps/web/e2e/session-scroll.scale.ts)
