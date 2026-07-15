# Plan 010: Fix Production Smoke Lifecycle and Add Stateful CLI Integration Coverage

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plan 009
- **Category**: test correctness / process lifecycle / integration coverage
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `test/010-runtime-and-cli-integration`

## Executor instructions

Read this plan fully and compare the current commit with `17bcf28` plus the
completed plan 009 implementation. Re-read changed files before editing. Use a
temporary HOME and working directory for every subprocess test; never inspect
or mutate the developer's real usage history.

Deliver this in two commits: production-smoke lifecycle, then CLI black-box
coverage. This plan diagnoses and fixes test orchestration; it must not change
the supported CLI or web behavior to make tests easier.

## Why this matters

`bun run test:web-production` currently prints successful assertions but does
not return to the shell. `tools/check-web-production-start.ts` spawns
`bun run --cwd apps/web start`, kills that wrapper, then waits for its pipes.
The descendant `node start.mjs` survives, retains the pipes, and keeps the port
open. CI can therefore hang after reporting a pass.

The CLI's parser has unit coverage, but stateful commands are not exercised as
real processes. Machine identity, file output, merge rendering, Cursor import,
exit codes, stderr, and large-output draining can regress while parser tests
stay green. The removed HTML integration suite must not remain the only model
for process-level CLI coverage.

## Target outcome

1. `bun run test:web-production` exits 0 promptly after its assertions.
2. The production server process is owned directly, terminates within a bounded
   interval, releases its pipes, and releases its TCP port.
3. Stateful CLI commands run through the real executable in isolated temporary
   environments.
4. CLI integration tests assert exit code, stdout, stderr, files, and repeat-run
   behavior without using real user data.
5. HTML stays rejected; no HTML helper or fixture returns.

## Current-state evidence

- `tools/check-web-production-start.ts` spawns `bun run --cwd apps/web start`,
  sends signals only to that direct child, and then awaits stdout/stderr.
- `apps/web/package.json` delegates `start` to `node start.mjs`; that second
  process is the actual server.
- A direct `node apps/web/start.mjs` process owns the listener and terminates
  correctly when signalled; killing only the Bun wrapper leaves it alive.
- `apps/cli/src/cli.test.ts` covers parsing, while no current suite launches
  `apps/cli/src/main.ts` across multiple stateful invocations.
- `apps/cli/src/main.ts` explicitly waits for stdout writes so large pipe output
  should be characterized at the process boundary.

## Scope

### In scope

- `tools/check-web-production-start.ts` and a focused tool test/helper if useful;
- new `apps/cli/src/main.integration.test.ts` and local test support/fixtures;
- tiny testability extractions from CLI code only when black-box setup cannot be
  expressed through supported inputs;
- CI timeouts or script wiring only when required to run these tests normally.

### Out of scope

- changing production listener trust, report revision behavior, or Nitro start;
- a generic cross-repository subprocess framework;
- live provider/network quota calls;
- machine identity race, file permissions, portable limits, and local-history
  hardening, which later plans test and fix separately;
- restoring HTML integration coverage.

## Commands

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- \
  tools/check-web-production-start.ts tools/check-web-production-start.test.ts \
  tools/fixtures/production-smoke-listener.mjs \
  apps/cli/src apps/cli/package.json package.json .github
git status --short -- \
  tools/check-web-production-start.ts tools/check-web-production-start.test.ts \
  tools/fixtures/production-smoke-listener.mjs \
  apps/cli/src apps/cli/package.json package.json .github
