# ADR 0045: Desktop consumers read quota through the CLI JSON feed

- **Status**: Accepted
- **Date**: 2026-10-12
- **Extends**: 0009

## Context

A desktop status-bar indicator wants each provider's newest subscription quota
every minute, while a separate timer refreshes quota every few minutes. It
could read the SQLite store, call the engine control plane, or run the CLI.
The store schema is internal and migrates without a downgrade path, and the
control plane never carries report data (ADR 0009). A poller that refreshes on
every tick would also start an engine and contact providers far more often than
the quota changes.

## Decision

Desktop and status-bar consumers read quota only through
`ai-usage quota --stored --json`. The command prints one
`ProviderStatusDataset` on stdout, versioned by `schemaVersion`, and keeps
diagnostics on stderr. `schemaVersion` changes when the dataset changes
incompatibly.

A stored read never issues `collect-fresh-quota`, never starts a foreground
engine and never contacts a running one. Only a missing store (a machine that
has never collected) reads as an empty provider list. A store that exists but
cannot be read, including one without a machine identity, fails visibly with
exit 1 and the error on stderr. Refreshing stays with `ai-usage quota --json`
or plain `ai-usage quota`, which go through the engine command seam and keep
their exit-code contract.

Each provider's `generatedAt` is the most recent time its reading was observed.
The store merges identical consecutive readings and only advances their last
observation time, so the feed dates the reading by that time rather than by its
first sighting, through the same report-core
`projectLatestProviderQuotaObservation` that every other latest-quota read
(web, report, engine) uses; a steady provider confirmed every few minutes stays
current.

ai-usage applies freshness before printing, against the time of the read.
Consumers render `state` and never re-derive age from their own clock or
policy. The feed's rule is deliberately stricter than the report's
`providerStatusWithFreshness`: the feed answers "is this current?", so both
`live-api` readings and `local-history` readings recovered from session logs
become `stale` past `LIVE_PROVIDER_STATUS_MAX_AGE_MS` (15 minutes). Readings
from other sources, and readings already `error`, `auth-required`, `stale` or
`unsupported`, keep their state, so aging never replaces a reason. The shared
report rule and the web views are unchanged.

## Consequences

- The store schema and the control-plane protocol stay private; the feed is the
  only quota contract outside the workspace.
- Polling is cheap: a stored read polls no provider and writes no store, and
  appends one bounded CLI wide event (`cli.quota`, annotated
  `quotaRead: 'stored'` on success and failure). Its cadence is independent of
  the refresh cadence.
- A stalled refresh shows up as `stale` without consumer logic, even when the
  newest reading came from session logs.
- The feed and the web report date a reading identically but can still
  disagree on its state: the web never ages session-log readings, so an old
  session-log reading can be `stale` in the feed while the web rail keeps its
  state. The feed is the one that answers currency.

## Rejected alternative

Reading SQLite directly from the desktop extension was rejected: it couples an
external program to an internal, migrating schema and duplicates the freshness
policy outside ai-usage.

## Evidence

- [`apps/cli/src/app.ts`](../../apps/cli/src/app.ts) quota branch,
  [`apps/cli/src/quota.ts`](../../apps/cli/src/quota.ts) `quotaStatusDataset`
  and `providerStatusWithFeedFreshness`, and
  [`apps/cli/src/usage-read-model.ts`](../../apps/cli/src/usage-read-model.ts)
  `readLatestProviderQuotas`
- [`packages/report-core/src/provider-quota.ts`](../../packages/report-core/src/provider-quota.ts)
  `projectLatestProviderQuotaObservation`
- [`packages/report-core/src/provider-status.ts`](../../packages/report-core/src/provider-status.ts)
  `ProviderStatusDataset`, `providerStatusWithFreshness` and
  `LIVE_PROVIDER_STATUS_MAX_AGE_MS`
- [CLI integration tests](../../apps/cli/src/main.integration.test.ts)
