# ADR 0046: Row freshness heartbeats are recorded at hour granularity

- **Status**: Accepted
- **Date**: 2026-10-17
- **Extends**: 0009

## Context

Every collection cycle (60 s per session source) re-imports a source's full
row set through `importLocalRows`. An unchanged row still received an
`UPDATE usage_rows SET last_seen_at = ?` and a fleet-metadata validation
write, and `classifyMergeRows` counted the moved `last_seen_at` as a fleet
projection change. The machine fleet generation therefore advanced on every
import, every source run reported `servedProjectionChanged`, and the engine
rebuilt and wrote a complete served revision every minute (measured on a real
store on 2026-10-17: 2.2 s of CPU and about 50 MB written per publication,
one or two publications per minute, even with no usage change). The generation
early exit added for publication in PR #42 never applied in steady state.

The derived per-machine `lastSeenAt` feeds one consumer: the web's machine
freshness presentation, which marks a machine stale after 30 days
(`apps/web/src/machine-freshness-presentation.ts`). Collection liveness itself
is already visible per source in the engine's source-control status.

## Decision

A row's freshness heartbeat is recorded when its stored `last_seen_at` is at
least `USAGE_ROW_FRESHNESS_HEARTBEAT_MS` (one hour) older than the import's
observation time, or invalid. Inside that window an unchanged row is not
written at all and does not count as a fleet projection change. Content
changes, machine label changes, active-date changes and fleet-metadata repair
still propagate immediately, and freshness never moves backwards. The constant
lives in `packages/usage-store/src/index.ts` beside the import path that
enforces it.

## Consequences

- An idle cycle performs zero row writes, leaves both store generations
  untouched, requests no publication and writes no revision. Active cycles
  publish only when usage content changed.
- The served `machineFreshness.machines[].lastSeenAt` lags real collection by
  up to one hour, three orders of magnitude inside the 30-day stale window.
- Tests that pinned a per-minute heartbeat now step by one hour.

## Rejected alternative

Rewriting only the current revision's support payload for a freshness-only
change was rejected: it mutates a revision that ADR 0009 declares immutable,
and still touches every row each minute.

## Evidence

`packages/usage-store/src/index.ts` (`classifyMergeRows`,
`writeClassifiedMergeRows`, `USAGE_ROW_FRESHNESS_HEARTBEAT_MS`) and its
tests in `packages/usage-store/src/index.test.ts`;
`packages/usage-engine-runtime/src/source-adapters.test.ts` (second immediate
run reports `servedProjectionChanged: false`).
