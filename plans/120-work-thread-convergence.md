# Work thread convergence (« Unité de travail v3 »)

Status: IN PROGRESS. Starting head `b93a364b` on local branch
`work-unit-convergence`: `work-continuity` at `7b133724` (plan 119, which
contains PR #67 at `6bf89308`) merged with `main` at `3fde5ae6`. Nothing is
pushed or merged remotely.

## Product outcome

The operator follows **Work threads** (UI: tasks), not sessions. A thread keeps
one identity from a first exploration to the end of the operator's follow-up.
Sessions, a local branch, pull requests and Jira issues are linked to it as
sourced markers. The operator's follow state — Following, Waiting, Done — is
stored durably and changed only by explicit commands. Ending a follow-up never
changes GitHub, Jira, a session, an agent or a file.

The approved reference is the v3 mock-up delivered outside the repository
(`AI-Usage-maquette-unite-travail.html` and its README). Its fixtures, clock and
simulated actions are fiction and never ship as real data.

## Contracts

- `packages/report-core/src/work-thread.ts`: follow states, intents, origins,
  qualified link keys (pull request `host/owner/repo#n`, Jira
  `jira:<site>/<KEY>`, session `session:<machine>/<harness>/<id>`, branch
  `branch:<host>/<owner>/<repo>@<ref>`), link provenance, events, and the
  idempotent operator commands with an expected revision.
- Storage: additive `work_threads`, `work_thread_links`, `work_thread_events`
  tables in the usage store, written only by the usage engine through a
  control-plane command (ADR 0009). Read through `query_only` connections.
  Collections and projection rebuilds never touch them.
- `originKey` is unique: a repeated discovery of the same pull request or Jira
  issue never creates a second thread; a detached link is never resurrected.
- Facts stay where they are (`pull_request_observations`,
  `checkout_status_observations`, `jira_issue_observations`, served sessions).

## Decisions taken in this plan (reversible)

1. The domain term is the existing **Work thread** (CONTEXT.md). The UI says
   "task". No competing vocabulary.
2. The UI stays in English like the rest of the application; the v3 French
   copy is transposed (My work, Following / Waiting / Done, What's left, End
   follow-up, Reopen).
3. A new fact after a thread is Done keeps it Done; the change is shown in the
   thread and the operator may reopen it explicitly. Provisional default.
4. Threads are created by the operator, by a discovered pull request or Jira
   issue, or from a session the operator chooses to track. Sessions are linked
   by explicit keys only; a shared checkout, time proximity or lineage never
   links one. The session attention board stays reachable as an intake, off
   the main view.

## Inventory at the starting head

| Verdict | What | Where |
| --- | --- | --- |
| Keep | Fact producers and stores: GitHub PR, checkout status, Jira (ADR 0050/0051/0054), run states | `local-collectors/src/{github-pull-requests,checkout-status,jira-issues}.ts`, `usage-store/src/work-fact-store.ts`, `usage-engine-runtime/src/source-adapters.ts` |
| Keep | Session sources for episodes: Claude Desktop registry store, Codex work observations, served session join | `usage-store/src/{claude-desktop-session-store,codex-work-store,work-session-join}.ts` |
| Keep | Review routing and attempts behind task actions (ADR 0052–0062) | `report-core/src/work-{routing,attempts,executors}.ts`, `apps/web/src/lib/features/work/work-{routing,attempts}*` |
| Keep | Bounded Work context for CLI/MCP (ADR 0058) | `report-data/src/work-context-read.ts` |
| Keep | Engine-only write path and command pattern | `usage-engine-control/src/contracts.ts`, `usage-engine-runtime/src/runtime-command-executor.ts`, `review-attempt-store.ts` |
| Adapt | PR discovery: explicit links only today; add bounded author/review-requested discovery and mergeability | `github.pull-requests` source |
| Adapt | Jira: keys from branch names only, `acli` absent here; add assigned-issue discovery, fixture-tested | `jira.issues` source |
| Adapt | Attention board (one row per session family): kept as the intake at `/work/sessions` | `work-attention-board.svelte` and friends |
| Replace | Main `/work` composition (board + bottom session list) by My work (one row per Work thread) and the task page | `apps/web/src/routes/work`, `work-page.svelte` |
| New | Work thread store, command and reader | `usage-store/src/work-thread-store.ts`, `report-data/src/work-thread-read.ts` |
| Defer | Cross-harness Claude → Codex delegation: not declared natively today (Codex roots are never folded under Desktop roots); only declared same-harness lineage nests | ADR 0059 |
| Defer | Controlled execution channel for messages to a running session; resume is a verified CLI command to copy | — |

## Lots

| Lot | Scope | Status |
| --- | --- | --- |
| A | Thread store, engine command, reader, `/work` list + detail + end/reopen, PR discovery without sessions | In progress |
| B | Local/GitHub/Jira markers, session episodes and delegations in one thread history, search | Pending |
| C | Resume: open the exact source, copy contextual continuation, waits satisfied once, close despite remainders | Pending |
| D | Independent review, visual comparison with v3, bounded real-source observation, simplification | Pending |

## Acceptance

The mandate's acceptance table applies (analysis only, same work over time, PR
without session, ticket without PR, local work left behind, distinct states,
personal closure, closure despite remainders, wait satisfied, wrong
association, lineage and duration, silent wait, real use, interface).

## Verification log
