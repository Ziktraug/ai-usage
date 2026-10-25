# 123 — Work thread convergence (« Unité de travail v3 »)

Status: DELIVERED locally (rounds 1–6; latest head recorded in the 2026-10-25
round below; not pushed). Starting head `b93a364b` on local branch
`work-unit-convergence`: `work-continuity` at `7b133724` (plan 122, then numbered 119, which
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

### 2026-10-25 — round 2: rebased on PR #67's head and main, honest thread

Starting head `9259684d`. The branch merged PR #67's head `de3c935c` (which contains
`main` at `62e84b1a`: Effect 4, SvelteKit 3, Bun 1.4, TypeScript 6, Panda 2,
Ultracite 8) at `ea8f48e9`; this plan and plan 122 were renumbered from 120 and
119 (`71cc6428`). The supervisor extended the view contract once (`b9176351`).

Gaps observed on the operator's real data (read-only copy, production build
`9259684d`) that drove the round:

- a Desktop conversation alive for three days showed "Episode span: 76 h";
- the week lane counted delegated sessions ("20" on a day);
- "Since" was the instant the product first saw a discovered pull request;
- the thread showed five "Source linked" lines and no pull request event;
- "What's left" read "The linked PR is still open" for most rows;
- a four-line source diagnostic block sat above the tasks;
- real pull request titles wrapped on four or five lines.

Decisions (reversible):

5. An episode shows its recorded turn time (`activeMs`, the union of turn
   intervals the collectors already compute) and, apart, its first-to-last span
   (`spanMs`). A span is never labelled as work time; an unknown duration stays
   unknown.
6. Dated source facts (pull request opened, merged, closed) are read from the
   source's own dates into the thread (`factEvents`); they are not stored as
   thread events and never use the observation instant.
7. "What's left" on an open pull request distinguishes unresolved review threads
   (GitHub `reviewThreads.isResolved`, counted only when complete), review
   awaited from others, draft, ready to merge, conflicts, behind the base and
   failing checks. A comment is not an unresolved thread.
8. Automatic link events (declared, origin, launched) are not thread entries;
   operator links, detaches, notes and follow-state changes are.
9. A Claude → Codex delegation is attested only by the launching Bash tool use
   of the Claude transcript (`codex exec … resume <id>` or that tool result's
   `thread.started` / `session id:`), never by a uuid seen elsewhere.

Workers (Codex CLI 0.164.0, `gpt-6-astra` verified in each rollout's
`turn_context`): W1 `01a16e12-5d9f-7d02-9865-3ff67ee17631` (xhigh), W2
`01a16e12-5ef0-7622-a5c8-b22374ed546a`, W3
`01a16e12-6070-78a2-8cfa-98c124ec50da` (resumed threads, high), W4
`01a173a3-f808-7eb2-be46-b2b88799f5ca` (new, high).

Decisions added during the round (reversible):

10. Work-only styles stay in a stylesheet the Work route imports (aliases set
    from the semantic tokens by an extracted Panda style). Panda extracts one
    stylesheet for every page, which put ~4.7 KB gzip of Work-only CSS on the
    report page's first load and broke the operator's 305,000 B ceiling; the
    ceiling was not raised.
11. Adding a nullable column without default or backfill keeps the usage store
    version when every writer names its columns and every reader maps named
    columns (ADR 0075 amendment); version 5 stays reserved for plan 120 phase B.

Rounds and integration (all on `work-unit-convergence`, local only):

- Round 2: W1 recorded time, marks, origin date, PR facts, specific next steps
  (`de3c5b9e`, `0f50ad31`); W2 PR lifecycle dates and unresolved review threads
  (`2654f62d`, `d75fb2f8`); W3 quiet source line, density, week cells, copy,
  episode wording, GitHub facts in the thread (`67da8d51`, `31c567ff`); W4
  Claude → Codex attestation producer and durability (`723f2b2e`, `8a995d6c`).
- Round 3: W1 nests attested Codex sessions under their Claude parent
  (`917e378b`); W2 observes each pull request once whatever its casing
  (`1b5e93e2`, a defect found on real data: the second GitHub cycle recorded
  12 of 17 observations invalid); W3 Panda migration and mobile/title/source
  fixes (`a51d09da`).
