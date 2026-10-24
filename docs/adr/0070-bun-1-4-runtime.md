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
