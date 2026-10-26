# ADR 0061: Keep native Codex request observations local and attributable

- **Status:** Accepted
- **Date:** 2026-10-22
- **Amends:** [0059](0059-work-roots-for-harnesses-that-declare-no-wait.md)
- **Extends:** [0050](0050-work-attention-facts-outside-the-served-revision.md), [0060](0060-attribute-work-responses-to-their-requests.md)

## Context

Codex rollouts can record structured questions even though they do not declare
a Desktop-style turn status. Their asynchronous tool result acknowledges
delivery; a later ordinary message does not identify a response. Question
text and client provenance are local Work evidence, not portable usage data.

## Decision

The existing Codex history parser and versioned cache produce a bounded
`codex-work-v1` observation. The engine stores it in the auxiliary
`codex_work_observations` table, keyed by machine and native session identity.
It never enters usage rows, served revisions, merge bundles or replication.
The table does not advance report generations. Query-only readers cannot
create it. No second scanner runs when Work renders.

Each request keeps its native call identity, delivery acknowledgement or
rejection, and at most three bounded question texts. Answer evidence names the
exact call and question; only those questions receive an answer date. Answer
contents are not stored. Secret question bodies are redacted. A message,
completed turn, child or immediate asynchronous acknowledgement cannot settle
the request. An unacknowledged invocation stays visibly uncertain.

Work reads observations for its already bounded selection of native session
identities. Pending attributable questions can supply `human-request` attention;
missing evidence, an unavailable tool and a completed request do not establish
that no other work remains. Native client, source and fork provenance remain
distinct from declared parentage and do not merge subjects by name or time.

## Consequences

Codex attention becomes useful without manufacturing a turn status. Old caches
must be invalidated to obtain the new observations. Questions outside the
selected sessions or retention bounds remain outside coverage. Synthetic
request/answer fixtures qualify protocol behavior; they do not establish that
every installed client persists human answers in that format.

Putting question text in `UsageRowSource` was rejected: it would carry local
context into portable snapshots and replication. Reading transcripts from the
browser was rejected because collection and write ownership belong to the engine.

## Evidence

[Observation contract](../../packages/report-core/src/codex-work-observation.ts),
[local store](../../packages/usage-store/src/codex-work-store.ts) and
[portable-boundary test](../../packages/usage-store/src/codex-work-store.integration.test.ts).
[Plan 122](../../plans/122-work-continuity-and-codex-review.md) separates native
format qualification from synthetic integration and browser evidence.
