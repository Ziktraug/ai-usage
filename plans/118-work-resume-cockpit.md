# 118 — Work as a resume space: native outcomes, external facts, qualified routing

Status: DONE locally at `a7fd4905` (integration branch `feat/work-resume-cockpit` on top of PR #66
`65f7d5c4`), 2026-10-22 07:20 Europe/Paris. Not pushed; no PR opened; no real store migrated. Jira
stays contract-only (the Atlassian CLI is absent on the build machine); the first execution was
exercised once for real through the launcher alone. This file is the execution record; it is
updated at each integrated milestone and never rewritten after the fact.
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
| M | Routing qualification made usable and truthful: observed account fingerprint and its pin, alternate models of one account, window-by-window quota, engine `qualify-review-routing` behind `workRouting.qualify`, short qualification path in the routing panel (ADR 0057) | `feat/work-resume-cockpit-m-routing` | DONE, integrated (`599fa303`) |
| K | Review attempt defects (ADR 0055): a lost attempt keeps its reservation until process evidence or a late outcome releases it; the review gets one commit's bounded patch; the launch excludes every settings source, runs in safe mode and records its guarantee | `feat/work-resume-cockpit-k-review` | DONE, integrated (`516617cf`) |
| L | Resolved waits on `/work`: a bounded declaration history and `latestUserFrameAt` in the usage store, native answers, handled and superseded requests and offers (ADR 0056), pending sessions kept beyond the read bound, request → context → decision → next action rows, honest search coverage | `feat/work-resume-cockpit-l-resume` | DONE, integrated (`9bbbd9fa`) |
| N | Work context for harness sessions (ADR 0058): one bounded read-only projection of the Work attention read per checkout or project label (waits, settled decisions with evidence, linked facts, coverage), as `ai-usage work context` and the local MCP tool `work.context`; no registration | `feat/work-resume-cockpit-n-context` | DONE, integrated (`03439fd9`) |
| C (Codex) | Native Codex sessions on `/work` (ADR 0059): one root per recent served Codex campaign, attention `not-observable` (never a derived request or wait, never folded under a Desktop root), checkout facts by exact path, ranked after every Desktop root, a section and a per-harness coverage line of their own | `feat/work-resume-cockpit-c-codex` | DONE, integrated (`c58df3e2`) |

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

### 2026-10-22 04:35 — lot E integrated (`562178bb`)

Lot E (`71585abf`…`3aae0a20`, ADR 0053): the first execution launched by the product. An attempt is
a row in the additive `review_attempts` table (identity, target, checkout, declaration snapshot,
state, timestamps, pid, native session id, bounded result excerpt, executed validations, acceptance);
the engine command `start-review-attempt` re-decides at launch (a `routing.executors[]` declaration,
a checkout equal to or under a declared `routing.reviewTargets` entry, a recomputed real
recommendation, an observed available executor; Codex refused), spawns `claude -p` in plan mode with
read-only tools, `--max-turns 8`, a 10-minute timeout, a 2 MiB output cap and a 15-second heartbeat,
and records starting/running/finished/failed; one live attempt per idempotency key (a second request
returns it), live rows become `lost` at engine start or shutdown and are never relaunched. The Work
routing panel gains an "Execution" section and an attempts list where the result, the executed
validations and the human acceptance stay distinct. Proof: unit suites, an opt-in production spec
with a fake `claude` (click → attempt → finished → reused on repeat → survives reload → axe), and
one real launch of the launcher alone (`claude` 2.1.306, subscription sign-in) against a finished
campaign worktree: finished, native session id captured, 2 704-character excerpt, 40 s, target
checkout unchanged. Integration: five append conflicts (README sections 8/9, ADR index, upgrade
notes, store exports), E's observation fixtures gained lot F's `authMethod` field and the API-key
helper tolerates an absent method. Verified at `562178bb`: typecheck 58/58, check clean, package
suites 1347 pass, web 1547 pass.

### 2026-10-22 05:15 — gate at `562178bb` and final e2e realignment

