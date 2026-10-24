# ADR 0070: Run on the Bun 1.4 line, pinned once in `packageManager`

- **Status**: Accepted
- **Date**: 2026-10-22
- **Extends**: 0011

## Context

The repository ran on Bun 1.3.13, pinned in four places: `packageManager`,
`@types/bun`, six `bun-version` inputs across the GitHub workflows, and the
flake's nixpkgs revision. Bun 1.4.0 (2026-08-20) is the first stable release
of the Rust-ported runtime; 1.4.1–1.4.3 fixed its early regressions. An
earlier attempt (`8968ceee`, branch `chore/bun-1.4.0`) stopped at 1.4.0 because
`bun --bun vite` could fail to reach ready when started concurrently under
`turbo watch dev`. Two measurements made on 1.3.13 shaped code that still
runs: `node:zlib` decodes Codex zstd archives because Bun's decompressor
corrupted the heap (2026-10-19), and the CI dev-server retry wrapper absorbs a
startup hang whose root cause is not identified (PR #48, #60).

## Decision

- The runtime is Bun 1.4.3, pinned exactly in `packageManager` and
  `@types/bun`.
- `packageManager` is the single version source for CI: `oven-sh/setup-bun@v2`
  reads it when `bun-version` is absent, so no workflow names a Bun version.
  `apps/web/start.mjs` already enforces the same field at production start.
- The dev shell keeps one runtime with CI through a temporary `flake.nix`
  override of `pkgs.bun` (version and `passthru.sources` for the two Linux
  archives). It is deleted, not maintained, once nixpkgs ships bun >= 1.4.3.
- `node:zlib` stays the zstd decoder and the guard test stays. The 1.3.13
  measurement is recorded as a measurement; nothing has re-qualified Bun's
  decompressor on 1.4.
- `tools/retry-on-dev-server-hang.ts` and its two signatures stay unchanged
  until the hang signature stops appearing in CI.
- The lockfile stays at whatever version Bun 1.4.3 writes for the existing
  lock as long as `bun install --frozen-lockfile` is green; turbo moved to
  2.11.x in the same install because it is the first line that reads a Bun v2
  lockfile.

## Consequences

- One version to move next time: `packageManager`, `@types/bun`, and the flake
  override (or its deletion).
- `@types/bun` 1.4.3 widens `Subprocess.signalCode` to
  `NodeJS.Signals | number | null`; call sites that narrowed it to a string
  must widen with it.
- Runtime behaviour changes in 1.4.x that the test suites exercise:
  `bun:sqlite` `close()` finalises every `query()` statement, `prepare('')`
  throws, `.json()` error text changed, HTTP parsing is stricter, and
  `localhost` resolves to loopback without the resolver.
- `lint-staged` is held at `~17.5.1`. Release 17.6.0 stages every tracked file
  that changed while its tasks ran, not only the staged ones; several sessions
  share this checkout, so a peer's edit made during the pre-commit hook would be
  committed. Move past 17.5 only if a later release can be limited to the staged
  set.

## Rejected alternative

Pinning `bun-version` per workflow next to `packageManager` was rejected: the
two drifted once already (1.4.0 in CI against 1.3.13 in the flake on
`chore/bun-1.4.0`), and setup-bun reads `packageManager` natively.

## Evidence

Gathered on 2026-10-22 in the `chore/upgrade-dependencies` worktree under
`nix develop` (x86_64-linux); logs under the session scratchpad
`logs/batch1-*.log`.

- `nix develop -c bun --version` → `1.4.3` (`1.4.3+c6da4a4d3`);
  `nix develop -c postgres --version` → `PostgreSQL 17.10` on the current
  lock. Archive hashes from `nix store prefetch-file --json`:
  x64-baseline `sha256-H8LtrIQxApCeOhvh2NmALMYHHPB05n6IIx9P/g+LOXs=`,
  aarch64 `sha256-76mBPaXtckI7+Ef5FujSxHwNd2rdlyNUAmp14Q2pqiE=`.
- `bun install --ignore-scripts` on the v1 lock: Bun 1.4.3 kept
  `lockfileVersion: 1`; installed `@types/bun@1.4.3`, `turbo@2.11.10`,
  `lefthook@2.2.2`, `lint-staged@17.6.0`. `bun install --frozen-lockfile
  --ignore-scripts` → `Checked 524 installs across 617 packages (no
  changes)`, exit 0.
- `bun run check` → `Checked 1510 files ... No fixes applied`; `bun run lint`
  → exit 0. `bun run typecheck` and `bun run build` → exit 2, both on
  `apps/cli/src/test-support/run-cli.ts(84,26): TS2322` (the `signalCode`
  widening above); every other `check` and `build` task passed, and the
  `tools/` coverage check and `tsc -p tsconfig.tools.json` passed.
- `bun run test` → exit 0, 3,840 pass / 0 fail, per-package counts identical
  to the 1.3.13 baseline.
- `test:web-production`, `test:web-dev-build-isolation`,
  `test:local-platform`, `test:setup-loopback` → exit 0 each;
  `test:postgres` → 63 pass / 0 fail.
- Through `tools/retry-on-dev-server-hang.ts`, on fresh home directories:
  `test:e2e` → 234 passed, `test:e2e-demo` → 2 passed, both on the first
  attempt (Vite ready in 944 ms and 1078 ms; the wrapper never retried).
- The 1.4.0 `turbo watch dev` hang is not reproduced on 1.4.3: 15 of 15
  cold `bun run dev` starts (engine and web concurrently, every home, config,
  data, cache and temp path on a fresh 0700 directory) printed Vite's
  `Local:` line, in 4.7–12.1 s (ten consecutive runs: 4.7–5.7 s). `SIGINT` to
  the process group (Ctrl-C) and `SIGTERM` to the `bun run dev` pid reaped
  the whole tree in 5 of 5 runs with port 5173 released. `SIGTERM` to the
  whole group makes turbo 2.11.10 force-kill its direct task processes and
  leaves the detached engine child running; that also happens with the
  1.3.13 binary under the same turbo (1 of 2 runs), so it is a turbo
  `SIGTERM` property, not a Bun 1.4 change. The engine refuses a temporary
  root that is not an owned 0700 directory; a 0755 root is a startup
  failure.
- `bun:sqlite` on 1.4.3 exposes `constants.SQLITE_OPEN_NOFOLLOW` (16777216);
  the `Database` options object still accepts only `readonly`, `strict` and
  `safeIntegers`.

### Evidence added 2026-10-24

- **Engine CPU and RSS against `main`.** `tools/measure-usage-runtime-io.ts`
  on its synthetic fixture (seeded Claude and 128 Codex sessions, a fake Codex
  app server, every home, store, cache and temp path in a private root), run
  twice each, alternating, on a shared and loaded machine: `main` at
  `3fde5ae6` on Bun 1.3.13 and Effect 3 against this branch on Bun 1.4.3 and
  Effect 4, both from scratch copies. CPU is the engine task tree (`bun run
  dev:engine`, turbo, the supervisor, the engine, the fake app server) in
  seconds; RSS is its largest process.

  | scenario | `main` CPU s | branch CPU s | `main` RSS MB | branch RSS MB |
  | --- | ---: | ---: | ---: | ---: |
  | cold start (first scan and publication) | 3.31–3.67 | 2.01–2.02 | 315–316 | 317–334 |
  | cold idle, 10 s | 0.13–0.16 | 0.07–0.12 | 212–214 | 317–334 |
  | collection and publication of one new rollout | 0.21–0.24 | 0.13–0.14 | 249 | 303–306 |
  | warm idle, 10 s | 0.21–0.31 | 0.08–0.11 | 266–269 | 303–306 |

  Cold start reached readiness in 5.0 s on the branch against 8.5–10.0 s on
  `main`. The Vite development server of the same runs used 2.6–2.7 CPU s
  during the 10 s cold idle on the branch against 0.3 s on `main`, and peaked
  at 754–824 MB against 593–622 MB; the branch copy carried the concurrent
  web work in progress at the time, so this row is not attributed to Bun.
  Numbers include Effect 4 (ADR 0071) and cannot separate the two upgrades.
  The tool needed three changes to run at all: its development page probe
  looked for the "Usage report" heading the 2026-09 interface refresh removed
  (fixed in the tool: it probes the page title); and in the scratch copies only,
  the `engine-restart` scenario was skipped and the run stopped after warm idle,
  because `engine-restart` fails intermittently (the Web source-control stream
  closes while the engine restarts in development: 9 of 26 runs on copies of
  this branch with and without each of the 2026-10-24 changes, none of them
  deterministic, since one change set that failed twice then passed three
  times; the committed upgrade alone passed 4 of 4 and `main` its one run; the
  Web's 5 s health check closes the stream on any failed status read, so a
  check that lands inside a restart window is the likely cause) and `main`
  fails the later `sessions-query` browser check. Logs: session scratchpad
  `logs/opp2b-measure-*.log`.
- **Orphaned development engine.** The `SIGTERM` case above is fixed: every
  engine the repository spawns (the development supervisor's child, the CLI's
  foreground `once` engine, the production supervisor's engine and web
  children) starts with `--no-orphans`, so it exits when its parent dies. On
  Bun 1.4.3 that exit is abrupt (`SIGKILL`-like: no `SIGTERM` handler, no
  `exit` hook) and also ends the child's own descendants. With an isolated
  home, `bun run dev` stopped by `SIGTERM` to its process group left the engine
  running before the change and nothing after it; the engine left its lock,
  rendezvous and WAL behind, the next `bun run dev` on the same home recovered
  them and became ready, `SIGINT` to the group (Ctrl-C) then stopped everything
  gracefully (lock and rendezvous removed), and `PRAGMA integrity_check` was
  `ok` on both stores. Killing only the supervisor with `SIGKILL` left the engine
  running for minutes before the change (and turbo waiting on its output); with
  it, the engine was gone within 3 s. Tests: `apps/usage-engine/src/dev.test.ts`,
  `apps/cli/src/usage-engine.test.ts`, `tools/start-production.test.ts`.
- **Profiling.** Bun 1.4 writes CPU and heap profiles as Markdown summaries
  on exit (`--cpu-prof-md`, `--heap-prof-md`, next to the Chrome-format
  `--cpu-prof`/`--heap-prof`). A process another one starts, such as the
  engine under its supervisor, is profiled through
  `BUN_OPTIONS="--cpu-prof-md"`, which wrote a `CPU.<timestamp>.md` in the
  working directory on 1.4.3; `BUN_CPU_PROFILE=1` wrote nothing. There is no
  living performance guide to record this in; `docs/performance/` holds
  historical records only.
