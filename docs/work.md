# Work view setup and Work context

The Work view shows what is waiting on you across your sessions, pull requests
and tickets, and can launch a read-only review of a session in a local harness.
Everything on this page is optional and declared by you in the home config,
`~/.config/ai-usage/config.json`; repository config cannot declare any of it.
The usage report itself needs none of this.

- [Declare which local harness may run a read-only review](#declare-which-local-harness-may-run-a-read-only-review)
- [Declare which checkouts a launched review may run in](#declare-which-checkouts-a-launched-review-may-run-in)
- [Show Jira replies on linked tickets](#show-jira-replies-on-linked-tickets)
- [Join sessions to tasks through their branch](#join-sessions-to-tasks-through-their-branch)
- [Give a harness session the Work context of its checkout](#give-a-harness-session-the-work-context-of-its-checkout)
- [Delegate a read-only review from any MCP client](#delegate-a-read-only-review-from-any-mcp-client)

## Declare which local harness may run a read-only review

The Work view qualifies a read-only review of a session for a local
harness (Claude Code or Codex). History and quota never prove that a harness is
*allowed* to act, so authorization is declared once, by you, in the home config
(`~/.config/ai-usage/config.json`, section `routing`; repository config cannot
declare it). The engine observes the rest on a 15-minute cadence
(`executors.capabilities` on `/sources`): whether the binary is present, its
version, and the sign-in state that `claude auth status` / `codex login status`
report. Quota comes from the existing usage-limit sources. Each field of a
candidate shows where it came from (`declared <date>`, `observed-now`,
`stale <date>`, `unknown`). Qualification starts no review; a separate launch
action uses the declared checkout authorization
[below](#declare-which-checkouts-a-launched-review-may-run-in).

```json
{
  "routing": {
    "executors": [
      {
        "harness": "claude-code",
        "accountScope": "personal",
        "authorization": "allowed",
        "targets": [{ "kind": "any-local-session" }],
        "subscription": "verified",
        "capabilities": ["read-only-review"],
        "quality": "review-capable",
        "model": "Fable",
        "effort": "high",
        "declaredAt": "2026-10-21T22:00:00+02:00"
      }
    ]
  }
}
```

- `harness`: `claude-code` or `codex`.
- `accountScope`: the account this route bills against. When the stored quota
  key carries an account suffix (`claude:<accountScope>` on `/sources` or in
  `ai-usage quota --stored --json`), use that suffix; when the key is bare
  (`claude`, the usual case today), any stable name you choose binds the
  declaration to that machine's single quota stream for the family.
  Native Codex quota is scoped by the observed account fingerprint: copy that
  exact suffix into `accountScope` and pin the same observed identity below.
  A previous human-readable Codex alias needs explicit requalification.
- `machineId` (optional): defaults to this machine
  (`~/.config/ai-usage/machine.json`). Set it only to declare a route on another
  machine's behalf.
- `authorization`: `allowed` or `forbidden`. A quota never grants it.
- `targets`: `{ "kind": "any-local-session" }` or
  `{ "kind": "project", "projectLabel": "<project as shown in the report>" }`;
  one entry is required.
- `subscription`: `verified` (you confirmed the account is on a subscription)
  or `api` (metered API billing, excluded by the subscription-only policy).
  Nothing verifies billing for you: the observed plan is shown beside your
  declaration, never used to infer it.
- `capabilities` (`read-only-review`), `quality` (`review-capable`): the current
  review qualification values.
- `model`, `effort` (optional): the model and effort the review would run with.
  Declare `model` when the provider reports model-scoped quota windows (ids
  `model:<name>` in the quota feed, for example `model:Fable` on a Claude Max
  plan today); the declared name must equal `<name>` exactly, otherwise those
  windows cannot be attributed and the candidate stays excluded.
  Codex launch requires an explicit model and preserves the selected effort;
  a native model substitution is refused.
- `alternateModels` (optional, requires `model`): further models of the same
  account, in preference order, at most 8 and none repeated (for example
  `["Opus"]` after `"model": "Fable"`). Each becomes its own candidate on the
  same account and the same quota reading, never an extra reserve: a window
  scoped to one model (`model:Fable`) excludes only that model, while an
  exhausted all-models window excludes every model of the account.
- `accountFingerprint`: pins the route to the account the CLI is signed in to
  (ADR 0057/0062). The engine keeps a 16-character domain-separated hash of
  identity reported by the CLI's supported account interface, never the raw
  identifiers, and reads no credential file. Codex uses `account/read` and
  `account/rateLimits/read` on its own app-server connection. While the CLI
  reports an account and the entry pins none, the
  candidate stays conditional and the Work view shows the exact line to add
  (`"accountFingerprint": "<16 hex>"`): pinning is a one-time act per machine.
  A later sign-in to another account then excludes the route until you sign
  back in or re-declare. A Codex launch requires a confirmed pin.
- `declaredAt`: required RFC 3339 date-time; the declaration is a dated
  statement, not a current observation.

An invalid entry is reported on the Work view with its config path and reason
and does not hide the other entries. Declarations are read, never written, by
the app.

## Declare which checkouts a launched review may run in

A qualified recommendation for Claude Code or Codex can become one execution
(ADR 0053/0062). The engine uses the selected harness's own subscription sign-in
and records the attempt. Claude uses its existing read-only launcher; Codex
uses an owned app-server turn with verified model, policy and capacity.
It does so only when that checkout is equal to, or below, an entry you
declared under `routing.reviewTargets` in the same home config:

```json
{
  "routing": {
    "executors": [{ "...": "see the previous section" }],
    "reviewTargets": [{ "checkoutPath": "/home/you/src/ai-usage", "label": "AI Usage checkout" }]
  }
}
```

- `checkoutPath`: absolute path of a checkout; its worktrees under it are
  admitted too. The checkout a session is reviewed in is the Desktop session's
  worktree, else its cwd, else the served session's path; the Work view names
  it beside the button.
- `label` (optional): how the entry is referred to in the cockpit.

Without a matching entry the button stays absent and the view says exactly
what to add (`add routing.reviewTargets for <path>`). The engine re-reads the
declaration, the executor observation, the quota and the checkout at launch
time; the browser never decides. One attempt is live per target at a time: a
second click, a retry or a reload returns the existing one. An attempt the
engine lost contact with (restart, shutdown) is shown as "contact lost; verify
in the harness" and retains its reservation. The result remains attached to
that attempt after navigation or reload. Owned Codex attempts expose a stop
request separately from native interruption confirmation; neither a timeout
nor turn interruption proves every descendant has stopped.

The review covers one fixed commit and its bounded patch, with binary files,
omissions and dirty working-tree limits stated. Codex checks the same account
again at launch and sends the patch through the protocol. API authentication,
unknown capacity, explicit quota denials and unverified execution policy are
refused. Enabled or unknown credits also refuse generation: the qualified CLI
0.163.0 exposes no per-turn no-credit guarantee. The app does not change credit
settings, activate resets or silently choose another model or account.

## Show Jira replies on linked tickets

Optional. When the Atlassian CLI (`acli`) is installed and signed in, the engine
reads, every two minutes
([ADR 0088](adr/0088-incremental-jira-synchronization.md)), the Jira tickets
your Claude Desktop sessions linked **explicitly**: a key written as a whole
segment of a branch name (`feat/XYZ-2090/slug`, `fix/XYZ-2091/nav`, `XYZ-2092`)
in the session's written branches, its own branch, or the branch of a pull
request it declared. Keys in titles, prompts or paths never link; `XYZ-0` is
ignored as the "no ticket" placeholder. The Work view then shows the ticket's
dated status and, when comments arrived after the latest activity on that key
across your sessions, "N new replies" as a request for you on the session
family that was last active on the key (an older family on the same key is only
told which family carries it), without claiming you have not read them
elsewhere.

The open issues assigned to you are also listed above the tasks as a Jira
intake: you follow, attach or dismiss each one, and an assigned issue never
becomes a task on its own
([ADR 0079](adr/0079-ticket-routing-and-jira-intake.md)).

Only the read-only `acli jira workitem search` and `acli jira workitem view`
commands are ever run; nothing is written to Jira. The engine never reads or
stores a Jira token: `acli`'s own sign-in answers, and a signed-out CLI is
reported as `unauthenticated` with the last successful read kept beside it.

```json
{
  "jira": {
    "enabled": true,
    "handedOffStatuses": ["To Review (IT)"],
    "site": "example.atlassian.net"
  }
}
```

- `enabled` (optional, default on when `acli` is found): `false` records the
  source as disabled instead of reading.
- `handedOffStatuses` (optional): status names, matched without regard to case,
  in which a ticket is someone else's step once every linked pull request merged
  (a review or QA column). The Work view then shows such a task as waiting
  instead of "Ticket not done". A status in progress that is not listed stays
  your move. Each Jira read records the verdict, so a change applies from the
  next read.
- `site` (optional): the Jira site your keys belong to, kept for your record;
  this version does not pass it to the CLI.

The section lives in the home config only (`~/.config/ai-usage/config.json`);
repository config cannot enable provider communication. The `acli` command
shape is taken from the Atlassian CLI documentation and was not exercised on
the machine this feature was built on (ADR 0054); an unexpected response is
recorded as `invalid`, never as a fact.

## Join sessions to tasks through their branch

Sessions also join tasks through the branch their harness recorded (ADR 0081): Codex records the
repository and branch, Claude Code the branch and the folder whose `origin` remote names the
repository. A followed PR's head branch and recent interactive work on a branch without a task
are enough; the folder alone never is. Two optional `github` keys of the home config tune it:

```json
{
  "github": {
    "hostAliases": { "github-work": "github.com" },
    "sharedBranches": ["release"]
  }
}
```

- `hostAliases` (optional): remote host alias → host, beside the exact `Host` → `HostName` entries
  of `~/.ssh/config`, which are read already.
- `sharedBranches` (optional): branch names that never become a task of their own, beside main,
  master, develop, development, trunk, each clone's `origin/HEAD` and the base of an open PR.

Detaching a session from a task keeps it out of that task, even when its branch still matches.

## Give a harness session the Work context of its checkout

A Claude Code or Codex session can ask what is waiting, what was decided and
what is linked for the checkout or project it works in, from the same data as
the Work view ([ADR 0058](adr/0058-harness-sessions-read-work-context-through-one-bounded-projection.md)).
Both forms read the usage store read-only, start no engine and never write:

```sh
bun run cli -- work context --checkout "$PWD" --json   # this checkout and paths inside it
bun run cli -- work context --project-label ai-usage   # the project directory's name, exact
bun run cli -- work context --checkout /src/project --checkout /src/known-worktree --since-days 180 --json
```

The local stdio MCP server (`bun run mcp`) exposes the same read as the
read-only tool `work.context`, with exactly one of `checkoutPath` (absolute),
`checkoutPaths` (up to ten explicitly known worktrees) or `projectLabel`.
`sinceDays` accepts 1–3650, default 30. Scope is applied before the bounded
selection, so unrelated projects cannot occupy the requested project's page.
Adding the tool registers nothing: the server is still
registered only by your explicit `bun run mcp:register:codex` or
`bun run mcp:register:opencode` (or your own harness configuration); see
[the local MCP server](mcp.md).

The answer (`schemaVersion` 1) has `waiting` (human requests and external
waits with dated declarations or supported native request evidence),
`decisions` (attributable native outcomes, each with its evidence), `linked`
(pull request, checkout and Jira facts), bounded `sessions` references and
`coverage`. A later message or completed child alone never answers a request.
Coverage states per harness what was read: Claude Desktop declarations and
supported Codex structured requests from selected sessions (at most twenty
Codex campaigns, with selected members and omissions counted). An asynchronous
tool acknowledgement is not a human answer; general Codex turn status and
unrecorded requests remain unknown. OpenCode, Cursor and
Claude Code sessions started outside Claude Desktop are not represented, no
transcript is read, and quiet roots older than the window are left out. Lists are bounded (at most
20 waits and 20 decisions) and the whole answer stays under 64 KiB of JSON;
`truncation` says what was left out. A missing or not-yet-upgraded store is an
error (exit 1, or an MCP error such as `store-missing`), never an empty answer.

## Delegate a read-only review from any MCP client

The agent you work with (Claude Code, Codex or any MCP client) can hand a
read-only review of a commit or a `base..head` range to another local harness
through the same stdio MCP server: `delegation.qualify` returns the routes your
rules admit now, the agent chooses one or abstains, `delegation.start` runs it
in the engine, and `delegation.status` reads the job and its result from the
store, so another client can follow it. Rules (professional/personal contexts,
repository, owner, declared GitHub account, Git author, reserves, concurrency,
attempts, identity proof) and the model catalog are edited in **Manage ›
Delegation**, which also simulates a request. Claude Code and Codex run as
workers with their own read-only controls; OpenCode and Cursor are listed as
callers only. Setup, MCP registration for each client, the instruction to give
your agent and the limits are in [delegation](delegation.md)
([ADR 0077](adr/0077-delegation-independent-of-the-calling-harness.md)).
