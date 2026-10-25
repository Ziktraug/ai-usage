# ADR 0055: Review attempt reservation, reviewed scope and harness guarantee

- **Status**: Accepted
- **Date**: 2026-10-22
- **Amends**: 0053 (loss of contact, prompt and flags, the hooks limit)

## Context

A static review of the first launched review (ADR 0053) found three gaps. A `lost` attempt was
not live, so after an engine restart with the old `claude -p` still running a second launch on
the same target was accepted. The prompt carried `git log -1` and a diff stat but no patch, and
the agent had no shell: "review the latest change" could only read current files. And the flags
bounded tools and MCP servers, not the hooks that user, project or local settings declare.

## Decision

**A lost attempt keeps its reservation until evidence releases it.** The reservation is the
partial unique index `idx_review_attempts_reserved_identity` over the live states and over `lost`
rows with `released_at IS NULL`; the first version's live-only index is dropped in the
table-presence migration, which also adds the nullable columns and releases the first version's
lost rows as `recorded-before-reservations` (that rule kept no reservation). Before any spawn the
engine records a fresh UUID, `launch_session_id`, and passes it as `--session-id`: the process
carries it in its argument vector for its whole life, so the engine can look for it in the Linux
process table instead of trusting a reusable pid or an age. A release names its evidence:
`process-absent` (no process carries the marker; the launching engine released the writer lease,
so no late write can follow) or `outcome-recorded-late` (the launching engine saw the end and
recorded the outcome on the lost row, which stays `lost`). A late heartbeat changes nothing.
Recovery at startup looks for each process before marking the row lost and says what it found; a
new start on the target settles lost reservations first and otherwise refuses with
`attempt-unresolved`, naming the attempt, the marker, the pids and what would release it. The
engine never adopts or signals a process it did not start. The Work view keeps the button for a
held reservation: the click is the explicit request for that check. Without a readable process
table (any platform but Linux) the reservation stays until an outcome is recorded.

**The scope is one commit, prepared by the engine.** `HEAD` is resolved to a SHA first and every
read names that SHA; the base is the first parent (a merge is compared with it only) or the empty
tree for a root commit. `git diff-tree -r -p -M` runs with no external diff, no text conversion,
no colour, no pager, fixed prefixes and context, `--no-optional-locks`. The prompt carries the
patch cut at a line boundary to 64 KiB and 2 000 lines and a bounded file listing, each file marked
complete, partial, omitted or binary; it names the SHA, the base, "one revision, not a pull request
or a branch", a dirty working tree, and asks for an explicitly partial review when truncated. A
moved `HEAD`, no commit, an empty or binary-only commit, a non-UTF-8 or larger than 8 MiB patch is
refused (`scope-unavailable`). The attempt stores the scope: base and head SHAs, SHA-256 of the
whole patch, sizes, truncation and per-file coverage.

**The launch excludes every settings source and declares what remains.** The argument vector
adds `--setting-sources ""` (no user, project or local settings, hence none of their hooks,
permission rules, environment or helper commands), `--safe-mode` (plugins, skills, CLAUDE.md,
hooks and MCP servers from any customization off; sign-in unchanged) and `--tools Read Grep
Glob`. Before each launch the CLI is qualified: `--version` must answer a version and `--help` must
name every flag relied on (`--max-turns` is hidden and stays unqualified); otherwise the launch
fails as `cli-unqualified`. The attempt stores the guarantee: CLI version, loaded setting sources
(none), safe mode, tools, and whether a managed settings file exists on the machine, since managed
policy cannot be excluded; organization-delivered policy is not observable locally.

**Lifecycle.** At shutdown the engine terminates the processes it started, waits for each exit and
records it as failed "stopped at engine shutdown" with what the harness produced; a clean finish
stays finished. Rows still live without a tracked process become `lost` and stay reserved. No stop
command from the product exists yet.

## Consequences

- Read-only now means: no repository write and no external action by the review's tools. The
  harness still writes its own session logs under the operator's Claude directory; no OS sandbox
  is claimed.
- A result says exactly what was reviewed; a truncated patch shows the result as partial.
- The control contract reads attempt states and refusal reasons from the import-free
  `@ai-usage/report-core/work-attempts-vocabulary`, keeping the Work policy out of the first load.
- An older binary that reopens an upgraded store fails visibly on a held identity (there is no
  downgrade path).

## Rejected alternative

- Treating a lost attempt as ended after a delay: a slow review is not a dead one, and a pid alone
  can be reused; the marker in the argument vector is the identity, age never is.

## Evidence

`packages/report-core/src/work-attempts.ts` and `work-attempts-vocabulary.ts`,
`packages/usage-store/src/review-attempt-store.ts`, `packages/usage-engine-runtime/src/review-attempts.ts`
and `review-attempts-process.ts`, `packages/local-collectors/src/claude-review-launcher.ts`,
`claude-review-scope.ts` and `claude-review-cli.ts`, each with its tests;
`apps/web/e2e/work-attempt-production.spec.ts`; plan 118, lot K.
