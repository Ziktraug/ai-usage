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
| A | Thread store, engine command, reader, `/work` list + detail + end/reopen, PR discovery without sessions | Delivered and verified |
| B | Local/GitHub/Jira markers, session episodes and delegations in one thread history, search | Delivered; Jira real path unavailable (no `acli`), fixture-tested |
| C | Resume: open the exact source, copy contextual continuation, waits satisfied once, close despite remainders | Delivered; running state of real sessions stays unknown (no native lifecycle evidence stored) |
| D | Independent review, visual comparison with v3, bounded real-source observation, simplification | Two reviews; real GitHub observed read-only; plain CSS file to fold into Panda remains |

## Acceptance

The mandate's acceptance table applies (analysis only, same work over time, PR
without session, ticket without PR, local work left behind, distinct states,
personal closure, closure despite remainders, wait satisfied, wrong
association, lineage and duration, silent wait, real use, interface).

## Verification log

### 2026-10-24 — integrated slice

Workers (Codex CLI 0.163.0, model `gpt-6-astra` verified in each native
rollout): W1 store/command/reader `01a16e12-5d9f-7d02-9865-3ff67ee17631`,
W2 discovery `01a16e12-5ef0-7622-a5c8-b22374ed546a`, W3 Work view
`01a16e12-6070-78a2-8cfa-98c124ec50da`; each resumed on its own thread for
follow-ups. ADR 0063 records the durable decisions.

- `bun run verify` green at `37ad4bd5` (check, lint, typecheck, all package
  tests, build), after isolating two engine lifecycle tests that reached the
  operator's real `gh` once discovery ran with no linked pull request.
- Fixture e2e (`work-threads`, `work`, `work-e2e-fixture`): 25 passed.
- `bun run test:e2e-production`: all chained suites passed, including
  `work-threads-production.spec.ts` (real engine, disposable store, fake `gh`):
  a pull request without sessions becomes one task, ends, appears in Done,
  reopens; a second source run adds no duplicate; an analysis created from a
  session ends and reopens; a stale second tab gets a conflict; the fake `gh`
  audit shows reads only.
- Reader: 500 threads x 5 links, 100-row page, 918 ms to 31 ms median;
  20,000 served rows x 500 threads with session-title search: page query
  2,777 ms to 20 ms, complete page 151 ms median (synthetic, empty histories).
- Real source, read-only, disposable store: the product's own collectors
  discovered 10 of the operator's authored open pull requests (limit 10,
  truncated), observed all 10 with mergeability, seeded 10 threads, a second
  seed created none; the reader returned 10 rows with 0 sessions; the
  production app on that store showed them and named GitHub as
  unauthenticated for its isolated engine instead of an empty list. Discovery
  first reported unauthenticated in that environment (`gh auth status` timed
  out under the bounded environment with two stored accounts); fixed by
  reading one account token (`a3ba3a7b`).
- Not verified: Jira through `acli` (not installed); running-session state
  from real sources; Claude to Codex cross-harness delegation (not declared
  natively); the daily store (not touched).

### 2026-10-24 — after the second review

A second independent review confirmed the eleven earlier findings closed and
found four more (followed links starved by declared session links under the
collection bound; discovery re-seeding a detached key; unbounded synthetic
receipts; a detached-history omission hiding a failed source state); all four
are fixed. W1 lot 4 adds the identified-wait transition (ADR 0063).

At `78af4cf3`: `bun run verify` green at `43f316cd` (later commits change only
two e2e specs); `bun run test:e2e` 265 passed; `bun run test:e2e-production`
all chained suites passed (13, 6, 1, 1, 7, 31). `bun run demo` serves the task
view with synthetic tasks and working follow-up commands.

Remaining: running state of real sessions (needs native Codex lifecycle
evidence and a Codex cache version bump); Jira through `acli` (not installed);
cross-harness Claude to Codex delegation (not declared natively);
`apps/web/src/lib/features/work/work-threads.css` is a plain stylesheet mapped
to Panda tokens, to fold into Panda recipes; activation on the daily store
(backup, then engine start per docs/local-store-upgrade.md) awaits the
operator.
