# ADR 0053: First read-only review attempt launched by the engine

- **Status**: Accepted
- **Date**: 2026-10-22
- **Extends**: 0009, 0050, 0052

## Context

ADR 0052 lets the Work view simulate assigning a read-only review of a
session to a local harness and label the outcome `real`, `conditional` or
`none`. Nothing executed. The campaign's next step is one real execution,
launched from the cockpit, followed there, and consultable afterwards, without
a manual command in between, on an isolated AI Usage checkout.

Three things make this different from a button that runs a shell command:

- the two planes (ADR 0009): the Web process never spawns anything and never
  opens the store read-write; only the engine may act;
- an action by the product on the operator's behalf needs an explicit policy
  with a verified target, not a simulation result the browser computed;
- an execution that can take minutes needs an identity, so a second click, a
  retry or a reload cannot start a twin, and a lost process is reported as lost
  rather than silently restarted.

## Decision

**One command, decided by the engine.** `start-review-attempt { action:
'read-only-review', target: { harness, sourceSessionId, desktopSessionId? },
candidateId }` is a usage-engine command like the others (control contract,
policy, executor, live handler). The engine re-reads the facts at launch time
from its own sources (declarations and review targets from the home config,
executor observations and quota from the store, the target's checkout from the
Desktop session or the served Session) and applies a pure policy,
`decideReviewLaunch`. The browser's simulation result is a reason to show the
button; it authorizes nothing.

**Explicit policy, declared target.** A review may run only when:

- a `routing.executors[]` declaration authorizes the candidate on this machine
  (`authorization: 'allowed'`, target admitted, `read-only-review` capability);
- the executor is Claude Code (Codex is declared and simulated, not executed,
  in this version);
- the target's checkout, resolved as the Desktop session's `worktreePath`,
  else its `cwd`, else the served Session's `sourcePath`, is equal to or below
  a `routing.reviewTargets[].checkoutPath` entry of the home config;
- the executor is observed available (installed, signed in, fresh observation);
- the same qualification the Work view simulates, forced on the chosen
  candidate, yields a `real` recommendation.

Each failure is a typed refusal (`no-declaration`, `harness-unsupported`,
`target-not-allowed`, `executor-unavailable`, `recommendation-not-real`,
`attempt-already-live`) with the fix in its message; a refusal is recorded as
an attempt row in state `refused` and answered as data, not as an error.

**An identified attempt, one live per identity.** The additive table
`review_attempts` (usage version 4 unchanged, presence of the table is the
migration signal) holds one row per attempt with its idempotency key
`sha256(machineId|action|harness|sourceSessionId|checkoutPath)`. A partial
unique index over the live states (`requested`, `starting`, `running`) makes a
second request return the existing attempt (`reused: true`) whatever raced it.
States are `requested → starting → running → finished | failed`, plus
`refused` and `lost`. Transitions name the states they may leave from, so a
late write from a finished process cannot resurrect a row. A heartbeat stamps
`updated_at` every 15 seconds while the process lives.

**The harness runs read-only, bounded, with the operator's own sign-in.**
`claude -p <prompt> --output-format stream-json --verbose --permission-mode
plan --strict-mcp-config --allowedTools Read Grep Glob --disallowedTools Edit
Write MultiEdit NotebookEdit Bash WebFetch WebSearch Agent Task TodoWrite
Skill --max-turns 8`, plus `--model` and `--effort` when declared
(`--strict-mcp-config` with no `--mcp-config` inherits no MCP server from the
operator's or the checkout's settings; the delegating, planning and skill
tools are denied so the review cannot fan out); no shell; `cwd` is the
admitted checkout; the
environment is the shared runner's allow-list (PATH, HOME, locale, XDG, and
`CLAUDE_CONFIG_DIR` when set), so the operator's Claude Code credentials are
used by the CLI and never read or stored by the product; stdout is read line
by line under a 2 MiB cap; stderr is discarded; a 10-minute deadline sends
SIGTERM then SIGKILL. Only `system/init` (the native session id) and `result`
(the final message, bounded to 4 000 characters, turns, duration, error flag)
are retained. The prompt is generic and bounded: the instruction, the target's
title, `git log -1` and `git diff --stat HEAD~1..HEAD` read by the engine.
`AI_USAGE_CLAUDE_EXECUTABLE` names another executable for fixtures: an
absolute path or a bare name on the allow-listed PATH; a relative path is
refused (`executor-unavailable`) rather than resolved against the checkout.

