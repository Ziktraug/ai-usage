# ADR 0077: Delegation owned by AI Usage, independent of the calling harness

- **Status**: Accepted
- **Date**: 2026-10-25
- **Extends**: 0009, 0052, 0053, 0055, 0057, 0058, 0074, 0075
- **Amends**: 0051 (the bounded runner may classify stderr into a closed vocabulary)

## Context

ADRs 0052–0057 let the Work view qualify a read-only review of one Session and
launch it with Claude Code. The request, the target and the launch were all
tied to a collected Claude Desktop or served Session; Codex was simulated only.
The operator wants to hand a task to the agent they use that day (Claude Code
today, Codex, OpenCode or Cursor tomorrow) and let that agent delegate by
difficulty, available capabilities, authorized accounts, quotas, resets and
preferences. No client may become the leader the rules depend on: the rules,
requests and results must belong to AI Usage, so that changing the main MCP
client changes neither the delegation rules nor the work AI Usage follows.

## Decision

**Three roles, never coupled.** The *caller* is any MCP client (or the CLI)
that describes a bounded task, asks for the admissible routes, starts one and
follows it. The *selector* chooses one admissible route or abstains; in this
version it is the calling model, which judges difficulty and fit. The
*executor* is a harness adapter that runs one route: machine, harness, account,
quota pool, model and effort. A Claude Code caller may start a Codex worker and
the reverse; the caller's name, session reference and correlation id are
stored as metadata and never authorize, route or bill.

**A session-independent request.** `DelegationRequest` (schema 1) carries the
objective, the action, a task category, the checkout path, the review scope,
success criteria and constraints. Only `read-only-review` executes;
`code-change`, `commit` and `publish` are named so that a request for them is
refused explicitly (`action-unsupported`). Scopes are `commit` (one revision
against its first parent, never widened to a branch) and `range` (an explicit
`base..head`, base an ancestor of head). The engine freezes both to SHAs before
qualifying; `working-tree` is refused (`scope-unsupported`) because nothing
captures uncommitted changes reliably for a worker. The Work context projection
(ADR 0058) stays optional context: a valid direct request on an admitted local
checkout needs no collected Session, no Claude Desktop registry and no work
context.

**Rules decide admission; the model only chooses.** The engine resolves the
checkout canonically and requires a `routing.reviewTargets[]` entry
(ADR 0053) before reading anything for a worker. Candidates come from the
existing qualification (`qualifyReviewCandidates`, generalised to a checkout
target), so authorization stays the operator's `routing.executors[]`
declaration, subscription stays subscription-only, and availability, identity
and quota windows are judged exactly as before. A home-only `delegation`
section adds, with an explicit, tested priority: a route needs a declared
context (professional or personal); an applying `forbid` rule excludes it; every
applying `restrict` must select it (an empty intersection blocks with "incompatible
rules"); `require` combines strictest (reserve, concurrency, attempts, identity
evidence); preferences only order. A rule needing an unknown checkout fact
(repository, owner, declared GitHub account, local Git author) is assumed to
apply and is reported as an assumption. Remotes are matched by exact host
(`github.com`, `www.github.com` over HTTPS or `git://`, `ssh.github.com` over
SSH, ports allowed), never by substring. A remote list is `partial` when some
remote could not be identified:

- an SSH host other than GitHub's (`~/.ssh/config` may alias it to GitHub, and
  the engine does not read SSH configuration);
- a GitHub URL whose path is not `owner/repo`;
- a malformed URL;
- lines beyond the read limit;
- more distinct values than a qualification keeps.

A rule that matches an identified value applies; one that matches none is
assumed to apply. Only a fully identified listing proves that no GitHub
remote exists. Reserve is checked window by window on
every window that applies to the route's model; quotas are never averaged,
summed across models of one account, compared across providers, or converted
to tokens. A quota observed before the latest observed account change is
unattributable. The engine persists the time of that change per executor
(`executor_account_changes`, advanced inside each observation import), so
neither the pruning of the observation history nor a restart weakens it; only
a quota observed after the change lifts it, and an unknown fingerprint is
never a change or a confirmation. Concurrency counts reserving jobs and review
attempts per quota pool. The calling
model receives only admissible routes with factual advantages and limits and a
deterministic `orderHint` labelled as a tie-break, not a judgment. The
selector contract (`choice` with route, qualification id, selector version,
optional self-reported confidence, or `abstain` with a reason) is replaceable by
a specialised selector later; this version adds no paid API call, provider key
or decision SDK.

**Qualify, then revalidate.** `qualify-delegation` refreshes the executor
observations (the `executors.capabilities` source) and records a dated,
versioned qualification (policy and catalog revisions, `validUntil` bounded by
the time-to-live, the facts' freshness and the earliest applicable reset).
`start-delegation` re-qualifies with the same function and refuses, as data, a
missing, expired or mismatching qualification, a changed policy revision, a
changed scope, a route not offered then or not admissible now, a pinned Claude
account that changed (re-probed at start), a reserved target, a busy pool or an
exhausted retry chain. The Delegation simulator in Manage calls the same
command. An unavailable route, an invalid choice or an abstention never moves
the task to another provider or billing mode: the answer says why and that the
caller may keep the task.

**One policy for every launch.** The Work view's session review (ADR 0053,
`start-review-attempt`) keeps its entry point. Its session lookup stays in its
own adapter, which hands only the canonical checkout path and the candidate id
to the delegation service's admission. The admission runs the same assessment
as `start-delegation`:

