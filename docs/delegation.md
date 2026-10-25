# Delegating read-only reviews from any MCP client

AI Usage lets the agent you work with today (Claude Code, Codex, or any other
MCP client) hand a bounded **read-only review** of a commit or a commit range
to another local harness, under rules you set once in AI Usage. The calling
agent chooses among the routes AI Usage admits; AI Usage owns the rules, the
jobs and their results ([ADR 0077](adr/0077-delegation-independent-of-the-calling-harness.md)).
Changing your main client changes neither the rules nor the jobs AI Usage
follows.

What this version does and does not do:

| Supported | Not supported in this version |
| --- | --- |
| Read-only review of one commit or an explicit `base..head` range in a local checkout you admitted | Code changes, commits, pushes or publications by a worker (`code-change`, `commit`, `publish` are refused) |
| Workers: Claude Code and Codex, each with its own read-only controls | Uncommitted changes as a review scope (`working-tree` is refused) |
| Callers: any MCP client over stdio, and the CLI | OpenCode and Cursor as workers (no per-invocation read-only mode); they can still be callers |
| Subscription routes only | API-key billing, overage, purchases, consuming a reset |

## 1. Prerequisites

- The usage engine running (`bun run start` or `bun run dev`). Qualification,
  start, cancellation and evaluation are engine commands; status and results
  are read from the store directly and stay readable when the engine is down.
  The web server is not needed.
- The worker CLIs installed and signed in with your subscription
  (`claude auth status`, `codex login status`). AI Usage never reads their
  credential files.
- In the home config (`~/.config/ai-usage/config.json`), or from
  **Manage › Delegation** in the web app:
  - `routing.executors[]` — which harness, account and models may run a
    read-only review (README section 7);
  - `routing.reviewTargets[]` — which checkouts a worker may read (README
    section 9);
  - `delegation.routes[]` — the context (`professional` or `personal`) of each
    route. A route without a context is never admissible.

## 2. Register the MCP server in your client

The server is a local stdio process. It needs no environment variable: it
finds the engine from the AI Usage installation, not from your client's
working directory. Replace `/path/to/ai-usage` with your checkout.

**Claude Code** (user scope):

```sh
claude mcp add --scope user ai-usage -- bun --no-env-file /path/to/ai-usage/apps/mcp/src/main.ts
```

Claude Code lists the tools with their dots turned into underscores
(`mcp__ai-usage__delegation_qualify`, `mcp__ai-usage__delegation_start`, …); use
those names in `--allowedTools` or in permission rules.

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.ai-usage]
command = "bun"
args = ["--no-env-file", "/path/to/ai-usage/apps/mcp/src/main.ts"]

# Codex asks before calling a tool annotated open-world or destructive, and
# `codex exec` (approval policy "never") refuses it instead. delegation.start is
# open-world (its worker contacts a provider) and delegation.cancel destructive;
# approve them for this server if your agent should start or cancel on its own.
[mcp_servers.ai-usage.tools."delegation.start"]
approval_mode = "approve"

[mcp_servers.ai-usage.tools."delegation.cancel"]
approval_mode = "approve"
```

`bun run mcp:register:codex` registers the same server under the name
`ai-usage-memory`; use that name in the `tools` tables then. For a one-off
`codex exec`, pass the table inline (a dotted `-c` path does not keep the dot
inside the tool name):
`-c 'mcp_servers.ai-usage.tools={"delegation.start"={approval_mode="approve"}}'`.
Qualify, status, list and evaluate need no approval.

**Any stdio MCP client** (generic `mcpServers` JSON):

```json
{
  "mcpServers": {
    "ai-usage": {
      "command": "bun",
      "args": ["--no-env-file", "/path/to/ai-usage/apps/mcp/src/main.ts"]
    }
  }
}
```

Set `AI_USAGE_ROOT_DIR`, `AI_USAGE_DATABASE_PATH` or `AI_USAGE_HOME` in the
server's environment only if your engine runs with them (for example an
isolated test runtime).

## 3. Tell your agent when to use it

The MCP tools provide the operations and the controls; whether a client uses
them on its own depends on its instructions. Paste this into the instructions
your client reads (`CLAUDE.md`, `AGENTS.md`, Cursor rules, …). It does not name a
harness and does not change when quotas change:

```markdown
## Delegating read-only reviews through AI Usage

When a task contains a self-contained read-only review of a commit or a commit
range in a local checkout — work another model could do while you continue, or
where an independent second reviewer helps — use the AI Usage MCP tools. Do not
ask the user to pick a harness for each task.

1. At that delegation boundary, call `delegation.qualify` once with the checkout
   path, the scope (`commit`, or `range` with `base` and `head`), the objective,
   the task category, success criteria and constraints.
