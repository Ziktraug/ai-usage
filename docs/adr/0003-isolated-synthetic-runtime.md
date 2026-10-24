# ADR 0003: Isolate the synthetic runtime

- **Status**: Accepted
- **Date**: 2026-07-22; amended 2026-10-24 (unavailable capabilities)

## Context

Development, reproduction, and browser testing need representative report data without discovering or exposing the operator's histories, configuration, credentials, or mutable local controls.

## Decision

`bun run demo` runs on `127.0.0.1` with a temporary isolated home and committed deterministic report data. Synthetic-runtime requests are rejected before live collectors or mutation runtimes are constructed, and browser source control is inert.

## Consequences

Overview, filtering, selection, and session detail can be exercised safely. Skills, Sources, and Sync are unavailable because their live capabilities do not belong in the synthetic runtime.

### 2026-10-24 amendment

The unavailable set is wider than the list above, and the rule is mechanical
rather than per feature. In the synthetic runtime every `/rpc` path and the
four explicit endpoints (`/api/source-control`, `/api/source-control/command`,
`/api/manual-merge/upload`, `/api/manual-merge/download`) answer 404, every
operation in the request policy is `demo: 'forbidden'`, and the management
pages (Memory, Projects, Skills, Sync, Sources) redirect to the report. Memory
and Projects are therefore unavailable too, and so is Work when PR #67 lands,
because it reads through oRPC. A new capability is unavailable in the demo
unless its data is part of the committed synthetic report.

## Rejected alternative

Hiding navigation alone was rejected because presentation is not a privacy boundary.

## Evidence

- [Owned demo launcher](../../tools/run-web-demo.ts)
- [Server boundary](../../apps/web/src/server/demo-boundary.server.ts)
- [Route policy](../../apps/web/src/lib/features/shell/demo-policy.server.ts)
- [Request policy](../../apps/web/src/lib/server/rpc/request-policy.ts)
- [Browser isolation test](../../apps/web/e2e/demo-isolation.spec.ts)
- [Boundary construction test](../../apps/web/src/server/demo-boundary.server.test.ts)
