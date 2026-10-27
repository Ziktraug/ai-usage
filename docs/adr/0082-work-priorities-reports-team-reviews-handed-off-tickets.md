# ADR 0082: Reports, team reviews and handed-off tickets do not rank as the operator's move

- **Status**: Accepted
- **Date**: 2026-10-27
- **Amends**: 0063, 0078

## Context

The Work view ranks each task by whose move it is. Three kinds of evidence put
tasks in "To resume" that were not the operator's move:

- Claude Desktop turn declarations with status `review_ready` were read as
  requests, although most are progress reports ("CI running, auto-fix on",
  "Staging and Quality OK; prod deploying") with no action asked.
- `gh search prs --review-requested=@me` also matches reviews requested from a
  team the operator belongs to. Such a request is the team's: anyone may take it.
- A ticket moves through statuses the operator's Jira workflow names (a review or
  QA column) after its pull requests merge. Jira only reports a status category
  (`in-progress` for both "In Progress" and "To Review (IT)"), so the view read
  every unfinished ticket as the operator's next step.

## Decision

- A Desktop declaration is a request only when it names an action
  (`needs_action`), whether its status is `blocked` or `review_ready`. A report
  without one stays on its session; it never ranks the task.
- Discovery runs three searches: authored pull requests, `user-review-requested`
  (personal requests) and `--review-requested` (team requests included). A
  request seen only through the team search records the discovery role
  `team-review-requested`. Its task reads "To decide" ("take it or leave it"),
  after every other remainder, instead of "To resume".
- The home config may name `jira.handedOffStatuses`. The engine compares the
  observed status name with that list, without regard to case, and records the
  verdict with the observation (`handed_off`). Once every pull request of the task
  merged, a ticket in a handed-off status is a wait (`jira-after-merge`), not
  "Ticket not done". An unlisted status, including "In Progress", stays the
  operator's move. No status name is built in.

## Consequences

The verdict is fixed at observation time, so a setting change applies from the
next Jira read, and the history stays explainable. The new discovery role is a
value an older binary does not accept; web and engine upgrade together
(docs/local-store-upgrade.md). Team requests still become review tasks; whether
they should wait in an intake like assigned tickets (0079) stays open.

Rejected: treating every unfinished ticket after merge as a wait. It hides the
common case where the operator still has to move the ticket.

## Evidence

- [Situation ranking](../../packages/report-core/src/work-thread-situation.test.ts)
- [Discovery searches](../../packages/local-collectors/src/github-pull-request-discovery.test.ts)
- [Desktop report is not a request](../../packages/usage-engine-runtime/src/work-thread-requests.integration.test.ts)
- [Handed-off verdict storage](../../packages/usage-store/src/work-fact-store.test.ts)