2. Choose one of the admissible routes by your own judgment of the task
   (difficulty, the route's model and limits, its quota windows). `orderHint` is
   only a tie-break. If no route fits, or the task is better kept, call
   `delegation.start` with an abstention and continue the task yourself.
3. Call `delegation.start` with a new idempotency key. Reuse the same key only to
   retry the same submission after a timeout.
4. Keep working. Check `delegation.status` with the job id later, not in a tight
   loop.
5. When the job has finished, check its findings against the code yourself and
   record the result with `delegation.evaluate` (`verification`). Never record an
   acceptance: only the operator accepts, in AI Usage.

Qualify again only for a new delegation, after the qualification's
`validUntil`, or when the task, the policy or the availability has changed. Do
not qualify for every small tool call. If nothing is admissible, say so in one
line and keep the task.
```

## 4. The operations

| MCP tool | CLI | Effect |
| --- | --- | --- |
| `delegation.qualify` `{ request }` | `ai-usage delegation qualify --request <file\|-> [--simulation] [--json]` | Engine re-reads rules and observations, refreshes executor observations, records a dated qualification. Starts nothing. |
| `delegation.start` `{ idempotencyKey, request, selection }` | `ai-usage delegation start --request <file\|-> --qualification <id> --key <key> (--route <id> [--selector-version <v>] [--confidence <0..1>] \| --abstain <reason>) [--json]` | Revalidates and starts the chosen route, or records an abstention. Returns a job id at once; the same key answers the same job. |
| `delegation.status` `{ jobId }` | `ai-usage delegation status <jobId> [--json]` | Reads the job, its result and evaluations from the store (read-only); answers while the engine is down. |
| `delegation.list` `{ limit?, liveOnly? }` | `ai-usage delegation list [--live] [--limit <n>] [--json]` | Recent jobs, newest first (1–50, default 20), as compact summaries (state, route, scope, executed/verified/accepted, one-line result); `delegation.status` gives the detail. |
| `delegation.cancel` `{ jobId }` | `ai-usage delegation cancel <jobId> [--json]` | Stops a job this engine runs. Disconnecting a client cancels nothing. |
| `delegation.evaluate` `{ jobId, evaluation }` | — | Records the calling model's verification (`kind: "verification"`) of a finished job, labelled with the client's declared name. An acceptance cannot be recorded here. |

The CLI's `qualify`, `start` and `cancel` go only to a running engine
(`bun run start`); unlike the report commands they never start a one-shot
engine, because such an engine would terminate the workers it launched when it
exits. A request file (or `-` for standard input) is one JSON document of at
most 64 KiB. When the CLI names a route it is the selector
(`selectorVersion` defaults to `operator/ai-usage-cli`); `--abstain` records
the abstention under the cited qualification. Inside a delegated worker
(`AI_USAGE_DELEGATION_DEPTH` is set) `delegation.qualify` and
`delegation.start` answer `recursive-delegation` without contacting the engine.

A request looks like this:

```json
{
  "schemaVersion": 1,
  "action": "read-only-review",
  "taskCategory": "correctness",
  "objective": "Check that the retry loop cannot start a second worker after a timeout.",
  "checkout": { "path": "/home/you/src/ai-usage" },
  "scope": { "kind": "range", "base": "main", "head": "HEAD" },
  "criteria": ["Name every path where two workers could start"],
  "constraints": ["Do not review generated files"]
}
```

The engine resolves `base` and `head` to SHAs once; a later start whose refs
moved is refused (`scope-changed`). A `commit` scope reviews that revision
against its first parent, never the whole branch.

## 5. Rules, in priority order

1. A route needs a declared context (`delegation.routes[]`).
2. An applying `forbid` rule excludes the routes it selects.
3. Every applying `restrict` rule must select the route; two restrictions with
   nothing in common block with "incompatible rules".
4. `require` rules combine strictest: the largest reserve, the smallest
   concurrency and attempt limits, `observed` identity over `declared`.
5. Preferences (model order, harness order, reset proximity) only order the
   admissible routes; they never admit one.

A rule matches a checkout path prefix, a GitHub repository or owner (from the
checkout's github.com remotes), the GitHub login you declared for that owner
under `github.accounts[]`, or the checkout's local Git author email. These are
three different identities: the GitHub account, the Git author and the AI
provider account of the route. When a fact a rule needs is unknown, the rule is
assumed to apply and the simulator says so.

The **simulator** in Manage › Delegation runs the same qualification as a
start, for a checkout and a scope you enter.

## 6. What a result means

A job records three different things:

- **Execution** — the worker ended (`finished`, `failed`, `cancelled`) and its
  final message did or did not satisfy the result contract (`review` or
  `unstructured`); an automated check records which.
- **Verification** — the calling model's check of the findings
  (`delegation.evaluate`, author `calling-model`).
- **Acceptance** — yours, in the Work view (accepted, rejected, taken over).

A `lost` job means the engine lost contact (restart, shutdown). It is never
relaunched; it keeps its reservation until the engine shows that the process
it started is gone.

## 7. Limits

- Codex exposes no account identity outside its credential file. A Codex route
  rests on your declaration; a rule requiring an observed identity blocks it.
- Quota is read with its freshness rule and is not force-refreshed: a stale
  reading excludes the route and names the refresh.
- Announced resets, promotions and resets you could consume are not collected.
- Claude Code managed policy and Codex `-c` overrides cannot be verified from
  their CLIs; each job's guarantee lists them. No OS sandbox is claimed for
  Claude Code. Workers write their own session logs.
- A selector's confidence is its own statement, not a measured probability.