**Loss of contact is a state, never a relaunch.** At engine startup every row
still `requested`, `starting` or `running` becomes `lost` ("verify in the
harness"; the reason says whether a process with the recorded pid was still
alive). At engine shutdown running processes are terminated and their rows
become `lost` before the store is quiesced. Nothing is relaunched
automatically; the command's abort never kills a started review.

**Result, validations and acceptance are three different things.** The
attempt stores the harness's result excerpt, the list of verification commands
the review actually ran (empty for a read-only review, never invented), and a
human acceptance (`pending`, `accepted`, `rejected`) that no code sets in
this version: it stays `pending — not reviewed by you` until a later decision
gives it a mutation.

**Reading and the cockpit.** `workAttempts.list` reads the store read-only
and says what it resolved about the target (checkout path, origin, admitted);
`workAttempts.start` forwards the one command. The Work view shows the button
only after a `real` Claude Code recommendation on an admitted target with no
live attempt, otherwise the exact reason ("add routing.reviewTargets for …",
"the recommendation is conditional", "a review is already running (attempt
…)"); it lists the target's attempts, polls every 5 seconds exactly while one
is live, and names the native session id with a link to the session detail
once the report collected it. The demo exposes nothing: "Execution is not
available in the demo."

## Consequences

- The product performs one action on the operator's behalf, under a policy
  the operator wrote, on a checkout the operator declared, with the
  operator's own subscription, and records what it did.
- Attempts are local facts outside the served revision, the snapshot, the
  export and replication; the table is additive under usage version 4.
- The engine process hosts the harness process; an engine restart loses it,
  which is recorded, not hidden.

## Limits

- Claude Code only. Codex stays at simulation for this campaign.
- The flags bound the model's tools and the MCP servers, not the hooks: a
  `PreToolUse`, `PostToolUse` or `Stop` hook the operator configured in their
  user settings, or that the checkout configured in its project settings,
  still runs inside the launched session with the operator's rights. The
  product does not pass `--safe-mode` or `--setting-sources` in this version;
  an operator who needs a hook-free review declares a checkout without hooks
  or runs under a `CLAUDE_CONFIG_DIR` kept for reviews.
- No acceptance mutation, no cancellation command, no retry: the first
  execution proves the chain and its guards, not a workflow.
- The browser-side gate repeats the engine's rules to explain itself; it is
  not the decision and can be stale by one poll.
- The launched session's own transcript is not read by the product; the link
  to it appears only once the normal collection sees the session file.

## Rejected alternatives

- Launching from the Web process: violates the two planes and would leave the
  attempt without a writer when the page closes.
- Trusting the browser's `real` recommendation: the browser's facts are a
  copy; the engine must decide on its own reads at launch time.
- `--dangerously-skip-permissions` or an API-key fallback: a bypass flag
  contradicts a read-only review, and the subscription policy is explicit.
- Relaunching a lost attempt automatically: a second agent on the same target
  is exactly what the idempotency rule exists to prevent.

## Evidence

- `packages/report-core/src/work-attempts.ts` (policy, identity, record,
  stream reader) with `work-attempts.test.ts`.
- `packages/usage-store/src/review-attempt-store.ts` (table, one live per
  identity, guarded transitions, lost marking) with its test.
- `packages/local-collectors/src/claude-review-launcher.ts` (argument vector,
  environment, bounded stream reading) with its test.
- `packages/usage-engine-runtime/src/review-attempts.ts` (decision, launch,
  heartbeats, startup and shutdown loss) with its test; `live.ts` wiring.
- `packages/usage-engine-control/src/contracts.ts` (`start-review-attempt`,
  `review-attempt` output).
- `packages/web-contract/src/work-attempts.ts`,
  `apps/web/src/server/work-attempts.server.ts`,
  `apps/web/src/lib/features/work/work-attempts.svelte`,
  `work-routing.svelte`, and `apps/web/e2e/work-attempt-production.spec.ts`
  (production path with a fake `claude`, opt-in `AI_USAGE_WORK_ATTEMPT_E2E=1`).
- `README.md` "Declare which checkouts a launched review may run in" and
  `docs/local-store-upgrade.md` "review attempts".
