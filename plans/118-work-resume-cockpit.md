# 118 — Work as a resume space: native outcomes, external facts, qualified routing

Status: IN PROGRESS — integration branch `feat/work-resume-cockpit` on top of PR #66
(`65f7d5c4`), started 2026-10-21 22:05 Europe/Paris. This file is the execution record;
it is updated at each integrated milestone and never rewritten after the fact.
Authorization: local implementation, isolated verification and local commits only.
No push, no merge, no real-store migration, no harness execution, no account change.

## Why this slice exists

Plan 117 delivered an observed Work list and a pure routing simulation. Reviewed at
`d590d803`, `/work` showed a chronological session list with a constant "Known waits
unavailable" line; the real routing path built candidates that were all unqualified; the
request/proposal cases existed only as projection-boundary fixtures. This slice makes a
native source cross the production path to the screen, confronts declarations with
GitHub and local facts, and lets a Claude Code route be qualified from real or
explicitly declared information.

## Lots and ownership

| Lot | Scope | Branch | Status |
| --- | --- | --- | --- |
| Contract | `packages/report-core/src/work-attention.ts`: declarations, facts, interpretations, `WorkAttentionDataset`, row parsers | `feat/work-resume-cockpit` @ `78a11d52` | DONE |
| A | Claude Desktop session registry (`claude-code-sessions/**/local_*.json`) → collector → additive usage-store table → read-only reader → `report-data` read model → `work.attention` oRPC; representative native fixture (≥ 20 roots); chain integration test | `feat/work-resume-cockpit-a-native` | IN PROGRESS |
| B | Bounded engine-side `git status --porcelain=v2` and `gh pr view` observations for known checkouts and explicitly linked PRs; additive tables; pure external-fact interpretations | `feat/work-resume-cockpit-b-facts` | IN PROGRESS |
| C | `/work` recomposed around the dataset: needs-you / waiting-on-others / leads, folded children, search and filters in the URL, detail panel, local-time dates, routing simulation attached to one root | `feat/work-resume-cockpit-c-ui` | IN PROGRESS |
| R | Declared executors (`routing.executors[]`, home-only config), observed executor availability, per-field provenance, qualification actions, real/conditional recommendation | `feat/work-resume-cockpit-r-routing` | IN PROGRESS |
| E | First read-only review attempt launched from the product (Claude Code only, isolated checkout) | — | NOT STARTED (depends on A, C, R) |

## Decisions (short; durable ones get ADRs 0050–0052)

- Native outcome facts live in additive tables under usage schema 4 (table-presence
  migration, skill-observation precedent), outside served revisions, replication and
  export; never in `row_json`.
- Interpretations are computed server-side in `report-data`; the browser renders.
- A Desktop session is a child only through an attested `spawnedFrom`; shared checkout,
  branch, title or time never fold sessions.
- Authorization for routing comes only from a persisted operator declaration; quota and
  executor availability are observations; provenance is kept per field.
- Real quota heads carry no account suffix (`account_scope` NULL), so a declaration binds
  the bare provider stream of its family and machine instead of injecting an account into
  collection.

## Verification record

To be appended per integrated milestone: commit, commands, raw results, what was proven on
synthetic native fixtures, what was tried on isolated real data, what remains unverified.

### 2026-10-21 23:35 — lot C integrated (`9aece9ba`)

Merged `feat/work-resume-cockpit-c-ui` (`937553e6` joins roots to their served Session,
`b37d920c` recomposes `/work`). Verified on the integration branch:
`TZ=UTC bun run --cwd apps/web test` → 1498 pass, 0 fail (241 files). Worker-side evidence at
`b37d920c`: `work.spec.ts` 6/6 on the synthetic dataset (desktop arrival, search, detail, back
keeps filters and focus, keyboard, 390 px drawer, 768/1279 px), accessibility + navigation +
shell e2e 43/43, bundle budget 4/4, svelte-check 0 errors. Not verified: the live
`work.attention` path (contract lands with lot A; `resolveWorkAttentionClient` returns a typed
unavailable client until then), visual-regression suite (no `/work` snapshot exists),
`test:e2e-demo`, `test:web-production`.

### 2026-10-22 00:05 — lots R and B integrated (`b131466a`, `60418a91`)