- `HEAD` frozen to a commit;
- the `delegation` rules, identity evidence and reserve;
- the account-change barrier;
- the reservations of both families.

The candidate id is the route id, so a forced candidate is judged as its route.
A route that is absent or not admissible refuses the command before any
probe or spawn, with the route's exclusions. An admitted attempt records its
frozen revision (`review_attempts.base_sha`/`head_sha`) and reviews exactly
those SHAs, in the repository top level the session led to. The delegation
contract itself never depends on a collected Session.

**Durable jobs owned by the engine.** Additive tables under usage version 4
(`delegation_jobs`, `delegation_evaluations`, `delegation_qualifications`)
hold the request, its digest, the cited and the launch qualification, the
selection, route, pool, requested and resolved model, harness version, scope as
executed (coverage, truncation), usage as the harness reported it, the bounded
structured result, failures and evaluations. The idempotency key is the
caller's: the same key with the same request and choice returns the same job,
with different content it is refused (`idempotency-conflict`). The key check,
the target reservation (one reserving job per action, checkout and frozen
scope), the pool concurrency and the retry-chain limit run in one immediate
transaction. The target and pool reservations are shared with the Work view's
review attempts. Both insert transactions read the reserving rows of both
tables through one rule (`review-reservations.ts`), so the two families can
neither review one target twice nor exceed a pool's limit together.