- Round 4, after an independent adversarial review of `71cc6428..917e378b`
  (7 findings confirmed, all fixed): resume attested only when the launch ran
  and the supervisor's real launch forms accepted (`dec323ae`, Claude cache 18);
  ready to merge only on `CLEAN` with zero known threads (`e2b888f1`); blank
  titles (`273e46ef`); fractional durations on the wire (`8f0a62f8`); lenient
  lifecycle dates (`db255d0b`); unread review threads disclosed (`667ba615`);
  snapshot export keeps delegations (`4d8144c3`).
- Round 5: report first load back under the ceiling — narrow project-group
  command parser (`9527ce27`) and route-scoped Work styles (`aedb86b9`):
  304,123 B gzip (recorded), pixel-identical at 1440–375 px, both schemes.
- Round 5 (after a second adversarial review of `917e378b..aedb86b9`, 3 of 4
  findings confirmed and fixed, the fourth rejected because `a51d09da`'s
  message body names its behaviour changes): a resume is attested only from
  the Codex command's own outcome or Codex's native id in the result, never
  through a trailing `;` command (`bf01f1ae`, Claude cache 19); a failed
  checkout read stays visible on a task (`813af865`); the engine tests serve
  the review-thread read and a runner defect stays contained to its PR
  (`91fee48f`, `c3f52929`).
- Round 6, from an independent scenario review of the real-data captures
  against the v3 references (Codex thread `01a17400-9116-7e73-a8a8-f48ea24f2376`,
  no blocking defect): merge state on the GitHub marker, "linked sessions",
  delegations bounded to five with a control, `+1d` on overnight ranges
  (`b926aeac`).

Real data, read-only, on fresh `VACUUM INTO` copies of the daily store with an
isolated engine (claude/codex launchers disabled, gh with the operator's
existing sign-in): 12 open authored pull requests became 12 tasks; the first
GitHub cycle observed 17 pull requests; the second cycle recorded 12 of them
invalid before `1b5e93e2` and none after (17 observed, 0 failed); unresolved review threads were read
for 24 observations; declared sessions linked (PR #67: 4 sessions, 27
delegated); a task created on the copy from this supervisor's session nested
its attested Codex workers with recorded time apart from span (build
`aedb86b9`, before the stricter round-5 rule). Jira stays unavailable (`acli`
not installed). Claude active time is recorded only when the transcript has
turn-duration records (79 of 400 sampled Claude rows); otherwise the episode
says "Duration not recorded" and keeps its times.

Remaining:

- Jira through `acli` (not installed); fixture-tested only.
- Running state of real sessions (no native lifecycle evidence stored).
- Claude Desktop registry titles are absent from the isolated copies (their
  home has no `.config/Claude`), so copy captures show `claude <id>` names.
- Supervisor launches written `…; echo "exit=$?"` attest only with Codex's
  native id in the tool result (round-5 rule, correctness over coverage).
- Activation on the daily store awaits the operator: back up both stores per
  `docs/local-store-upgrade.md` (Backup), then start the engine from this
  branch. The first start adds the Work thread tables and the three nullable
  pull request columns at usage version 4, and the Claude parse cache moves
  to version 19, so every Claude transcript is read again once (the known cold
  path). Rollback is the backup pair with the code revision that wrote it.

Verification at `bf01f1ae` (verification worktree, Bun 1.4.3 from `nix develop`):
`bun run verify` green (check, lint, typecheck 53/53, every package's tests:
web 1814, report-core 652, local-collectors 413, usage-store 386, local-machine
358, usage-engine-runtime 287, report-data 163, …), production build,
`bun test bundle` 5/5 (report initial gzip closure 304,122 B, ceiling
305,000 B), Playwright fixture `work-threads` + `work` + `work-e2e-fixture` +
`accessibility` 115 passed, production `work-threads-production` 1 passed,
`work-production` + `production-report` 19 passed. On a fresh real-store copy
with this build, the only attested delegation of this supervisor's session is
the one Codex resume whose result showed Codex's own thread id; the four
worker launches written `…; echo "exit=$?"` and one launch Codex refused are
not attested.