Lot R (`764514fe`…`75476539`, ADR 0052): `routing.executors[]` declarations in the home config,
`executors.capabilities` source (15 min, CLI metadata only), `executor_observations` table,
`qualifyReviewCandidates` with per-field provenance and qualification actions, `workRouting.context`
procedure, routing panel. Worker evidence: 62 routing tests incl. the acceptance grid; isolated real
smoke: both CLIs observed signed in, real quota read through `ai-usage quota --stored --json` (bare
`claude`/`codex` keys), an example declaration with `model: 'Fable'` makes the Claude route a
real recommendation; nothing written to the operator's config.
Lot B (`4874c28b`…`220ab209`, ADR 0051): shared bounded process runner, `checkouts.status` (5 min)
and `github.pull-requests` (10 min) sources, `pull_request_observations` /
`checkout_status_observations` / `work_fact_run_state` tables, pure external-fact interpretations.
Worker evidence: fixture suites plus an isolated real smoke (PR #66 observed OPEN with failing checks,
six checkouts observed, unknown PR → not-found) into a disposable store.
Integration: thirteen append conflicts between R and B resolved keeping both sides (source catalogue
order `executors.capabilities`, `checkouts.status`, `github.pull-requests`). Verified at `60418a91`:
`bun run typecheck` 58/58, `bun run lint` clean, source-control / migration / machine-config /
source-adapters / package-boundary tests 115 pass. Broad test gates recorded below when complete.

### 2026-10-22 01:05 — lot A integrated (`d060ae35`)

Lot A (`b0eb57c0`…`5b0e425f`, ADR 0050): Claude Desktop session registry collector
(`claude.desktop-sessions`, 60 s, runs never wake a publication), additive tables
`claude_desktop_sessions` / `claude_desktop_collection_state`, bounded Session join on the
current served revision, pure `interpretWorkRoot`, `queryWorkAttention` in report-data, the
`work.attention` procedure, the representative native fixture (24 roots, 17 children) and the chain
integration test. Worker evidence: package suites green, isolated read-only smoke over the real
registry (70 files parsed, 0 unsupported, 16 blocked / 28 completed / 9 review_ready, 46 roots / 24
children folded). Integration: twenty append conflicts resolved; two files whose functions and tests
git had interleaved (`source-adapters.ts`, `migration.test.ts`) were rebuilt from the integrated
version plus A's blocks. Verified at `d060ae35`: `bun run typecheck` 58/58, `bun run lint` clean,
report-core / report-data / web-contract / usage-engine-runtime / usage-store store suites 782 pass,
web rpc + work suites 275 pass. Still unverified on the integrated branch: the live `work.attention`
path end to end in a browser (client seam not yet wired), the production e2e runtime with the Desktop
fixture, the full `verify` gate.

### 2026-10-22 02:10 — lots I and E2E integrated (`ec94962b`, `170ae9bc`)