The rule reads only what each row recorded. A pre-upgrade attempt without a
frozen revision reserves the revision its launch scope names, otherwise its
whole checkout, otherwise every review of the machine. An attempt whose
declaration does not parse counts against every pool of its harness. None of
these is released by age, and each refusal names the uncertainty. States extend ADR 0053's machine: `requested → starting → running
→ finished | failed | cancelled`, plus `refused`, `abstained` and `lost`; a lost
job keeps its reservations until process evidence releases it (ADR 0055); the
engine never adopts, signals or relaunches a process it did not start. A
disconnected caller cancels nothing; an aborted MCP call aborts only an
unfinished command; `cancel-delegation` terminates only a process this engine
tracks. Reads go through the read-only store reader, so a second client of the
same operator reads a job a first client started, even when the engine is down.

**Executors are harness adapters with their own controls.** Both adapters run
without a shell, with the bounded environment allow-list plus
`AI_USAGE_DELEGATION_DEPTH=1`, no MCP server (so no recursive delegation), a
deadline and an output cap. Claude Code keeps ADR 0055's vector (tools Read,
Grep, Glob; no setting sources; safe mode; plan mode; strict MCP config).
Codex runs `codex exec` with `--sandbox read-only`, `approval_policy="never"`,
`--ignore-user-config`, `--ignore-rules`, no MCP servers, web search disabled,
hooks and multi-agent disabled, the prompt on stdin and the review contract as
`--output-schema`; it refuses a checkout carrying `.codex/config.toml`, which a
trusted project could load beneath the overrides. A prompt saying "do not
modify" is never the only guarantee. The Codex sign-in method is the one fact the CLI
prints only on stderr (`codex login status`): the bounded runner of ADR 0051
may now hand at most 4 KiB of stderr once to a caller's classifier and returns
only its closed-vocabulary word (`chatgpt`, `api-key`, …), never the text. The
observation and the worker resolve the same Codex executable and `CODEX_HOME`,
and a start re-probes that profile: a profile signed in with an API key is
refused, whatever the declaration says. Codex cannot be given a session id, so its
process marker is the private `--output-last-message` path, which carries the
launch marker in the argument vector. OpenCode and Cursor are listed as
harnesses whose executors are not supported: neither offers a per-invocation
read-only mode.

**Execution, verification and acceptance stay apart.** A finished job only
says the harness ended and its output did or did not satisfy the result
contract (an `automated-check` evaluation). A `verification` is recorded by the
calling model through MCP (author `calling-model`, forced by the edge); an
`acceptance` is recorded only through the Web edge (author `operator`). A model
or a check can never record the operator's acceptance. `retryOf` links a retry
or an escalation, so success at the first attempt is observable when it
happens; a delegated attempt is not a Round.

**Edges.** The engine control plane carries the five commands
(`qualify-delegation`, `start-delegation`, `cancel-delegation`,
`record-delegation-evaluation`, `update-delegation-config`) and bounded
answers, never report data. The local stdio MCP server exposes
`delegation.qualify`, `delegation.start`, `delegation.status`,
`delegation.list`, `delegation.cancel` and `delegation.evaluate` through an
adapter-owned port with no Memory dependency. `delegation.list` returns compact
entries and `delegation.status` the bounded detail. The list counts in
`omitted` the entries beyond the response bound, so every answer stays under
the 192 KiB tool bound.

A job view is kept under 64 KiB after JSON serialization in UTF-8 bytes, on
every path. It cuts, as far as needed, in this order:

1. reference lists (scope files, criteria, constraints, excluded routes,
   rationale);
2. older evaluations (never the operator's latest acceptance);
3. findings, evidence and the remaining lists;
4. long free texts.

Each cut is counted in `truncation`. Identifiers, object ids, the state, the
route and the frozen scope are never cut, and the store keeps everything.
Every view and list entry returns the persisted `frozenScope` beside the
requested scope, never re-resolved; an older record answers `null`.

Claude Code lists the tools with underscores
(`mcp__ai-usage__delegation_start`); it locates the engine from the
AI Usage installation, not from the caller's working directory. The CLI exposes
the same operations (`ai-usage delegation …`) and starts only through a running
engine. Configuration is edited from Manage › Delegation through
`update-delegation-config`, which writes section by section through the locked
home-config update and refuses a stale `expectedRevision`; any write changes
the policy revision and so invalidates older qualifications. Each Manage form
saves against the revision its draft was read from, not the latest one it has
seen. It restates what it does not edit as read, a route annotation without a
declaration included. When what it writes changed elsewhere, it resolves only
on an explicit action: discard, or re-apply the operator's own edits, where a
field both sides changed keeps the latest value and is listed.

## Consequences

- Changing the main client (Claude Code, Codex, any MCP client) changes no rule
  and loses no job: the rules live in the home config, the jobs in the store.
- `routing.executors[]` stays the route declaration of ADRs 0052 and 0057; the
  app now writes it, under the same strict parser, on the operator's explicit
  save.
- The tables are local facts outside the served revision, snapshots, exports
  and replication. Older binaries at usage version 4 ignore them.
- Workers write their own harness session logs; the product reads them later
  through normal collection and never writes a harness session store.

## Limits

- Codex exposes no account identity outside its credential file: a Codex route
  is bound by its declaration only, and a policy requiring an observed identity
  blocks it. Account changes are detected for Claude Code only.
- Quota is not force-refreshed at qualification; a stale reading excludes the
  route with the action to refresh it.
- Available resets to consume, announced resets and promotions are not
  collected; nothing is ever consumed, bought or switched to overage.
- Managed Claude policy and Codex `-c` overrides cannot be verified from the
  CLI; the guarantee records both as limits. No OS sandbox is claimed for
  Claude Code.
- The selector's confidence is its own statement, never a measured probability.
- SSH host aliases are not resolved. A checkout whose remotes use one is partly
  identified, and its GitHub rules are assumed to apply (fail closed); writing
  the remote with GitHub's own host lifts the assumption.
- The Work view's review button now needs a declared route context like any
  delegation; without one it is refused with the missing context named. It is
  also admitted on the canonical checkout like a delegation: a
  `routing.reviewTargets[]` entry naming a symlink or a repository
  subdirectory, which admitted the session path before, now admits nothing
  (the refusal names the canonical path to declare).

## Rejected alternatives

- Making the calling harness the orchestrator (hooks, sampling, dynamic skills,
  a Claude session id as the job key): it would make one client the hidden
  leader and lose jobs when the client changes.
- Letting the MCP process spawn workers or write SQLite: it would create a
  second orchestrator beside the engine and a second writer.
- A deterministic "best route" presented as a judgment: preferences only order;
  task fit is the selector's decision.
- An API-key or overage fallback when subscriptions are exhausted: billing mode
  never changes silently.

## Evidence

- `packages/report-core/src/delegation-vocabulary.ts`, `delegation-contracts.ts`,
  `delegation-request.ts`, `delegation-policy.ts`, `delegation-qualification.ts`,
  `delegation-result.ts`, `delegation-job.ts` and their tests;
  `work-routing.ts` (checkout target).
- `packages/usage-store/src/delegation-store.ts`, `review-reservations.ts`,
  `executor-observation-store.ts` (account-change barrier) and their tests.
- Review fixes (PR #73 review, F1–F7):
  `packages/usage-engine-runtime/src/review-policy-common.test.ts`,
  `review-policy-integration.test.ts`, `delegation-remote-facts.test.ts`,
  `delegation-account-change.test.ts`, `delegation-frozen-scope.test.ts`,
  `delegation-config-sections.test.ts`;
  `apps/web/e2e/delegation.spec.ts` (settings writes).
- `packages/local-collectors/src/delegation-checkout.ts`, `review-worker.ts`,
  `claude-review-worker.ts`, `codex-review-worker.ts`,
  `review-worker-contract.test.ts`.
- `packages/usage-engine-runtime/src/delegation.ts` and its tests;
  `packages/usage-engine-control/src/contracts.ts`.
- `packages/mcp-adapter/src/delegation.ts`, `apps/mcp/src/main.ts`,
  `apps/cli/src/delegation.ts`.
- `apps/web/src/lib/features/delegation/*`, `apps/web/e2e/delegation.spec.ts`.
- [`docs/delegation.md`](../delegation.md), plan 121.
