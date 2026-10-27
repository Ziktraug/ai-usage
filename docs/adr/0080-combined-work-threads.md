# ADR 0080: Combine the tasks of one ticket through a reversible membership

- **Status**: Accepted
- **Date**: 2026-10-26
- **Amends**: 0063, 0079

## Context

ADR 0079 stops new duplicates, but discovery had already split tickets across
several open tasks: the ticket's own task beside one task per pull request. The
operator wants one task per ticket, combined only after a preview and undoable,
without breaking the invariants of 0063: links are never deleted, a detached
link is a veto, follow state changes only by explicit commands.

## Decision

- A **combination** records that member tasks are part of a kept task
  (`work_thread_combinations`, additive under usage version 4). Members keep
  their links, events, title and follow state; nothing is moved or copied.
  Ending it records the separation; rows are never deleted. Membership is flat:
  a kept task cannot be a member, a member belongs to one kept task.
- **Grouping rule**: open tasks (Following or Waiting) that follow exactly one
  qualified ticket by origin, an active Jira link, or an active PR on a
  non-review task whose latest head branch names exactly that one key. A
  detached link to the ticket removes that task. Done tasks are history and
  never join.
- The ticket's own task is kept; otherwise the oldest. Members are never marked
  Done.
- `combine` names the ticket, the kept task, and the exact participants with
  their follow revisions. Inside the writer transaction the engine recomputes
  the group: any difference is `stale-preview`, a changed revision is
  `revision-conflict`. Admission refuses Waiting or review participants, notes,
  an existing combination, more than 64 distinct active links, more than 8
  tasks, and a key active on one task but detached on another. Applying advances
  every participant's follow revision.
- While combined, every task-level path reads the kept task: lists, counts,
  projects, search and activity aggregate members and hide them; routing and the
  Jira intake count the group once; collection follows the kept task's state;
  waits may name a member's link; declared sessions attach to the kept task.
  Detaching a link through the kept task detaches every active copy of that key
  in the group. Commands addressed to a member are refused with `task-combined`.
- `separate` ends the combination for the kept task. Members return with the
  state they kept; work recorded on the kept task meanwhile stays there. It is
  refused while the kept task waits on a link only a member holds.

## Consequences

The Work view proposes the eligible combinations with a preview and applies one
command per ticket. A member's URL shows that it was combined and links to the
kept task. A binary from before this change ignores the table and shows members
as tasks again, without losing data.

Rejected: moving or copying links into the kept task. Undo would have to detach
them, turning bookkeeping into operator vetoes, or delete rows.

## Evidence

- [Combination store regressions](../../packages/usage-store/src/work-thread-store.test.ts)
- [Combined read model](../../packages/report-data/src/work-thread-read.test.ts)
- [Browser journey](../../apps/web/e2e/work-threads.spec.ts)
