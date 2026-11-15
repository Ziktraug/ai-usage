# ADR 0092: Known facts rank a task; an unread source marks a milestone, it does not rank

- **Status**: Proposed
- **Date**: 2026-11-11
- **Amends**: 0063, 0082
- **Extends**: 0016, 0078

## Context

The Work view ranks each task by whose move it is (ADR 0063, 0082). The ranking treated every
source that did not answer as a remainder of the task, and any remainder kept a task away from
"ready to close". Measured on the operator's store on 2026-11-11, with `main` at `2b3e9a15`:

- 50 of the 50 tasks loaded read "To resume" or "To decide", none "Ready to close", and none of
  the 63 followed tasks was ever ended;
- 37 of the 50 "What's left" lines named the state of a read ("Local state is unknown",
  "Sessions evidence incomplete", "Local read: missing") instead of a step the operator can take;
- a pull request merged days ago read "To decide" because its branch was never checked out on
  this machine;
- the sessions source reported `truncated` for the whole store, which put one unread remainder
  on every task that has a session.

One unanswered source therefore decided the rank of almost every task, and the list could not
show which tasks wait on the operator.

## Decision

1. **Known facts rank.** A task is ranked on the facts that were read. A remainder that only says
   a source did not answer (`source-unknown`, `source-stale`, `source-unavailable`) is _unread_
   evidence. It ranks a task only when no known fact does.
2. **A merged pull request suggests the end, whatever is unread.** When no known remainder is
   left and every linked pull request is settled with at least one merged, the task reads "ready
   to close". The last known state counts: a stale or failed later read does not undo a merge.
   A linked pull request that was never read is not settled.
3. **A pull request closed without merge settles too**, with its own reason and wording
   ("closed without merge"), but only on a current read: a closed pull request can reopen, so a
   failed or stale GitHub read does not suggest an end. This replaces the earlier rule that left
   such a task undecided.
4. **A checkout read as missing is an observation, not a failed read.** The checkout is gone from
   disk and produces no remainder, unless its last successful read showed local work (changed
   files or unpushed commits). What became of that work is unknown, so it stays an unread
   remainder, named as such.
5. **Absence is not asserted through an unread source.** A task with no pull request (an
   analysis, a review, a branch) and only unread evidence stays undecided: nothing read says the
   work is finished.
6. **The unread stays visible, one level down.** Every unread remainder stays in the task's
   remainders, is listed in the task detail, and is shown and recorded with the acknowledged
   remainders when the operator ends the follow-up (ADR 0063). The list shows it on the milestone
   it concerns (sessions, push, disk, ticket) as "not read", never as the task's next step, and
   the line under a suggested end names each unread source ("checkout not read on this machine",
   "sessions not fully read").
7. **Nothing changes for the follow state.** "Ready to close" remains a derived hint. Only an
   operator command ends a follow-up.

A task with no linked session says "No sessions on this machine". It does not guess where the
sessions ran.

## Consequences

- A suggested end can hide work the product could not see: unpushed commits in a checkout it did
  not read, an agent question in a session it could not read, a ticket it never fetched. The
  operator sees which milestone is unread before ending, and the acknowledgement records it.
  This is the accepted cost of ranking on what is known.
- The per-metric rule of ADR 0016 is kept: the limitation sits on the milestone it concerns
  instead of on the whole task.
- The header comment of `work-thread-view.ts` still holds as written: a missing or failed read is
  never turned into "nothing to do". It no longer turns into "something to decide" either.
- The Pilot presentation groups tasks in bands derived from the same situation. Yours holds only
  tasks with a known step of the operator. In flight holds the other recent tasks. To tidy holds
  tasks with a suggested end, and delivered tasks whatever their age. Dormant holds the rest:
  no source activity, commit or dated request for seven days. The bands are presentation, not
  states.
- The list does not say "remove the worktree": it cannot tell a dedicated worktree from a
  primary clone left on a merged branch. It says the checkout is still on disk.
- The collector reports several `stat` failures as `missing`, not only an absent path. Narrowing
  that outcome belongs to the collector and is not part of this record.

## Open

The operator has not yet ruled on point 2. The alternative is to keep an unread checkout or an
unread sessions source as a blocker of "ready to close" and to change only the wording.

## Rejected

- Dropping unread remainders from the task. The detail and the acknowledgement need them.
- Reading a truncated sessions source as "no open request". Point 5 keeps that case undecided
  when nothing else ranks the task.

## Evidence

- [Situation ranking](../../packages/report-core/src/work-thread-situation.test.ts)
- [Wording, bands and lifecycle milestones](../../apps/web/src/lib/features/work/work-thread-model.test.ts)
