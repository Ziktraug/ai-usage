# ADR 0037: Absence proof requires current producers and durable skill invocations

- **Status**: Accepted
- **Date**: 2026-08-31
- **Amends**: [0012](0012-tanstack-query-browser-server-state-ownership.md)
  (collection-SWR revalidation) and
  [0022](0022-skill-observation-tiers-and-observability.md) (producer roster,
  completeness freshness, and retention)
- **Related**: [0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
  (two planes), [0016](0016-collect-everything-present-faithfully.md), and
  [0017](0017-absence-is-a-gap-not-a-category.md)

## Context

ADR 0022 made missing producer state provisional, but two later implementation
details could turn missing evidence back into an exact absence:

- disabling a session source removed its harness from the expected producer
  roster, so it no longer had to prove that its history was collected;
- a complete producer row remained reusable forever, even after collection had
  stopped or repeatedly failed.

Uniform 400-day retention introduced a second contradiction. It removed the
rare `declared` and `inferred` facts while the product still described a
complete invocation history. The high-volume `exposed` catalogue stream needs a
window; invocation evidence needs a durable record.

## Decision

1. **Every global absence proof requires every observable producer.** Claude,
   Codex, and OpenCode remain in the expected roster whether their session
   source is enabled or disabled. Cursor remains `not-observable` and requires
   no producer answer. A disabled expected producer is explicitly incomplete;
   disabling collection never proves absence.

2. **Producer completeness is current, not perpetual.** The end-to-end proof
   budget is five minutes. A new server read accepts persisted `collected_at`
   state no more than four minutes old, reserving the final minute for browser
   caching. The store derives the required nullable `producerProofValidUntil`
   from that read cutoff plus the five-minute budget, and every downstream fold,
   inventory join, and wire adapter preserves it unchanged. It is never minted
   from response completion time; a missing cutoff produces `null`, not an
   invented proof. Missing, malformed, stale, disabled, rejected, or truncated
   producer state keeps the relevant evidence provisional. Collection-state
   reads are bounded and report overflow as incompleteness. Malformed collector
   input contributes to the persisted rejection count instead of disappearing
   before that answer is written.

3. **The browser expires evidence independently from refetch completion.** The
   named `collection-swr` policy keeps its one-minute refetch interval, focus
   revalidation, and unconditional mount refetch. Its data-aware `staleTime` is
   `max(0, min(1 minute, producerProofValidUntil - dataUpdatedAt))`, so a long
   server read or inventory join is stale immediately instead of receiving a new
   cache lifetime. TanStack retains old data during a suspended or failed
   refetch, so the presentation edge treats both stale and in-flight observation
   data as provisional; only current settled data may carry an exact absence.
   Publication and inventory invalidation remain the fast path. The timer is
   still required because a stopped producer emits no event that could
   invalidate its last successful answer.

4. **Invocation observations are durable; exposure is windowed.** `declared`
   and `inferred` rows are not age-pruned. Only `exposed` rows use the 400-day
   retention window. Rescan cutoffs apply only to exposure so an expired
   catalogue row cannot be resurrected while an old invocation can still be
   recovered after a collector repair.

These rules do not add another data owner. The usage engine still writes the
SQLite data plane, Web still reads it through a bounded `query_only` connection,
and the control plane carries no observation rows.

## Consequences

- A source that is intentionally disabled makes absence-derived verdicts
  provisional. Positive invocation evidence remains conclusive.
- If collection stops, an exact absence automatically becomes provisional
  within five minutes even when the database and report revision do not change.
- A slow inventory scan, suspended refetch, or retained error value cannot
  extend an accepted producer proof. The wire deadline remains the authority;
  Query staleness and fetch state qualify the retained payload fail-closed.
- The store can grow with invocation history. Invocation rows are rare and keep
  the existing import/read/response bounds; the per-session catalogue flood is
  still capped by exposure retention.
- No schema migration is required: observation tier and producer
  `collected_at` already exist. Collector cache versions advance when parser
  completeness semantics change so cached transcripts are re-evaluated.
- `producerCompletenessMissing` means at least one expected producer has no
  usable current state because it is missing, stale, disabled, or omitted by a
  bound. A present rejected/truncated state remains a separate tier-specific
  incompleteness fact.

## Rejected alternatives

- Keeping only enabled sources in the roster was rejected because a collection
  switch would change a lack of evidence into proof.
- Relying only on publication invalidation was rejected because a stopped or
  disabled producer cannot publish the event needed to expire its own answer.
- Keeping uniform retention and changing the copy to "last 400 days" was
  rejected because the invocation collectors rescan durable local history and
  the product needs that history for deletion decisions; the storage pressure
  comes from exposure, not invocation.

## Evidence

- [`packages/usage-store/src/skill-observation-store.ts`](../../packages/usage-store/src/skill-observation-store.ts)
- [`packages/usage-engine-runtime/src/source-adapters.ts`](../../packages/usage-engine-runtime/src/source-adapters.ts)
- [`apps/web/src/server/skills.server.ts`](../../apps/web/src/server/skills.server.ts)
- [`apps/web/src/lib/query/policies.ts`](../../apps/web/src/lib/query/policies.ts)
- [Plan 111 — skill invocation observability](../../plans/111-skill-invocation-observability.md)
