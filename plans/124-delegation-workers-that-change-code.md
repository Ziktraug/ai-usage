# 124 — Delegation workers that change code

Status: TODO. Proposed 2026-10-29 on top of `main` at `e759be2b` (plan 121 merged as PR #73);
revised the same day after operator feedback (convenience first, trusted repositories).
Authorization when executed: branch, code, documentation, an ADR, disposable stores and disposable
repositories, explicit commits. No real-store migration, no push, no pull request, no change to
provider sign-ins unless the operator asks for that step.

## Why

ADR 0077 states the intent: the operator hands a task to the agent they use that day, and AI Usage
lets that agent delegate by difficulty, capabilities, accounts, quotas, resets and preferences,
without the operator choosing a model or reading quotas. Plan 121 delivered that frame for one
action only, `read-only-review`, a scope cut inherited from the Work view review simulation
(plan 117, ADRs 0052/0053). `code-change`, `commit` and `publish` are named and refused. This plan
makes `code-change` executable.

The operator's current practice is the baseline to match, not to harden: Claude Code launches
`codex exec` to change code in the checkout, with network, without a size limit, without trouble.
AI Usage adds what that practice lacks: account and quota routing, durable jobs, parallel workers
that do not collide, and one command for every harness.

## Decisions

The design went through two rounds with Codex as an independent peer. The first draft had a
private clone, an artifact stored by the engine, network off and a diff ceiling. The operator
judged it over-engineered, and Codex agreed for this threat model: a trusted repository, a single
operator, convenience first. The decisions below are the revised position. Codex's remaining
corrections are folded into D3, D4 and D8.

- **D1 — One command, typed execution options.** `delegation.start` (MCP) and
  `ai-usage delegation start` stay the single cross-harness entry point. A `code-change` request
  carries an optional `execution` block:
  - `workspace`: `worktree` (default) or `in-place`;
  - `network`: `allowed` (default) or `off`;
  - `effort`: a level the route's model accepts.

  The options are typed; no raw harness flag or environment override passes through. Flow:
  normalise the defaults, apply any home rule, check what the adapter and model support, qualify
  (the effective options are part of the qualification and of the request digest), persist them,
  and revalidate at start. The options are returned before selection and never changed silently
  at launch. An option an adapter cannot honour (for example `network: off` where it cannot be
  enforced) is refused, not ignored. Effort is resolved per candidate during qualification.
  Defaults are per action: `read-only-review` keeps its current controls unchanged.
- **D2 — Rules still decide admission; caps are optional.** Admitting `code-change` needs the
  executor capability `code-change` in `routing.executors[]` and a per-checkout grant for the
  action. `routing.reviewTargets[]` keeps granting review only. Account, quota, reserve and
  concurrency admission is unchanged from ADR 0077. Home rules may cap execution options (for
  example forbid `in-place` or `network: allowed` on a repository); without a rule, the documented
  defaults apply.
- **D3 — Worktree by default; the result is a delegation branch.** The engine creates a linked
  worktree on a new branch (`ai-usage/delegation/<jobId>`) from the frozen start SHA, in an
  engine-owned directory, with hooks and filters disabled. When the whole worker has stopped (D5),
  the engine runs `git add -A` and makes **one commit** on that branch. The commit uses a fixed
  engine identity, no hooks and no signing, so untracked files are included and the branch really
  carries the change: the caller or the operator merges, cherry-picks or squashes it. The job
  records the start SHA, the end commit, the worktree path, the stats (untracked files included)
  and the worker's report as its claim. No diff is stored in SQLite. A worktree or branch that
  later disappears is reported as missing, never reconstructed. Worktrees are kept until the
  operator or caller removes them, through a `delegation.cleanup` operation or by hand. This
  engine snapshot commit is not the `commit` action, which means a commit on the operator's own
  branch under their identity (see Out of scope).
- **D4 — `in-place` is allowed and stated honestly.** The worker runs in the operator's checkout,
  which is reserved for one writing job. The reservation coordinates AI Usage jobs only: the
  caller, the editor or a worker launched outside AI Usage are not excluded, so the caller should
  not edit during the job. On a dirty checkout, the input is the working tree, not the frozen SHA,
  and the job says so. No snapshot commit: the result is the files left in place, with stats
  against the start SHA. Worker and caller edits cannot be told apart.
- **D5 — The whole worker must have stopped.** Today the runner signals the harness child only
  (`review-worker-process.ts`), and completion deletes the private directory (`delegation.ts`,
  `track`). A test server or a detached descendant could keep writing after the job is "finished".
  ADR 0055's evidence rule is extended to the worker's whole process group or session before the
  snapshot commit, a continuation or a cleanup. Without proof of quiescence, the job does not
  finish and its workspace stays reserved; nothing is ever released because of age.
- **D6 — ADR 0051 is amended.** Observation stays read-only. A delegation workspace component may
  create and remove worktrees and `ai-usage/delegation/*` branches in an admitted repository, and
  commit on those branches only. It never writes the operator's branches, the index of the
  canonical checkout outside `in-place`, or any remote. The new ADR (0087 or the next free
  number) records this and amends 0051, 0055 and 0077. ADR 0009 (the engine is the sole SQLite
  writer) is unchanged.
- **D7 — Next usage schema version.** `delegation_jobs` enumerates `state`, `refusal_reason` and
  `result_kind` in CHECK constraints (`delegation-store.ts`), and `CREATE TABLE IF NOT EXISTS`
  cannot widen them. The job table is rebuilt, with workspace, branch, end commit, effective
  execution options and `continuationOf` columns, at the next usage version, following
  `docs/local-store-upgrade.md` (forward-only transaction, widen-only readers, stopped-stack
  backup). Coordinate the number with the ADR 0086 Jira sync branch, which takes usage version 5.
  Old requests, results and "unsupported action" decisions stay readable unchanged.
- **D8 — Honest guarantees.** Each job records the requested options, the controls applied, the
  observed evidence and the limits.
  - With a shell, network and the operator's home credentials reachable, "a code-change worker
    does not commit to the operator's branches or publish" is a cooperative boundary (instruction
    and authorization), not an enforced one. The guide and the guarantee say so.
  - Codex: `codex exec -s workspace-write -C <workspace>`; `network: allowed` maps to
    `-c sandbox_workspace_write.network_access=true`; approvals never and the current isolation
    flags are kept.
  - Claude Code: plan mode is replaced by an editing tool set (Read, Grep, Glob, Edit, Write,
    Bash), safe mode, strict empty MCP, prompts denied. `network: off` is offered only if its Bash
    sandbox proves it (P0).