`bun run verify` PASS in 299 s and the package suites 1879 pass, 0 fail, on the committed tree at
`562178bb` (lot E). The third e2e pass (`cacf1805`) realigns the browser proofs with the review
fixes, the Jira facts and the activity window, and removes the run-now workaround: wide events on the
production runtime show `claude.desktop-sessions` (41 files) running first, then `checkouts.status`
(2 inputs) and `github.pull-requests` (3 inputs) within 600 ms, without any operator command.
Worker evidence at `cacf1805` on `e77f3a29`: production 17/17, default-config 51/51. The suites are
run again on the merged head below.

### 2026-10-22 05:45 — final gates on the integrated head

At `5cb0d8e3` in a detached gate worktree: production suite (`work-production.spec.ts` +
`production-report.spec.ts`) 17/17, review attempt production spec 1/1 with
`AI_USAGE_WORK_ATTEMPT_E2E=1`, `bun run test:web-production` PASS (both port-collision checks clean).
The default suite reported 249 passed and one failure that was the production-only attempt spec
picked up by the default config; `d5db87b7` excludes it there and makes it skip itself without its
flag. The default suite is rerun at `d5db87b7` below.

At `d5db87b7` (detached gate worktree): `bun run test:e2e` 249 passed, 0 failed (2.0 min). With the
production suite (17/17), the opt-in attempt spec (1/1) and `test:web-production` at `5cb0d8e3`,
every gate of this slice is green on the integrated head. A second independent review (campaign
state, `REVIEW-2.md`) found the first execution safe under probing and kept two P1 findings: the
project label of a joined worktree root still reads the worktree name, and the Jira "reply arrived"
rule is computed per session family rather than per key; a last fix lot addresses them with the
remaining P2 items before the slice is frozen.

### 2026-10-22 07:05 — second review fixes integrated (`a7fd4905`)

Lot G (`f02e251e`…`64763c65`) answers the second review: every root is labelled by its origin
project directory and a differing served label is carried apart as "report project"; a Jira reply
is dated against the latest activity on its key across all families, only the most recent family
is asked, older ones read "reply elsewhere"; a child's pull request listing that mirrors the
root's checkout (same worktree or a PR the root lists itself) never reconsiders a question; a
child's listing is dated by its activity, not its file time; the launcher refuses a relative
`AI_USAGE_CLAUDE_EXECUTABLE`, runs with `--strict-mcp-config` and also disallows Agent, Task,
TodoWrite and Skill (operator and checkout hooks remain a documented limit); a review target
resolves only from the Desktop row of its own transcript; isolation tests now cover
`review_attempts` and `jira_issue_observations`; an attempt steps to `starting` from `requested`
only; the production-only attempt spec is excluded by the production config unless its flag is set
(the earlier `test.skip` broke `bun run check`). Fixture: the two children whose declarations prove
"possibly answered" and "declared before the question" now live in their own worktrees, as the
rule requires. Worker evidence: typecheck 58/58, lint and check clean, web 1547 pass, packages
1271 pass, production 17/17, attempt 1/1, default-config 51/51. The complete gate runs again on
the merged head below.

### 2026-10-22 07:20 — complete gate on the frozen head (`a7fd4905`, detached gate worktree)

`bun run verify` PASS (323 s); package suites 1886 pass, 0 fail; `bun run test:e2e` 249 passed
(1.6 min, visual snapshots unchanged); production suite 17/17; opt-in review attempt spec 1/1;
`bun run test:web-production` PASS. The slice is frozen at this head.

### 2026-10-22 10:05 — lot M on its worker branch (`9d799429`, `5b54f198`, base `759daec1`)

