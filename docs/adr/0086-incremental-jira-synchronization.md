# ADR 0086: Incremental Jira synchronization with durable pending reads

- **Status**: Accepted
- **Date**: 2026-10-28
- **Amends**: 0054 (cadence and issue selection), 0079 (intake discovery remains independent)
- **Extends**: 0009, 0075

## Context

A twenty-ticket rotation every ten minutes left five known tickets stale in the
Work view after a restart. Forty-eight candidates required three cadences even
though a single bounded Jira search could identify the changed tickets.

## Decision

The Jira collection source polls every two minutes through the operator's
`acli` session. Assignment discovery remains separate from change searches:
known followed keys are searched regardless of status or assignee, so completing
or reassigning a ticket does not hide its final update.

Change searches use chunks of forty keys below the fifty-result ceiling, with
`updated` relative to the last successful scan start. Relative minutes avoid
Jira account timezone ambiguity; rounding up plus two overlapping minutes
covers ordinary indexing delay. Every six hours a full detail verification
recovers missed or late-indexed changes. A new key is read even if an older
observation exists from before the current search scope.

The usage engine owns one `jira_sync_state` row per machine in the usage store:
the scan cursor, full verification date, known keys and pending detail keys.
The bounded pending list is committed with the cursor **before** details run.
Details and their wait effects are persisted before acknowledging those keys.
A crash can repeat a read, but cannot lose a pending change. Partial searches
keep the old cursor. Failed keys remain pending without blocking future scans;
incomplete discovery retains the preceding known scope. Limits stay visible.

Each run reads at most twenty details with at most three concurrent processes.
Successful batches with remaining work request continuation after one second;
failures use normal cadence. This continuation is autonomous only, obeys source
policy and the scheduler queue, and never adds work to a foreground collection.
A fatal CLI failure stops new spawns; at most the already active three calls
finish. Unchanged tickets require no detail call. Search results select detail
reads; they never masquerade as fresh comment observations.

Work shows completion time, catch-up, paused, disconnected and incomplete states
from the existing control-plane snapshot. Each completed batch invalidates the
Work thread query identity; report publication is neither required nor triggered.

## Consequences

The normal freshness target is roughly two minutes plus queue and read time,
not a hard deadline. A large backlog, service outage or source cap remains
visible. No credentials, webhook server or Jira writes are introduced.

The new table is additive at usage schema 5; old binaries ignore it. Follow the
[local store upgrade procedure](../local-store-upgrade.md) before deploying it
to a real store. Web and engine restart together because their source catalogue
cadence must agree.

Rejected: merely increasing the twenty-ticket ceiling or polling every ticket
more frequently. Both spend detail calls on unchanged tickets and retain a
capacity-dependent freshness delay.

## Evidence

- [Change searches](../../packages/local-collectors/src/jira-issue-discovery.test.ts)
- [Durable synchronization](../../packages/usage-engine-runtime/src/jira-sync.test.ts)
- [Source integration](../../packages/usage-engine-runtime/src/source-adapters.test.ts)
- [Continuation scheduling](../../packages/usage-engine-runtime/src/source-control.test.ts)
- [Persistence](../../packages/usage-store/src/work-fact-store.test.ts)
- [Browser and accessibility](../../apps/web/e2e/work-jira-sync.spec.ts)