Lot I (`4e2ecfd9`…`ba3f41ed`): the `checkouts.status` and `github.pull-requests` sources now read
the checkouts and declared pull requests of Desktop sessions active in the last 14 days (served
sources and injected seams kept); `queryWorkAttention` attaches observed pull-request facts to the
root families that declared them (exact host/repository/number, same machine) and checkout facts by
exact path, keeps a failed read beside the last successful one, names shared checkouts, truncates by
priority with a visible notice, and fills `coverage.pullRequests` / `coverage.checkouts` from the
producers' run states; `request-satisfied-elsewhere` may now rest on a GitHub observation of a PR
the family declared; one implementation of `external-review-pending` (lot B's) remains.
Lot E2E (`f74ee208`…`03f8067f`): the production e2e fixture seeds the representative Desktop
registry; `work-production.spec.ts` proves the chain in a browser on `bun run start` (native files →
engine source → store → read model → `POST /rpc/work/attention` → UI: 21 roots, declared question,
folded children, detail, routing panel, `/sources` row, axe, 390 px); `work-e2e-fixture.spec.ts`
proves the e2e-mode path through the real `assembleWorkAttention`. It also found and fixed a blocking
defect: `work.attention` and `workRouting.context` were missing from the RPC request-policy
allow-list, so the procedures answered 404 before any handler (`fe0dd794`); without the production
spec, `/work` would never have read a declaration in a browser.
Verified at `170ae9bc`: `bun run typecheck` 58/58, `bun run lint`, `bun run check` clean,
`bun run --cwd apps/web test` 1519 pass, report-core/report-data/usage-engine-runtime 698 pass.
Worker evidence at `03f8067f` (before lot I): production specs 17/17, default-config specs 50/50,
campaign-map production scale 5/5. The production and e2e specs are being re-run on `170ae9bc`
because observed pull-request facts now move roots into "Waiting on others".

Gate at `170ae9bc` (run after the merges above): `bun run verify` PASS in 266 s (check, lint,
typecheck, tests, build); `bun test packages/usage-store` 249 pass, 0 fail. The earlier single
failure of `aligns heartbeats of rows going idle…` (5.5 s under parallel gates) did not recur and
passes alone in 3 s: timing-sensitive under CPU contention, not a regression of this slice.

### 2026-10-22 02:50 — observed facts proven in the browser; first independent review

`84babac8` (merged as `216f726f`): the production spec now waits for the fact producers and proves
observed GitHub and checkout facts on the production path (fake `gh pr view` and real `git status`
on the registry's checkouts → store → read model → UI): four sections (4 / 3 / 1 / 13), coverage
"Pull requests: 4 observed · Checkouts: 1 observed", "Waiting on others" rows with review-required
chips, local-checkout facts in the detail; production 17/17, default-config 50/50.
Defect found there: at engine start `checkouts.status` and `github.pull-requests` run before the
first Desktop import and read an empty registry until their 5/10-minute cadence; the spec works
around it with the operator run-now command until the engine wakes the producers itself.
Independent Claude review at `170ae9bc` (verdict: partial, record in the campaign state): four P1
findings on interpretation and presentation — a declared question could be reclassified as
satisfied by any pull request of its family including the root's own checkout mirror; the 30-day
window hid older questions without saying so; the "Recent, nothing pending" label asserted an
absence that was not observed; worktree sessions took the worktree name as project — plus P2 items
(executor probe outside the shared bounded runner, declared-PR chip dated by file mtime, missing
export/replication exclusion tests for two families, stale comment, repeated "auto title" marker,
merged PRs re-observed). A fix lot addresses them before the next gate.

### 2026-10-22 03:20 — lot J integrated (`ab5d61ff`)

Lot J (`b4be56a5`, ADR 0054): Jira issue facts for explicitly linked keys only (keys written in
branches: `writtenBranches`, Desktop `branch`/`sourceBranch`, declared PR branches; never titles
or bare numbers; `<PROJ>-0` ignored), read through the operator's Atlassian CLI session
(`acli jira workitem view <KEY> --json`, a documented assumption: the CLI is not installed on this
machine, so nothing live was exercised), additive `jira_issue_observations` table, `jira.issues`
source (10 min, not detected without `acli`), `jira-reply-arrived` (a reply after the family's last
activity → needs you, "you may have read them in Jira; this view cannot tell") and
`jira-status-differs` interpretations, coverage.jira, row chip and detail facts. Verified at
`ab5d61ff`: `bun run typecheck` 58/58, lint and check clean, package suites 1258 pass, web 1524 pass.

Gate at `216f726f` (before lot J): `bun run test:e2e` (default Playwright suite, including the visual
regression specs) 248 passed in 2.1 min; no snapshot changed.

### 2026-10-22 03:50 — review fixes integrated (`7e6aa072`, fast-forward of lot F with lot J merged)

Lot F (`c89627c7`…`7e6aa072`) answers the first review: a declared question is never closed by a
later pull request — the root stays "needs you", ranks last with a "possibly answered · PR #n" chip
when a child session declared the PR after the question or GitHub shows it merged after it, and the
root's own `prs[]` never counts; the activity window never hides a pending request and
`coverage.window` reports how many older roots without pending declarations are hidden; the fourth
section is "Recent · no pending declaration read" and a blocked declaration without a question says
so; a worktree root is labelled by its origin project; the executor probe runs through the shared
bounded runner with an environment allow-list and records `authMethod`, and a fresh API-key sign-in
contradicts a declared subscription; declared-PR chips are dated "listed", observed facts "observed";
isolation from served rows, export and replication is now tested for all four auxiliary families;
merged pull requests are not re-observed; the catalogue places the Desktop registry before the fact
producers and a Desktop run that inserted rows wakes them once (real-scheduler integration test),
which removes the empty first cycle found by the production spec. Verified at `7e6aa072`: `bun run
check` and `lint` clean, `bun run --cwd apps/web test` 1530 pass; worker evidence: typecheck 58/58,
package suites 1233 pass. The e2e specs encode the previous texts and counts and are being realigned.
