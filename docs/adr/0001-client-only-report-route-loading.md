# ADR 0001: Load report data in the client Router lifecycle

## Context

Report bootstrap can reach private local state in live mode. The route previously reproduced loading, error, and retry state after mount.

## Decision

The index route is `ssr: false` and owns bootstrap through its TanStack Router loader, pending component, error component, and invalidation-based retry. Search parameters do not invalidate the bootstrap. Live revision changes remain with the exact-revision dashboard owner.

## Consequences

The server emits no report rows, while loading and retry follow the same lifecycle as other route state. The initial report appears only after hydration.

## Rejected alternative

TanStack Query does not own the report: ordinary finite queries and exact report revisions have different consistency rules.

## Evidence

- [Route lifecycle](../../apps/web/src/routes/index.tsx)
- [Runtime privacy boundary](../../apps/web/src/report-runtime.ts)
- [Production route coverage](../../apps/web/e2e/production-report.spec.ts)
- [Retry coverage](../../apps/web/e2e/dashboard.spec.ts)