Lot M (ADR 0057): `claude auth status` already printed `orgId` and `email`; the collector now keeps
only a 16-hex domain-separated SHA-256 of them (`accountFingerprint`, additive column), and
`routing.executors[]` may pin it and declare `alternateModels`. Qualification states the identity
per field (`confirmed`, `contradicted`, `unpinned`, `unobserved`, `not-observable`); an unpinned
route whose CLI reports an account is conditional on the pin, a changed account invalidates a
pinned one. Found and fixed: a provider read `partial` because the Fable window was blocked
excluded every model of the account; `weekly_opus` windows never matched a declared Opus. The
engine command `qualify-review-routing` (behind `workRouting.qualify`, registered in the
request-policy allow-list) runs `executors.capabilities` now, re-reads declarations and quota and
answers the launch policy's decision; the routing panel shows detected / declared / target /
missing once per machine and a "Qualify now with the engine" action whose answer feeds the gate.
Verification: `bun run typecheck` 58/58, `bun run lint` and `bun run check` clean; report-core
513, local-collectors 260, local-machine 217, usage-store 261, usage-engine-control 62,
usage-engine-runtime 217, web-contract 93, apps/web unit 1556 pass, 0 fail; production specs
`work-production.spec.ts` 4/4 and opt-in `work-attempt-production.spec.ts` 1/1. Browser check on
the production fixture (disposable HOME, fake `claude`): four clicks, four POSTs to
`/rpc/workRouting/qualify`, a new executor observation each time; no identity → real; identity
reported → conditional on the pin; pinned with Fable then Opus → real, launch gate open, axe 0;
account switched → contradicted, gate closed. Not done here: the launch still resolves the
declaration by its primary id and launches `declaration.model` (lot K files; diff in the worker
report); the operator's real unpinned declaration will read conditional until pinned.

### 2026-10-22 10:06 — lot K: review attempt reservation, scope and hook guarantee (ADR 0055)