bun run build
bun test apps/cli/src/cli.test.ts
```

If either scoped drift command contains changes beyond completed plan 009,
STOP, preserve them, and re-read/rebase the affected tool or CLI test seam before
editing.

Do not reproduce the known pre-fix smoke hang: an external timeout can leave the
Node descendant behind. The orphan/retained-pipe evidence at `17bcf28` is the
characterized baseline. First run `test:web-production` only after step 1 owns
and cleans the real server. Do not use `pkill` patterns that could affect an
unrelated developer process.

## Implementation steps

### Step 1 - Own the real production process

1. Change `tools/check-web-production-start.ts` to launch
   `node start.mjs` with `cwd: apps/web` directly instead of launching the Bun
   package-script wrapper.
2. Keep the exact production entry point and environment used by the supported
   `start` command. Do not test a different server implementation.
3. Make every phase individually bounded with named defaults that tests can
   inject lower values into: 15,000 ms startup, 5,000 ms per HTTP request,
   3,000 ms graceful shutdown, 2,000 ms force-exit wait, and 2,000 ms each for
   stdout/stderr drain. Enforce a 30,000 ms overall ceiling as a final backstop.
   Include the phase name and configured deadline in timeout errors.
4. On success and failure, terminate the owned child and await its exit. Escalate
   to a forceful signal only after the configured 3,000 ms graceful deadline,
   then enforce the configured 2,000 ms force-exit wait.
5. After child exit, bind a temporary server to the same host/port or otherwise
   perform a deterministic port-reuse assertion. Closing the HTTP response is
   not sufficient proof.
6. Assert that log readers complete after process exit. Retain bounded stderr
   diagnostics without printing environment data.
7. If `start.mjs` itself creates a descendant, introduce a documented portable
   process-group strategy and test it. Do not stack signals on an unowned PID.

Extract the lifecycle into a testable helper within the tool (not a production
package). Add `tools/check-web-production-start.test.ts` plus a minimal
`tools/fixtures/production-smoke-listener.mjs` child that really binds the
allocated loopback port and holds both log pipes open. Inject a deliberate HTTP
assertion failure after that child reports listening, then prove graceful or
forced child exit, completed log drains, and real port reuse. Fake clock/process
adapters may cover deadline edges, but they are not evidence for cleanup. The
normal smoke still proves the actual `node start.mjs` process.

Verify:

```sh
bun run build
bun test tools/check-web-production-start.test.ts
time bun run test:web-production
bun run test:web-production
```

Both consecutive runs must exit 0 and the second must bind successfully.

### Step 2 - Create a reusable isolated CLI process harness

Create a test-only helper under `apps/cli/src/test-support/` that:

- launches the real `apps/cli/src/main.ts` with Bun;
- receives explicit argv, stdin, cwd, isolated profile directories, and a
  default 20,000 ms timeout (inject smaller values in timeout tests);
- captures complete stdout/stderr as bytes before resolving;
- reports exit code and signal separately;
- terminates the owned child on timeout;
- creates no implicit real-HOME fallback;
- redacts the temporary absolute path from snapshots only where platform path
  differences would otherwise make assertions unstable.

The helper must remain CLI-specific. Do not export it from an application
package or couple it to the web process runner.

Build the child environment from a small allowlist, not `{ ...process.env }`.
Retain only platform process essentials needed to launch Bun (`PATH`, and on
Windows `SystemRoot`, `ComSpec`, and `PATHEXT`) plus explicitly supplied test
values. Point `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
`XDG_DATA_HOME`, `APPDATA`, `LOCALAPPDATA`, `TMP`, and `TEMP` beneath the test's
temporary root. On Windows derive consistent `HOMEDRIVE`/`HOMEPATH` from that
temporary profile (or omit them only after proving `USERPROFILE` wins on the
supported runtime). Do not inherit provider/perf/config override variables.

Add a cross-platform isolation test with two temporary profiles: the allowed
child profile and a forbidden parent-profile sentinel containing provider-shaped
files. Pass a simulated base environment whose home/profile variables point to
the forbidden profile (do not mutate global `process.env` in a parallel test),
launch through the harness, and assert the child uses only the allowed profile
while sentinel bytes, directory entries, and mtimes remain unchanged. Never use
the developer's real home as the sentinel.

### Step 3 - Cover stateful commands as real processes

