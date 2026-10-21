# ADR 0048: Source-woken publications settle behind the collection burst

- **Status**: Accepted
- **Date**: 2026-10-20
- **Extends**: 0009

## Context

The four session sources share a completion-relative 60 s cadence and become
due within a few seconds of each other. The first source to finish with a
served change woke a publication at once; sources whose timers fired during
that publication ran afterwards and, when they had changed too, woke a second
one. Measured on a real store on 2026-10-17: two complete served revisions per
minute (2.2 s of CPU and 50–150 MB written each) whenever two harnesses were
active. The live engine runs one control-plane worker under the writer gate,
so anything that waits inside a job also delays every other writer command.

## Decision

A publication job carries its reason and a deferral count. When the worker
takes a job woken by a source completion while another enabled, detected
source is queued or due within `PUBLICATION_SETTLE_MS` (5 s), the job is
deferred: at most `PUBLICATION_MAX_DEFERRALS` (2) times, waiting 0 ms behind a
queued source and at least `PUBLICATION_SETTLE_MIN_WAIT_MS` (250 ms) for one
whose timer has not enqueued it yet. The publication stays queued in the
control state throughout.

The wait never runs on the worker or under the writer permit. The worker hands
the deferred job to a scoped timer fiber and moves on, so the burst's sources,
policy changes, machine-label updates, configuration validation and store
quiescence proceed during the window. The timer re-offers the job when the
wait elapses or as soon as an explicit request joins the queued publication,
whichever comes first.

Explicit publication requests are never deferred, including one that joins an
already queued source-woken job: `requestPublicationTransition` records
`explicitRequestPending`, which both the settle decision and the timer read.

## Consequences

- A burst of changed sources yields one publication per cycle instead of one
  per finishing source.
- A source-woken publication is at most about 10 s later than before; served
  data was already minute-grained.
- An explicit request reaches the queue immediately, behind only the jobs
  already queued at that moment.

## Rejected alternative

Sleeping inside the worker before re-offering the job was rejected: with one
worker under the writer permit it serialised every writer command and every
explicit request behind the full window.

## Evidence

`packages/usage-engine-runtime/src/source-control.ts`
(`processPublicationJob`, `PUBLICATION_SETTLE_MS`) and
`source-control-state.ts` (`publicationSettleDecision`,
`requestPublicationTransition`), with tests in `source-control.test.ts` and
`source-control-state.test.ts`.
