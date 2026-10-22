# ADR 0056: A dated native record may settle a derived wait; an inference may not

- **Status**: Accepted
- **Date**: 2026-10-22
- **Amends**: 0050

## Context

The Work view read a Session's last declaration and never let anything close
it: a later pull request could at most mark the root reconsidered, and the
question stayed the person's "until they confirm". There is no confirmation in
the product, and there should not be one: the person answers in the harness.
So a question answered there stayed in "Needs you" forever, and the narrow
pull-request rule became a pile of roots to classify by hand.

Claude Desktop keeps one registry file per session and rewrites it on every
turn. The file carries only the latest `postTurnSummary`, but also
`latestUserFrameAt` (when it last recorded a message from the person, queued or
typed; side-session wakes are counted apart), the session's own
`backgroundTaskSuggestions[].expiresAt`, `isArchived`, and the
`spawnedFrom`/`sideSessionNotes` links between sessions. The transcript holds no
summary history, so an earlier question survives only if the collector kept it.

## Decision

- The usage store keeps the distinct turn declarations of each desktop session
  (`claude_desktop_turn_declarations`, at most
  `WORK_ATTENTION_BOUNDS.maxDeclarationsPerSession` per session) and the
  session's `latestUserFrameAt`, additively under the current `user_version`
  (the ADR 0050 precedent). A declaration is dated by the session's activity on
  the first sweep that saw it; a message recorded after it, and no later than
  the next declaration, is its reply. One pure function
  (`advanceClaudeDesktopDeclarationHistory`) advances the history for the store
  import and the e2e composition. No transcript is read.
- A request (a blocked question, a review request) stops waiting only on a
  dated, explicit record of the harness: a message the person wrote to the
  session after it (`request-answered`), the session archived
  (`request-archived`), or a session started from it after the question that
  declared itself completed (`request-handled-elsewhere`). A declaration a later
  turn replaced reads as answered when a message falls in between, otherwise as
  superseded; the new one is the current request.
- An unproven link keeps the attention a human request and makes the root an
  older declaration to reconsider, ranked and shown apart from the current
  confirmed blocks: the existing narrow pull-request rule, work continued in a
  session started from the root without a completion, or a report sent to it.
  A child that predates the question, or an unrelated pull request, changes
  nothing.
- A message answers the request it followed and nothing else: never another
  question, a child's request, a proposal decision, or a routing authorization.
  An open proposal offered before a later message, or past its native expiry,
  is no longer presented as pending.
- The Work read keeps pending sessions beyond its recency bound and fetches the
  parents it names, so a question is not lost to the bound and a recent child is
  not shown as an orphan; what the read and a filter did not cover is stated.

## Consequences

- An answer given in Claude Desktop settles the root without any action in this
  product, and an answered earlier question stays visible as the last decision.
- A sweep that first sees a declaration after the session moved on dates it
  late, which can hide a reply but never invent one; a single sweep (a fresh
  store, the production fixture) cannot date a reply that already happened.
- The interpretation kinds grow; the wire contract carries them unchanged
  because both mirrors read `WORK_INTERPRETATION_KINDS`. The reply instant is
  named in the interpretation text, not as a fact of its own.

## Rejected alternative

Reading the transcript after each blocked turn to find the person's reply was
rejected: it would read private prompts on every sweep for a signal the
registry already dates, and it still could not recover a replaced question.

## Evidence

`packages/report-core/src/work-attention-native.ts` (history advance),
`packages/report-core/src/work-attention-interpretation.ts` (rules),
`packages/usage-store/src/claude-desktop-session-store.ts` (table, import),
`packages/report-data/src/work-attention-read.ts` (bounded read),
`packages/usage-engine-runtime/src/work-attention-history-chain.integration.test.ts`
(two sweeps end to end), `apps/web/e2e/work-e2e-fixture.spec.ts`,
`plans/118-work-resume-cockpit.md` (lot L).
