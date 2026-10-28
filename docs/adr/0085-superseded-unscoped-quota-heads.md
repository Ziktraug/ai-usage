# ADR 0085: A superseded unscoped quota head is omitted at the latest read

- **Status**: Accepted
- **Date**: 2026-10-27
- **Amends**: 0045
- **Extends**: 0057, 0062

## Context

The latest-heads projection keeps one head per provider, machine and account
scope, with the unscoped stream keyed by an empty scope. The Codex app-server
collector wrote its readings unscoped until it scoped them by the signed-in
account's fingerprint (ADR 0057, 0062). On every machine that collected before
and after that change the store now holds two Codex heads: `codex`, last
confirmed the moment the collector stopped writing it, and
`codex:<fingerprint>`, refreshed every few minutes. Every latest-quota reader
(the CLI feed of ADR 0045, the web rail, report-data, the engine's routing and
delegation reads) returned both, so a desktop consumer showed two "Codex"
entries, the dead one as stale.

The unscoped head cannot be deleted. The rollout backfill (`codex-rollout`,
historical confidence) keeps importing unscoped observations because rollouts
carry no account identity; the next import would recreate the head. Keeping
it is also right: an unscoped reading newer than every scoped one may carry a
fresher unattributed reading or an auth-required state.

## Decision

- **Rule.** For one provider and machine, the unscoped head is *superseded*,
  and omitted from the latest read, when at least one scoped head of that
  provider and machine was confirmed (`lastObservedAt`, the value the read
  already returns) at or after the unscoped head's last confirmation. An
  unscoped head newer than every scoped head stays. Other providers and
  machines, a provider with only unscoped heads (Claude today) and every
  scoped head are untouched, so two accounts of one provider both show.
- **One definition, one seam.** The rule is the pure
  `withoutSupersededUnscopedQuotaHeads` in report-core, applied inside the
  usage-store latest-heads read, so the CLI, web, report-data and engine
  readers agree without each restating it. The read reads every selected
  head (bounded by the stream budget) before applying the rule, and the
  caller's `maximumObservations` and `truncated` count the heads that
  survive it, never the rows it removed.
- **Reads only.** No observation is written, deleted or migrated. History
  (`quota --history`, the web drawer) and retention keep every stream, and a
  history read that names an account scope, including the unscoped stream
  (`accountScope: null`), returns exactly what it asked for. The latest read
  has no account-scope filter; a reader that wants the unscoped stream names
  it on the history read.
- **No account label yet.** `ProviderStatus.accountLabel` stays unfilled by
  quota. The operator's name for an account lives in `routing.executors[]`
  in the home config, and the CLI may not read local-machine configuration
  (it has no local-machine data path; the package boundary check enforces
  it). Per-account display labels are deferred to the multi-account routing
  work (per-profile Claude accounts), which decides where that join lives.
  Until then the feed shows the key suffix (`codex:<fingerprint>`).

## Consequences

- `quota --stored --json` lists one Codex entry per account; a status-bar
  consumer no longer sees the dead unscoped head. The web rail, which
  collapsed per provider family, is unchanged in what it shows.
- The engine's routing and delegation qualification no longer see the
  superseded unscoped Codex head among the quota providers; the scoped head
  they already bound to is the one that remains.
- The rule costs one read of the heads table per latest read, which is at
  most one row per stream.

## Rejected alternatives

- Deleting the unscoped head, or skipping unscoped rollout imports: the
  backfill would recreate it, and an unscoped reading can be the freshest.
- Collapsing per provider family in every reader, as the web rail does: that
  hides a second account too, and restates the rule in each consumer.

## Evidence

- [`packages/report-core/src/provider-quota.ts`](../../packages/report-core/src/provider-quota.ts)
  `withoutSupersededUnscopedQuotaHeads`
- [`packages/usage-store/src/provider-quota-store.ts`](../../packages/usage-store/src/provider-quota-store.ts)
  `queryLatestProviderQuotaObservationsWithDatabase`
- [`apps/cli/src/usage-read-model.ts`](../../apps/cli/src/usage-read-model.ts)
  `readLatestProviderQuotas`, the feed's read of that store seam
- Store tests in [`quota-reader.test.ts`](../../packages/usage-store/src/quota-reader.test.ts)
  ("superseded unscoped quota heads") and the CLI integration test for
  `quota --stored --json`
