# ADR 0083: A task's timeline shows its pull request milestones, dated by GitHub

- **Status**: Accepted
- **Date**: 2026-10-27
- **Amends**: 0051, 0063

## Context

A task's lane in the Work view drew every non-session mark as the same dot: "PR #1491 merged"
was only readable after opening the day. The reader also knew only three pull request dates
(`createdAt`, `mergedAt`, `closedAt`) and the current `isDraft` and `reviewDecision`. How a pull
request moved from draft to review, through change requests to approval, was never read. Diffing
polls cannot recover it: polls carry observation dates, not source dates, and the engine stops
polling a pull request once it reads it merged.

## Decision

- **Source.** The GraphQL read the collector already sends per pull request (review threads)
  also asks for `reviews(last: 50, states: [APPROVED, CHANGES_REQUESTED])` and
  `timelineItems(last: 30, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT,
  CLOSED_EVENT, REOPENED_EVENT])`, with each item's own date and actor login. It now runs for
  every successful view, not only for open pull requests; review threads are still counted only
  while the pull request is open. Comment-only reviews are filtered out by GitHub, so they never
  fill the bounds.
- **Storage.** The result is a snapshot, `PullRequestHistory { complete, items }`, stored as JSON
  in a nullable `history` column of `pull_request_observations`. Each successful read replaces
  it whole. `complete` is false when a connection held more than it returned; the newest items
  are kept. `null` means the read did not establish it (an older row, a failed or malformed
  GraphQL answer), and the failure is named in the observation's message.
- **Merged pull requests.** A pull request stays in the batch until a read that saw it merged
  also established its history. Pull requests merged before this change are read once more, then
  left alone as before.
- **Read model.** Each history item becomes a fact event dated by GitHub
  (`pull-request-ready`, `-draft`, `-changes-requested`, `-approved`, `-reopened`, `-closed`)
  beside the opening and the merge, with its actor. The closure GitHub records when it merges is
  the merge and gets no mark of its own. A timeline mark carries the fact kind it stands for, so
  the lane draws it without reading its label. Marks fill the row's bound in priority order:
  source milestones, then sessions, then the operator's follow-up changes.
- **Lane.** A day draws its most telling milestone as a round glyph (merged, closed, approved,
  changes requested, reopened, ready, draft, opened), shape first and color second; sessions stay
  square. The day button's accessible name lists every milestone of the day.

A review is one reviewer's decision, not the pull request's aggregate `reviewDecision` at that
time: the lane never claims a historical approval state.

**Rejected:** dedicated event and collection-state tables with paginated cursors. They survive
retention independently, but need reconciliation for dismissed or deleted reviews; the filtered
connections are small enough for one bounded read, and a snapshot corrects itself on each read.

## Consequences

The lane shows how each pull request progressed without opening a day, and the task history
lists the same milestones. One GraphQL read per pull request view is spent on merged and closed
pull requests too, and each already-merged pull request is read once more. A dismissed review
leaves the history (its state becomes `DISMISSED`); post-merge changes are not seen once the
merge has been read with its history. CI history and Jira status transitions are not read.

## Evidence

- `packages/local-collectors/src/github-pull-requests.ts` (`PULL_REQUEST_DETAIL_QUERY`)
- `packages/report-core/src/work-attention.ts` (`PullRequestHistory`)
- `packages/report-data/src/work-thread-read.ts` (`factEventsOf`, `timelineMarksOf`)
- `apps/web/src/lib/features/work/work-thread-list.svelte`, `work-milestone-glyph.svelte`
