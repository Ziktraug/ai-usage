# ADR 0043: Browse Session accounts and explicitly promote local knowledge

- **Status**: Accepted
- **Date**: 2026-10-06
- **Amends**: 0042

## Context

Generated Session accounts are useful without reviewing every summary. Accepted
Memory has a separate human decision and can participate in Device replication.
Putting both in `/memory` must preserve these different authorities and uses.

## Decision

Memory has three views: analyzed Sessions, pending proposals, and accepted
knowledge. Browsing and exact durable analysis links do not depend on the
original usage report revision and never trigger generation. Discovery resolves
acknowledged Project/Checkout metadata; a versioned preview fixes the explicitly
authorized Session selection before evidence is opened.

Long Sessions are processed in bounded source windows against a fixed snapshot.
Checkpoints retain native evidence identities. A continuation resumes the same
snapshot; a new interpretation creates a new immutable analysis revision.
Intermediate interpretations are never primary evidence. Cumulative limits
leave resumable partial work.

An explicit local promotion selects a summary, result, or decision in an exact
analysis revision. The application re-reads the source and constructs its
Observation and Proposal using the existing Memory ports. The user chooses an
editable reusable formulation. Source and normalized content identify replays;
different content creates a distinct proposal. Acceptance remains a separate
human operation. Existing `memory.search`, `memory.get`, and
`memory.project_context` retain their accepted-Memory meaning.

Promoted knowledge has an explicit `local-only` publication policy, independently
of normal/sensitive classification. The local adapter persists the policy and
source relation atomically with the proposal. The accepted Item inherits the
policy through its durable proposal link. All later local mutations and future
replication backfills exclude it. This feature provides no remote-publication
consent action; accepting, editing, or enrolling a Device cannot grant one.
The connected adapter refuses local analysis promotion.

## Consequences

Schema 8 is additive and forward-only. Historical version-1 analyses remain
readable. Analysis deletion cannot silently delete accepted knowledge; retained
proposal/Item dependencies and their historical evidence must be reported.
Native histories and external backups are outside derived-content deletion.

## Rejected alternative

Marking every promoted Item sensitive would confuse confidentiality with consent
and make a later sensitivity edit an implicit publication authorization.

## Evidence

- [Promotion application](../../packages/memory-service/src/analysis-promotion.ts)
- [Local promotion and replication regression](../../packages/memory-sqlite/src/analysis-promotion.test.ts)
- [Local store upgrade](../local-store-upgrade.md)
- [Session distillation](../session-distillation.md)
