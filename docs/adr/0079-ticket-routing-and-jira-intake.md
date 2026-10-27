# ADR 0079: One delivery task per ticket, and a Jira intake instead of automatic tasks

- **Status**: Accepted
- **Date**: 2026-10-26
- **Amends**: 0063, 0078
- **Amended by**: [0080](0080-combined-work-threads.md) (existing duplicates are combined), [0081](0081-work-branch-evidence.md) (branch equality routes first)

## Context

Discovery seeded one Following task per assigned Jira issue and one per authored
pull request. A PR task showed its ticket only through its head branch, so the
rule "a key already linked creates nothing" never fired: a ticket and each of its
PRs appeared as separate tasks. Observing every assigned issue (instead of the
first twenty per run) would also have turned the operator's whole backlog into
Following tasks the operator never chose.

## Decision

- A delivery task follows one ticket. An **authored** pull request whose head
  branch names exactly one Jira key as a whole segment joins the single open
  (Following or Waiting) task that follows that ticket: by origin, by an active
  Jira link, or through another active PR whose latest head branch names it.
  The join is a `declared` link whose `link-added` event records the branch
  evidence. When no task follows the ticket, the new PR task also receives the
  ticket as a `declared` link, so later PRs and the intake find it.
- Several open followers, a Done follower, or a detached link to the ticket (the
  operator's veto) never route: the PR keeps its own task, visibly. Review
  requests never route; a teammate's ticket stays context. PR titles never route
  (0054, 0078).
- **Jira intake**: an assigned issue is recorded in `work_jira_intake`, not
  turned into a task. The Work view lists assigned, undismissed issues that no
  open task follows, above the tasks. The operator follows one (a `create`
  command), attaches it (a `link` command) or dismisses it (`dismiss-intake`,
  reversible). Only a complete search marks an issue unassigned; a failed one
  changes nothing.
- An intake decision concerns no task: its command result names none
  (`threadId: null`). Task commands keep their task-bearing result.

## Consequences

Existing duplicate tasks (Jira-origin tasks beside their PR tasks) stay until the
operator combines them (0080); nothing is migrated silently (0078). A ticket
whose two PRs already have separate tasks remains ambiguous for routing until
then. The intake table is additive under usage version 4; readers of an older
store report it as not yet upgraded.

Rejected: keeping one task per assigned issue and hiding backlog by status. A
status says where the ticket is, not whether the operator owns its follow-up.

## Evidence

- [Routing and intake store regressions](../../packages/usage-store/src/work-thread-store.test.ts)
- [Seed routing key](../../packages/report-core/src/work-thread-seeds.test.ts)
- [Jira source into the intake](../../packages/usage-engine-runtime/src/source-adapters.test.ts)
- [Browser journey](../../apps/web/e2e/work-threads.spec.ts)