- **D9 — A follow-up is a new linked job.** `continuationOf` sits beside `retryOf`. A continuation
  reuses the parent's worktree and branch, so its snapshot commit stacks on the parent's. It holds
  the workspace exclusively and is re-qualified: policy, identity, quota freshness, reserve and
  concurrency. Native resume (`codex exec resume <id>`, `claude --resume <id>`) is an execution
  aid, never the task identity. It needs the same harness, account and workspace. Another harness
  continues from the branch instead. Continuations have their own limit inside a chain budget.
  Never use `--last`.
- **D10 — Reservations across mutating actions.** Today a reservation compares action, checkout
  and SHAs (`review-reservations.ts`). Two worktree jobs on the same start SHA may run in parallel.
  `in-place` jobs conflict with every other mutating job on that checkout. Later `commit` and
  apply actions join the same mutating family.

## Out of scope (later plans)

- `commit` (on the operator's branch, under their identity, signing and hook policy) and `publish`
  (an exact repository, ref and `github.accounts` login, optionally a draft PR, refusing a moved
  ref). Both are deterministic executors without a model session.
- A diff-size threshold (`maxDiffBytes`). A check made after the fact cannot prevent the writes,
  so it would only be a result threshold; deferred until a need appears.
- Multiple Codex profiles. This needs an explicit profile identity shared by observation,
  qualification, launch and resume; profiles signed in to the same account share one quota pool.
  A shared `CODEX_SQLITE_HOME` is not adopted until it is tested.
- OpenCode and Cursor executors; an engine-owned apply or merge command.

## Lots

| Lot | Scope | Status |
| --- | --- | --- |
| P0 spikes | Disposable repositories only. (a) Codex `workspace-write` in a linked worktree: can it write the worktree's gitdir (outside its root)? Does the network override work? (b) Claude Code editing tool set with safe mode: does its Bash sandbox give a provable `network: off`? (c) Spawn descendants, then cancel, kill the engine and restart; find a quiescence proof. (d) Codex `exec resume`, which exposes neither `-s` nor `-C`: where do sandbox and cwd overrides apply on resume? | TODO |
| P1 ADR, contract, store | New ADR (D3, D5, D6, D8). Vocabulary: `code-change` executable, its `execution` block, result kind, refusal reasons. Next usage version with migration tests on disposable stores. | TODO |
| P2 workspace | Worktree and branch creation, snapshot commit after quiescence, `in-place` reservation, `delegation.cleanup`, mutating reservations (D10). | TODO |
| P3 workers | Codex and Claude Code change workers together (operator decision, 2026-10-29), on the shared spawn helper and one shared adapter contract suite; native smoke for each on a disposable repository. A harness that fails P0 is left out without holding back the other. | TODO |
| P4 edges | Policy (D2) and effective options (D1) in the qualification, the Manage › Delegation forms and the simulator. MCP and CLI: start with options, status, cleanup. Work › Delegation results: branch, stats, acceptance. Update `docs/delegation.md`. | TODO |
| P5 continuations | `continuationOf`, chain budget, native resume where P0(d) proved the options hold. | TODO |
| Review | Independent adversarial review; fix the findings with regression tests. | TODO |

## STOP conditions

- P0(a) shows a write into the canonical repository's own branches or index from a worktree
  worker: stop and report the evidence.
- P0(c) finds no quiescence proof: jobs end only on operator declaration, and the plan reports
  BLOCKED for automatic completion.
- P0(d) shows that resume drops or changes the options: P5 continues from the branch only, never
  by native resume.
- Any step would touch a real store, a real sign-in or the operator's checkout outside an
  `in-place` test on a disposable repository: stop and ask.

## Verification

Per lot: the focused package tests, `bun run check`, typecheck of the touched packages (see the
known `apps/web` tsc baseline), the shared worker contract suite, migration tests on disposable
stores, and the delegation E2E. At the end, `bun run verify` and a native smoke in both directions
(Claude Code caller → Codex worker, Codex caller → Claude Code worker) on a disposable repository:
the delegation branch carries the change, and the operator's branch and index are unchanged in
`worktree` mode.
