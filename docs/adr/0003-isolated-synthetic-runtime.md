# ADR 0003: Isolate the synthetic runtime

## Context

Development, reproduction, and browser testing need representative report data without discovering or exposing the operator's histories, configuration, credentials, or mutable local controls.

## Decision

`bun run demo` runs on `127.0.0.1` with a temporary isolated home and committed deterministic report data. Synthetic-runtime requests are rejected before live collectors or mutation runtimes are constructed, and browser source control is inert.

## Consequences

Overview, filtering, selection, and session detail can be exercised safely. Skills, Sources, and Sync are unavailable because their live capabilities do not belong in the synthetic runtime.

## Rejected alternative

Hiding navigation alone was rejected because presentation is not a privacy boundary.

## Evidence

- [Owned demo launcher](../../tools/run-web-demo.ts)
- [Server boundary](../../apps/web/src/server/demo-boundary.server.ts)
- [Browser privacy test](../../apps/web/e2e/demo-privacy.spec.ts)
- [Boundary construction test](../../apps/web/src/server/demo-boundary.server.test.ts)