From base `759daec1`, on `feat/work-resume-cockpit-k-review`. Three statically found defects,
each reproduced by a test before the fix. A: a `lost` row now keeps the identity's reservation
(new partial unique index over live and unreleased lost rows, old index dropped, first-version
lost rows released as `recorded-before-reservations`); the engine records a UUID before the spawn
and passes it as `--session-id`, then looks for it in `/proc/*/cmdline`; a release names
`process-absent` or `outcome-recorded-late`; otherwise `attempt-unresolved`. Tests: a double click
and a second client launch once; a restart with the fake process alive refuses and leaves the
process running; a late heartbeat changes nothing; a late result is recorded and releases; no
readable process table keeps it held; two store connections race into one row. B: the scope is
`HEAD` resolved once, diffed against the first parent or the empty tree with `git diff-tree` and
safe options, cut to 64 KiB / 2 000 lines with per-file coverage, hashed, stored; merge, root,
rename, deletion, binary, dirty tree, truncation, moved `HEAD`, empty and oversized commits and a
repository-configured diff driver are covered. C: `--setting-sources ""`, `--safe-mode`,
`--tools Read Grep Glob`; the CLI is qualified from `--version` and `--help`; managed settings are
declared; a fake that loads settings like the CLI proves a checkout `PreToolUse`/`SessionStart`
hook does not run under the launch argv and does without it. One real probe (`claude` 2.1.306,
`--model opus`, `--max-turns 1`, disposable two-commit repository): the full argv was accepted
under the subscription sign-in, the init session id equalled the engine's `--session-id`, the run
ended `error_max_turns`, the repository stayed unchanged. The probe's hook fixture was not run:
writing a `.claude/settings.json` hook file was refused by the permission system. D: shutdown
records the stop with the partial output; no product stop command (it needs `work-routing.svelte`).
Bundle: attempt states and refusal reasons moved to the import-free
`work-attempts-vocabulary.ts`; the first-load gzip closure went from 312 370 B to 305 459 B.
The attempt's guarantee also records the launched `--model` and `--effort`, so the per-candidate
model of lot M is a one-line swap in `launchFor`. Verified on the branch: `bun run typecheck`
58/58, `bun run check` and `bun run lint` clean; package suites report-core 482, usage-store 264,
local-collectors 272, usage-engine-runtime 217, usage-engine-control 61, web-contract 81 pass
(one unrelated `index.test.ts` heartbeat test timed out once under load and passes alone); web
1551 pass; opt-in production attempt spec 1/1 under `nix develop` (Bun 1.3.13); bundle closure
305 459 B (the branch keeps the base's 305 000 B ceiling, so `test:web-bundle` reports the ceiling
until it meets the integration head's).

### 2026-10-22 10:20 — lot L: resolved waits, honest coverage (`375427a5`, `6dc6b3db`, `8b2691cf`, lot branch)

Native facts checked read-only on the operator's registry (75 files): only the latest
`postTurnSummary` is kept per file and the transcript holds no summary history, so the usage store
now records a bounded declaration history (`claude_desktop_turn_declarations`, 8 per session) and
`latestUserFrameAt` (new nullable column), additively under `user_version` 4 (ADR 0056). A message
recorded after a question answers it without a confirmation in the product; an earlier question a
later turn replaced reads as answered (dated, with its facts) while the new one stays the current
request; a session started from the root after the question and completed handles it; work
continued there without completion makes it an older declaration to reconsider, listed apart; an
unrelated pull request still resolves nothing; offers past their native expiry or followed by a
later message are no longer pending. No transcript is read. The Work read keeps sessions that may
carry a wait (a request, a declared pull request) beyond its 500-session recency page and fetches
missing parents; the search status says what a filter did not search. Rows and the detail read
request → context → last decision → next action. Evidence: typecheck 58/58, `bun run lint` and
`bun run check` clean; report-core 501, report-data 68 (incl. a 504-session store with the oldest
roots pending), usage-store 265, usage-engine-runtime 213 (incl. a two-sweep collector → store →
read chain), local-collectors 259, local-machine 216, web unit 1556 pass, 0 fail; e2e `work.spec.ts`
+ `work-e2e-fixture.spec.ts` 11/11; production `work-production.spec.ts` 5/5 under `nix develop`.
Not done here: exact "N of S sessions read" counts need the wire mirrors (patch handed to the
integrator); the hydration double read of `work.attention` comes from the shared `collection-swr`
policy (`refetchOnMount: 'always'`), reported with its fix. Visual snapshot references untouched.

### 2026-10-22 10:20 — lot M integrated (`599fa303`)

`599fa303` merges lot M (`9d799429`…`c9ff29fc`) with `--no-ff`, no conflict. Checked against the
code before merging: the diff reads no credential file (the only `auth.json` mention is ADR 0057's
rejected alternative), the store keeps the 16-hex fingerprint only, the five identity states, the
Fable-exhausted/Opus-real case, the exhausted all-models window and the shared quota reading of
`alternateModels` candidates are tested, `workRouting.qualify` is in the allow-list (45/49), and
the panel names the exact `"accountFingerprint": "<16 hex>"` to add. Integration commits:
README section 7 documents `alternateModels` and `accountFingerprint`, the upgrade notes record the
`account_fingerprint` column (`07689000`); `test:e2e-production` now also runs
`work-production.spec.ts` and, in its own invocation with `AI_USAGE_WORK_ATTEMPT_E2E=1`,
`work-attempt-production.spec.ts`, so CI's existing step covers both (`b83699f0`); `.agent-bin/`
is ignored (`2c08135e`). Verified on the merged tree: `bun run check` 1608 files clean;
`bun run typecheck` PASS (turbo `check` 58/58 with `--force`, 0 cached); local-collectors 260,
local-machine 217, report-core 513, usage-engine-control 62, usage-engine-runtime 217, usage-store
261, web-contract 93 pass, 0 fail (system Bun 1.4.2); under `nix develop` (Bun 1.3.13) web unit
1556 pass, production build PASS, `work-production.spec.ts` 4/4, opt-in
`work-attempt-production.spec.ts` 1/1. Not run here: lint, the tools suite, `test:e2e`, the full
`test:e2e-production` script and `test:web-production`; the launch still resolves the declaration
by its primary id and launches `declaration.model` until lot K's files are swapped.

### 2026-10-22 10:45 — lots M and K integrated (`516617cf`)

`516617cf` merges lot K (`a4aebf55`, `9009fffe`) with `--no-ff`. Checked against the code first:
the reservation (double click, second client, restart with the process alive, late heartbeat, late
result, no process table), the scope (first parent or empty tree, 64 KiB / 2 000 lines, SHA-256,
moved `HEAD`, empty, binary-only, over 8 MiB) and the guarantee (`--setting-sources ""`,
`--safe-mode`, `--tools Read Grep Glob`, `--version`/`--help` qualification, managed settings) are
tested; the engine only terminates processes it holds a handle to and never signals a scanned pid.
Not tested: the non-UTF-8 refusal (`not-text` is mapped from any bounded-runner `failed`, which also
covers a git killed by a signal). Conflicts: the control contract keeps K's vocabulary imports and
M's qualification parser; the usage-store migration keeps M's `account_fingerprint` and K's
`migrateReviewAttemptSchema`; K's recorded bundle value; both plan rows and records. Integration
commits: an alternate-model candidate is resolved with `declarationForReviewCandidate`, launched
with its own model and served with it (`49a651c0`, engine, policy and wire tests); M's parser had
put the routing policy back in the first load (313 709 B), so the transported qualification moved
to the import-light `report-core/work-routing-vocabulary` (`348969d6`); the first load measures
305 759 B, the ceiling returns to 310 000 B (`45aa7a2b`); ADR 0055 indexed, 0053 marked amended,
upgrade notes for the `review_attempts` columns and index swap (`fcb9adad`). Verified at
`fcb9adad`: `bun run check` 1614 files clean, `bun run lint` PASS, `bun run typecheck` 58/58;
report-core 518, usage-store 265, usage-engine-runtime 223, usage-engine-control 62,
local-collectors 273, web-contract 93 pass, 0 fail; under `nix develop`: web unit 1560 pass, build
PASS, `test:web-bundle` 4/4, `work-production.spec.ts` 4/4 (three runs; one printed an engine
`startup-failure` diagnostic after the last test), opt-in `work-attempt-production.spec.ts` 1/1.
Not run: the real hook probe (steps for the operator in the integrator's notes), the full gate.

### 2026-10-22 11:40 — lots M, K and L integrated; gate at `efd2a9bc`

`9bbbd9fa` merges lot L (`375427a5`…`ddacf360`) with `--no-ff`; conflicts only in the ADR index
(0055, 0056, 0057 kept in order) and this plan. Checked against the code first: the additive
`claude_desktop_turn_declarations` table (at most 8 declarations per session) and the nullable
`latest_user_frame_at` column migrate by presence under `user_version` 4 with a migration test;
the answered, superseded, unrelated-PR, expired-proposal, completed-child and continued-work cases
and the second bounded page of wait-carrying sessions and missing parents are tested; the diff
reads no transcript. The UI says "Answered in Claude Desktop" / "You answered in Claude Desktop"
and "no longer asked", never approved or authorized, with the note that the message itself is not
read. Integration commits: lot L's prepared patches, reviewed: the read counts the stored sessions
it left out ("N of S stored sessions read", `aa1b7cf9`), CONTEXT.md and the upgrade notes
(`1ba25637`, reflowed, older-binary sentence corrected, ADR 0050 marked amended by 0056); the
Work attention dataset gets its own `collection-facts-swr` policy, refetching on mount only when
stale, so a server-rendered page load reads it once (`efd2a9bc`, unit test plus the e2e fixture
spec asserting no browser re-read; the production spec allows one, its server clock is pinned).

Gate in the detached gate worktree at `efd2a9bc` under `nix develop` (Bun 1.3.13): frozen install;
`bun run check` 1616 files clean; `bun run lint` PASS; `bun run typecheck` PASS (turbo `check`
58/58 with `--force`, 59 s); package suites 56 turbo tasks, 2 715 pass, 0 fail (203 s); web unit
1 570 pass (62 s); tools 145 pass (205 s); build PASS (30 s); client manifest PASS,
`test:web-bundle` 4/4, first load 305 823 B (recorded 305 759, ceiling 310 000);
`bun run test:e2e` through the retry wrapper 251 passed, no retry (120 s);
`bun run test:web-production` PASS (41 s); `bun run test:e2e-production` (now with the Work
specs): production report 13/13, `work-production.spec.ts` 5/5, opt-in
`work-attempt-production.spec.ts` 1/1, session scroll and campaign map 7/7; its campaign
continuity step first hit port 4178 held by another session's run, then measured 30/31, 30/31
and 31/31 (one different test each time: a Session drawer `getResponseBody` protocol error, a
500 on `/rpc/campaign/labelOverrides`; both pass alone; the base `3402c046` passed 31/31 once
under the same load). Not verified: the real hook probe (operator steps prepared), CI on this
head, and whether the two continuity failures are load-only flakes.

### 2026-10-22 13:05 — independent review fixes; gate at `28467583`

An adversarial review of `3402c046..7c6c1b55` (P0 0, P1 4, P2 9) was checked against the code and
its four P1 and four cheap P2 findings fixed test-first, one commit each. P1-1 (`b735df70`): in a
blobless partial clone the scope fetched the base blob, wrote a pack and started maintenance; every
scope and checkout-status git call now runs with `GIT_NO_LAZY_FETCH=1`, `maintenance.auto=false`
and `gc.auto=0`, and a missing blob refuses the scope as `blob-not-local` (real
`--filter=blob:none` clone, object store unchanged). P1-2 (`338a1404`): a reservation without a
launch marker or without `/proc` was held forever; the scan falls back to `ps -axww`, claims an
absence only when it sees the engine itself, and "Declare the review ended"
(`release-review-reservation`, `workAttempts.release`, request policy 46/50) releases with
`process-absent` or `operator-declared-ended`, never over a process still carrying the marker; the
table is rebuilt once for the new evidence. P1-3 (`049ea67f`): only a session started from the
root closes its request; a completed report keeps it to reconsider. P1-4 (`b050502e`): the probe,
the qualification and the launch share `claudeCommandFor` (executable and `CLAUDE_CONFIG_DIR`), and
a pinned route is re-probed at start (`identity-changed`). P2s: a git killed by a signal is no
longer `not-text` and a dirty non-UTF-8 name no longer refuses a clean commit (`e1c1aecd`); a NUL
patch is refused before spawn and failure reasons never quote the prompt (`54594926`); an
unmigrated store reads as typed `schema-too-old` (`349563ee`); ADR 0012 names
`collection-facts-swr` (`28467583`). Left for follow-up as directed: git status filter drivers,
the patch in argv, Windows managed settings, started proposals; the PID-namespace case is closed
only where the engine cannot see itself.

Gate in the detached gate worktree at `28467583` under `nix develop` (Bun 1.3.13): frozen install;
`bun run check` 1618 files clean; `bun run lint` PASS; typecheck PASS (turbo `check` 58/58 with
`--force`); package suites 56 tasks, 2 736 pass, 0 fail (223 s); web unit 1 575 pass (55 s); build
PASS; client manifest PASS; `test:web-bundle` 4/4, first load 305 868 B; `bun run test:e2e` through
the retry wrapper 251 passed, no retry (130 s); `bun run test:e2e-production` PASS (364 s):
production report 13/13, `work-production.spec.ts` 5/5, `work-attempt-production.spec.ts` 1/1,
session scroll and campaign map 7/7, campaign continuity 31/31. Not run: `test:tools` and
`test:web-production` (nothing they cover changed), the real hook probe, CI on this head.

### 2026-10-22 13:55 — lot N: Work context for harness sessions (`4d238986`, `f34566fb`, `b58e0ef0`, lot branch)

`@ai-usage/report-data/work-context-read` projects the one `queryWorkAttention` read (widest page)
onto a checkout path (that path or inside it, compared as written) or a project label (exact):
`waiting` (human requests and external waits with the session's declaration, date and registry
provenance), `decisions` (the five ADR 0056 settled kinds, newest first, evidence resolved to kind,
date and provenance), `linked` (pull request, checkout and Jira facts) and `coverage` (the Work read's
own coverage plus fixed notes: Claude Desktop sessions only, no transcript, declared links only,
activity window, literal paths). Reports, wrap-ups, notes and proposals are cited by id only. Count
bounds per list and a 64 KiB ceiling on the compact JSON, cut from the least urgent list, counted in
`truncation`. `ai-usage work context` and the MCP tool `work.context` (existing local stdio server,
read-only annotations, one scope, sanitized codes) call the same `readWorkContext`; a missing store
is a typed failure, never an empty answer; nothing is registered (ADR 0058). Evidence: report-data
76 pass (8 new, two sweeps of the representative registry, scopes, prefix-sharing sibling, bounds,
typed failures; two mutations of the scope and attention filters caught), mcp-adapter 12 pass (4 new,
through the in-memory MCP client), apps/mcp 2 pass, CLI 115 pass (3 new, incl. a sandboxed process
reading a seeded store with its bytes unchanged and no engine); typecheck 58/58; `bun run check` 1622
files clean. `bun run lint` fails only on the two CLI imports of `report-data/work-context-read`
until `tools/check-package-boundaries.ts` allows them (patch handed to the integrator; the patched
checker passes on this branch). Stdio trial, generative-free: lot V's fixture profile store copied to
the lot's `.agent-memory`, read by `bun run mcp` through a scripted JSON-RPC client; as copied (built
at `3402c046`) it answered the typed `store-not-upgraded`; after this head's engine upgraded the copy
(`machine set-label`, isolated home), `work.context` returned 23 roots in scope, 8 waits, 3 declared
pull requests, 4 checkout statuses and 0 decisions (one sweep cannot date a reply), store bytes
unchanged. Not done: real data, Codex sessions (not represented by design), `bun.lock` lines for the
two new `apps/mcp` dependencies, `docs/public-package-interfaces.md` and
`docs/memory-search-and-mcp.md` (out of the lot's scope; handed over).

### 2026-10-22 13:50 — lot N integrated (`03439fd9`)

`03439fd9` merges lot N (`4d238986`…`e0998f3d`, ADR 0058) with `--no-ff`, no conflict. Checked
against the code first: `readWorkContext` runs the one `queryWorkAttention` read through the
`query_only` reader and starts no engine (the CLI test hashes the store bytes and finds no WAL,
lock or rendezvous); every list has a count bound and the encoding a 64 KiB ceiling; turn reports,
notes and proposals are cited by id and date only (a sentinel test); failures are typed and
path-free; the coverage always carries "Only Claude Desktop sessions are represented"; nothing is
registered with a harness (`mcp:register:codex` stays opt-in). Integration commits: the package
boundary guard allows the CLI `@ai-usage/report-data/work-context-read`, whose closure is
report-core, `usage-store/reader` and effect (`3119fa06`, guard test extended); the lockfile,
regenerated with Bun 1.3.13, records apps/mcp's `report-data` and `usage-store` and drops a stale
`local-collectors` entry for apps/web that its package.json no longer declares (`58c23b0d`);
public-package-interfaces and memory-search-and-mcp name the facade and the conditional
`work.context` tool (`69810b35`). Verified: `bun run check` 1622 files clean, `bun run lint` rc 0,
`bun run typecheck` 58/58; report-data 76, mcp-adapter 12, apps/mcp 2, apps/cli 115 pass, 0 fail;
`bun run test:tools` 145 pass (197 s, Bun 1.3.13). The full gate waits for lot C.
### 2026-10-22 14:00 — lot C (Codex): Codex sessions on `/work`, wait not observable (`a422f61e`, base `d820c2f8`)

Native census (read only, counts and key names, `~/.codex/sessions`, newest 80/400/1 500 of 4 989
rollouts): `session_meta` gives `cwd`, `git.{branch,repository_url,commit_hash}`,
`parent_thread_id`, `thread_source`; no approval request is persisted (approvals go to
`guardian_review` sessions, 189 of 400 rollouts); the only person-facing request is the
`request_user_input_async` tool call (51 in 1 500, output an immediate `{"accepted"}`, answered
later by a plain user message: 38 followed by one, 13 not). It is not surfaced: the parser lives
in `local-machine` (outside the lot) and needs a cache bump and a settling rule (ADR 0059). The
served rows already carry every needed fact; no table and no migration were added.

`queryRecentServedHarnessSessions` (usage-store, additive) reads one page of the current
revision's most recent `codex` campaigns: a window scan on `idx_served_report_rows_active_time`,
then the chosen campaigns on `idx_served_report_rows_campaign`, the root and its five latest
members each, the rest counted. `queryWorkAttention` turns each family into a root
(`work-attention-read-harness.ts`), adds the Codex directories to the checkout read, counts
unread families in `totalRoots` and `truncated`, and names the revision in `coverage.sessions`
when no Desktop join did. The contract changes only through `WORK_ATTENTION_KINDS`
(`not-observable`); the oRPC schema and the browser client were not edited. The board gains a
"Codex · no declared wait read" section; rows say "wait unknown · not declared by Codex"; the
coverage line reads per harness (Desktop registry: declared waits; Codex: sessions only, no
declared waits; other harnesses: not read here). The demo dataset's Codex roots were aligned
with what the read model can produce.

Cost on the ×1 perf fixture (copy of lot P's x1 store, 4 989 Codex rows, 1 675 Codex families in
the window): `queryWorkAttention` warm median 42.4 ms (cold 59.5) of which the Codex store read
12.1 ms; dataset 183 KB of which 89 KB for the 65 Codex roots the page keeps.

Tests: report-data `work-attention-read-harness.test.ts` (8, store + read + assembly), the
usage-engine-runtime chain `work-attention-codex-chain.integration.test.ts` (seeded rollout →
`codex.sessions` → store → publication → read), model, synthetic, SSR and e2e-fixture server
tests; `work.spec.ts`, `work-e2e-fixture.spec.ts` 12/12 and `work-production.spec.ts` 6/6 under
`nix develop` (screenshots inspected, kept out of the repository). Typecheck, check and lint
PASS; web unit 1 581 pass; report-data 76, report-core 542, usage-store 273, web-contract 94
pass. Not run: the full `verify` gate, `test:e2e` beyond the Work specs. No committed visual
snapshot covers `/work`.

### 2026-10-22 14:35 — lot C integrated, reconciled with lot N; gate at `29b7f03e`

`c58df3e2` merges lot C (`a422f61e`, `38766dfc`, ADR 0059) with `--no-ff`; the only conflict was
this plan. Checked against the code first: a Codex root is built with attention `not-observable`
and no request or wait is derived for it whatever its facts show; its children are its own served
campaign members and nothing folds it under a Desktop root; `not-observable` ranks after every
other kind; the store read is bounded (families per read, five latest members each, the rest
counted); the coverage line names per harness what was read. Integration commits: ADR 0059
indexed (`28c22ad4`); Codex rows get their own budget, `WORK_ATTENTION_BOUNDS.maxCodexRoots` (20),
the most recent first, with `coverage.codexSessions { campaignsInWindow, campaignsRead }` through
the contract and the client and the line "N of M Codex campaigns shown" (`dcdf1d9c`; in the
production fixture 20 of 204 instead of 71 rows of a 100-row page); the Work context carries
`coverage.harnesses` and names both harnesses when Codex campaigns were read, a Codex root never
enters `waiting`, the CLI prints the harness line and the MCP tool no longer says Claude Desktop
only (`f2143fcc`); README section 10 and ADRs 0058/0059 amended (`29b7f03e`). The contract and
the browser client take `not-observable` from the shared `WORK_ATTENTION_KINDS`; a contract test
proves it.

Gate in the detached gate worktree at `29b7f03e` under `nix develop` (Bun 1.3.13): frozen install;
`bun run check` 1625 files clean; `bun run lint` rc 0; typecheck PASS (turbo `check` 58/58 with
`--force`); package suites 56 tasks, 2 764 pass, 0 fail (228 s); web unit 1 581 pass (42 s);
`test:tools` 145 pass (194 s); build PASS; client manifest PASS; `test:web-bundle` 4/4, first
load 305 869 B; `bun run test:e2e` through the retry wrapper 252 passed, no retry (124 s);
`bun run test:web-production` PASS (33 s); `bun run test:e2e-production` PASS (378 s): production
report 13/13, `work-production.spec.ts` 6/6, `work-attempt-production.spec.ts` 1/1, session scroll
and campaign map 7/7, campaign continuity 31/31. Not run: the real hook probe, CI on this head;
the payload size with the Codex budget was not re-measured.
