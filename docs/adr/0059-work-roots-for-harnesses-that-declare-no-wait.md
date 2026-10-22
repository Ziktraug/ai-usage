# ADR 0059: Work shows sessions of a harness that declares no wait, with their attention not observable

- **Status**: Accepted
- **Date**: 2026-10-22
- **Extends**: 0016, 0050, 0056
- **Amended by**: [0061](0061-local-codex-request-observations.md), which adds local native request evidence without inventing a turn status.

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
  most `WORK_ATTENTION_BOUNDS.maxCodexRoots` (20) roots, the most recently
  active first, the others counted (`coverage.codexSessions`, "N of M Codex
  campaigns shown"; amended at integration so these rows can neither crowd
  Desktop roots out of a page nor inflate the payload). Codex is the one such
  harness today.
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

## Amendment: plain titles, and the originator the read cannot see yet (2026-10-22)

The first run on real history showed Codex rows titled by their raw first
prompt: markdown marks, code spans and long local paths. A Codex row now shows
a plain-text title (marks dropped, whitespace collapsed, long local paths
reduced to their last two segments, cut at the first sentence or near 90
characters with an ellipsis); the detail and the search keep the full text.

Codex rollouts name the client that ran a session: `session_meta.originator`
(`codex_exec`, `Codex Desktop`, `codex-tui`, an editor) and
`session_meta.source` (`exec`, `vscode`, or a sub-agent object). A census of
500 recent rollouts (read only, counts) found both on every one, `codex_exec`
on 93. A `codex exec` run is not interactive and cannot wait on the person,
so such a row could say "automated run · cannot wait on you" instead of
"wait unknown". The read cannot say it yet: the served rows carry `origin`
(human, sub-agent, classifier) but no originator, and the Codex reader in
`local-machine` keeps `source` only to recognise sub-agents. Carrying it needs
a parser change, a served-row field and a `CODEX_SESSION_CACHE_VERSION` bump
(a full re-parse of every rollout); it is left to its own change, and until
then every Codex root keeps `not-observable`.

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