Add `apps/cli/src/main.integration.test.ts`. Each test uses a fresh temporary
HOME and cwd unless it explicitly verifies persistence across invocations.

Cover:

1. `machine` on first and second launch: parse the ID and assert it is stable.
2. `machine set-label <label>`: label changes and ID stays stable.
3. `snapshot --out <file>` from deterministic Codex fixture history: exit 0,
   stdout names the file, stderr warnings are expected/bounded, and the output
   parses through the production snapshot parser. Put a minimal fixture builder
   in `apps/cli/src/test-fixtures/codex-history.ts`; write the same documented
   `session_meta` and `token_count` JSONL event shapes already exercised by
   `packages/local-collectors/src/codex-history.test.ts` beneath the temporary
   `$HOME/.codex/sessions/YYYY/MM/DD/` tree. Do not import collector test code.
4. `merge <fixture> --json` and `--csv`: both succeed, render the expected row,
   and do not emit partial output before a failure.
5. `cursor import <valid.csv>` twice using a repository-owned minimal fixture in
   `apps/cli/src/test-fixtures/`: the second call reports idempotent reuse; an
   invalid header exits 1 and creates no artifact.
6. Invalid arguments: exit 1, useful stderr, and no misleading stdout.
7. Report and merge `--html`: explicit rejection after plan 009.
8. Generate a portable merge fixture through report-core's production factory
   with enough deterministic rows that `merge <fixture> --payload-json` emits
   more than 1 MiB. Assert the captured byte count is above 1 MiB, parse the
   complete JSON, and assert the exact row count plus a last-row sentinel. This
   proves pipe draining without checking in a giant fixture.
9. Quota only if a fully local Codex quota fixture already models both success
   and unavailable states. Never make a network request for this test.

All fixture timestamps, IDs, paths, provider values, and expected warnings are
fixed. Do not use current time, live Git state, user histories, or network data.

### Step 4 - Make coverage part of normal tests

1. Confirm the CLI package's existing `test` script discovers
   `main.integration.test.ts` under `src`.
2. Do not add a duplicate root test command if `bun run test` already runs it
   through Turbo.
3. If integration tests require an opt-in environment variable, remove that
   requirement unless there is a measured platform reason; CI must exercise
   them by default.
4. Add Windows-specific skips only around POSIX process semantics, never around
   core CLI behavior.

Verify:

```sh
bun test apps/cli/src/main.integration.test.ts \
  apps/cli/src/cli.test.ts \
  apps/cli/src/snapshot-file.test.ts
bun run test
```

## Test plan

```sh
bun test tools/check-web-production-start.test.ts
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:web-production
bun run test:web-production
bun run test:setup-loopback
```

Run the production smoke twice to catch leaked listeners. During a targeted
failure case, inspect only the owned PID and prove it is gone after cleanup.

## Done criteria

- The production smoke returns to the shell without an external timeout.
- Its server port is reusable immediately after both success and failure paths.
- No descendant retains stdout/stderr pipes.
- The listed CLI commands are covered through real isolated processes.
- Large CLI output is captured completely.
- Normal root tests discover the new suite.
- No test reads or writes the real HOME, repository `.ai-usage`, or live provider
  history.
- POSIX and Windows home/profile variables all resolve beneath the isolated test
  root; the forbidden-profile sentinel remains untouched.

## STOP conditions

- `start.mjs` creates another unowned descendant; design process ownership
  explicitly before proceeding.
- A fix relies on a broad `pkill`, PID-name match, or global port cleanup.
- An unrelated process already owns the target port and cannot be distinguished
  safely.
- CLI coverage requires live provider accounts, network access, or real HOME.
- A proposed test changes production behavior solely to expose internals.
- Platform-specific signal behavior cannot be made bounded; isolate and
  document the platform constraint rather than leaving a hanging test.

## Maintenance note

Every new stateful CLI command should receive at least one real-process happy
path and one failure-path assertion. Process tests must always own their child,
their temporary state, their timeout, and their cleanup.
