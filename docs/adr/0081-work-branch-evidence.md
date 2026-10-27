# ADR 0081: Sessions join tasks through the branch their harness recorded

- **Status**: Accepted
- **Date**: 2026-10-27
- **Amends**: 0063, 0078, 0079

## Context

Only Claude Desktop declarations attached sessions to tasks. On the operator's machine every linked
session was a Claude session; none of 1,142 Codex sessions in three weeks was linked. Yet the
harnesses record where they worked: Codex writes the repository URL and branch in `session_meta`,
Claude Code writes `gitBranch` and `cwd` on every transcript line. ADR 0078 still holds: a
folder, a title, a time window or a shared checkout is not evidence.

## Decision

- **Evidence.** A session is on a branch when its harness recorded the branch and its repository
  is known: recorded by Codex; for Claude, read from the `origin` remote of its `cwd`, accepted
  only when every `cwd` of the session resolves to that repository (subfolders and worktrees of one
  clone do). A context marked partial (several repositories, truncated spans) is no evidence.
  OpenCode records no branch and Cursor no repository; they never join by branch. A remote host is
  compared through exact SSH aliases from `~/.ssh/config` (`Host` → `HostName`, no patterns) and
  `github.hostAliases` in the home config. Branch names are compared exactly; a name git would
  refuse (`HEAD`, `.invalid`) is not a branch.
- **Storage.** A task holds a `branch:<host>/<owner>/<repo>@<ref>` link. The engine keeps a
  derived, disposable index of which session recorded which branch (`work_session_branches`,
  rebuilt per served revision) and reads a task's sessions through its active branch links. Each
  recorded span counts: a session on A then B reads in both tasks.
- **Delegated sessions** (subagents, Codex reviews, a `codex exec` a Claude session launched) are
  not read on their own: they nest under their parent and never create a task. A `codex exec`
  run without a known parent (`session_meta.source = exec`) joins a task but creates none.
- **Veto.** Detaching a session read through a branch records a detached session link (the
  `detach-session` command). A detached link on any task of a combination holds for all of them,
  for branch reads and for nested children alike. Linking the session again lifts it.
- **PR head branches.** A followed PR whose head branch is in its own repository (GitHub's
  `isCrossRepository` is false) gives its task the branch link. A fork's branch name says nothing.
- **Routing, in order.** A branch already held by a task stays with it. An authored PR whose head
  branch an open task holds joins that task before any ticket routing (0079). A branch with no task
  that names exactly one ticket followed by a single open task joins that task. Otherwise the
  engine creates a task (`origin = session`, `origin_key` = the branch key, titled after the first
  interactive session, project = the repository) when the branch had an interactive, non-delegated
  session since the creation cutoff and is not shared.
- **Not shared** means: not main, master, develop, development or trunk, not a branch the home
  config lists in `github.sharedBranches`, not the clone's `origin/HEAD`, not the base of an open PR.
  These exclusions only stop creation; a session on such a branch still joins a task that holds it.
- **Creation window.** The first reconciliation records a cutoff three weeks back. Sessions
  older than that never create a task; they still join existing ones.
- **Done tasks** keep their branch. A later session reads as activity after Done; the task is
  never reopened and no second task is created for the branch.
- **Placement.** The engine reconciles after each publication that changed the report and after
  each GitHub source run, in one writer transaction, bounded (25 new tasks, 500 candidates, 60
  sessions read per task) and reported truncated beyond.

## Consequences

Codex and Claude Code sessions join the tasks they worked for without any declaration, and work
on a branch without a PR appears as a task. A remote changed after the session is read with its
current repository: the association is as good as the clone's configuration today. Collectors
re-read their caches once (Claude cache 22, Codex cache 28) to record `launchMode` and the new
`partial` rule.

Rejected: one stored session link per matching session (the 64-link bound; one branch had 89
sessions) and recomputing task-to-branch at read time (the branch link is the operator-visible,
detachable fact).

## Evidence

- [Branch evidence journeys](../../packages/report-data/src/work-thread-branches.test.ts)
- [Seeds and ref names](../../packages/report-core/src/work-thread-seeds.test.ts)
- [Local git facts](../../packages/local-machine/src/local-git.test.ts)
- [Store upgrade procedure](../local-store-upgrade.md)
