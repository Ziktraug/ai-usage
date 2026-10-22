# ADR 0059: Work shows sessions of a harness that declares no wait, with their attention not observable

- **Status**: Accepted
- **Date**: 2026-10-22
- **Extends**: 0016, 0050, 0056

## Context

The Work view reads waits from one source: the Claude Desktop registry, whose
`postTurnSummary` is the session's own declaration (ADR 0050, ADR 0056). Codex
sessions were absent from it, so the board read as complete supervision while
it covered one harness.

Codex records no turn status. A census of the local rollouts (2026-10-22, read
only, counts and key names) found `session_meta` (`cwd`, `git.branch`,
`git.repository_url`, `git.commit_hash`, `parent_thread_id`, `thread_source`),
turn boundaries (`task_started`, `task_complete`, `turn_aborted`) and the
approval policy in `turn_context`, but no persisted approval request: command
approvals go to an automatic reviewer session (`thread_source:
guardian_review`). The one person-facing request in the rollouts is the
`request_user_input_async` tool call (a question with options; 51 calls in 1 500
rollouts). Its output is an immediate `{"accepted": …}`: the agent goes on, and
the answer arrives later as an ordinary user message. A pending approval in the
app server is a request to the client that owns the thread; another client
cannot read it.

The served report already carries every collected Codex session with the
working directory, the branch Codex recorded, its dates and its declared parent;
its campaigns fold delegated sessions and automated reviews under their root by
those declared links only.

## Decision

- A harness that declares no turn status contributes Work roots of its own:
  one per served campaign of that harness active in the activity window, read
  from the current served revision (`queryRecentServedHarnessSessions`), at
  most one page of roots, the most recently active first, the others counted.
  Codex is the one such harness today.
- Their attention is `not-observable`: whether the session waits on someone is
  unknown, which is not "nothing pending". No human request and no external
  wait is ever derived for such a root, whatever its facts show; it ranks after
  every Desktop root, so the page limit cuts it first and never hides a Desktop
  root to make room for it. The view groups these roots apart and says, per
  harness, what was read: declared waits from the Desktop registry, sessions
  only from Codex, nothing from the other harnesses.
- A root carries only what the harness recorded natively: its directory, its
  recorded branch, its dates, its children through declared parents, and the
  checkout observation of its exact directory. It is never folded under a
  Desktop root, and a shared checkout, branch or time never links one.
- `request_user_input_async` is not read as a wait in this version: the
  collector does not parse it, the question is non-blocking by design, and a
  later user message is its only answer. Surfacing it needs a parser change in
  `local-machine`, a Codex cache version bump (a full re-parse) and its own
  rule for what settles it.

## Consequences

- The Work dataset contract is unchanged in shape: the new attention kind
  travels through the existing enumerations, and the coverage of the Codex read
  is derived from the roots and the served revision the dataset already names.
  A coverage field of its own would need the oRPC contract and its client to
  change together.
- The Work read gains one bounded read of the served projection (a window scan
  through `idx_served_report_rows_active_time`, then the chosen campaigns
  through `idx_served_report_rows_campaign`) and the checkout observations of
  the Codex directories. No table and no migration is added.
- A Codex session that ran in a Claude worktree is labelled by that directory:
  Codex declares no origin checkout, and none is inferred.
