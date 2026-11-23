# Development

How to run, check and test ai-usage while working on it. Contribution rules
(what a change must respect, fixtures, pull requests) are in
[CONTRIBUTING.md](../CONTRIBUTING.md); which workspace owns what is in
[architecture](architecture.md#package-ownership) and
[public package interfaces](public-package-interfaces.md).

## Run against synthetic data

Run the app against deterministic synthetic data without reading local histories:

```sh
bun run demo
```

This isolated runtime binds only to `127.0.0.1`, uses a temporary home, and disables local reads, mutations, source events, and live collector construction. It is intended for development, reproduction, and browser tests.

## Run against this machine's data

Run the report app in development:

```sh
bun run dev
```

This supervises persistent usage-engine and Web tasks with attributable logs.
Web HMR does not restart the engine or trigger collection/publication.
SvelteKit keeps check, development, and production intermediates in separate
`.svelte-kit/{check,dev,build}` trees. The Bun adapter writes production output
to `.output-build/sveltekit`, and concurrent production builds fail through a
narrow lock without deleting active development files.

The dev runtime intentionally reads this machine's configured local data and
refreshes the dashboard through immutable, destination-focused SQLite queries.
Its bounded support bootstrap reports omitted-item counts when summary metadata
does not fit; row-derived destination queries remain independent of those
summary omissions. A failed live bootstrap stays in the route's error/retry
state. Synthetic data is selected only by explicit demo or E2E modes.

## Production build and start

After `bun run build`, start the normal supervised production pair with:

```sh
bun run start
```

`bun run start:web-only` is an explicit diagnostic that reads an existing store
and never starts an engine.

## Checks

`bun run verify` is the broad gate: check, lint, typecheck, tests and build.
The individual gates follow.

Formatting and static checks (Biome through the Ultracite preset), then autofix:

```sh
bun run check
bun run fix
```

Lint (import restrictions, package boundaries, public exports):

```sh
bun run lint
```

Typecheck:

```sh
bun run typecheck
```

The non-Svelte projects are type-checked by the native TypeScript 7 compiler,
installed as `@typescript/native`. The Svelte project stays on `svelte-check`
with TypeScript 6, which remains installed as `typescript`. Both packages
publish a `tsc` binary, so scripts select one explicitly:
`bun x --no-install --package @typescript/native tsc …` (ADR 0093).

### Optional Effect diagnostics

```sh
bun run check:effect
```

This advisory pilot uses pinned `@effect/tsgo` 0.64.1 and its bundled TypeScript
7.0.2 compiler, separate from the `@typescript/native` compiler of the typecheck
gate. It does not patch `node_modules`, replace TypeScript 6, or change
the Biome or Svelte gates. The diagnostics stay advisory and are not a `verify`
gate, but their compiler-fixture tests run via `bun test tools` and are part of
`verify`. The command uses Bun for its launcher
and never downloads a missing executable; run `bun install --frozen-lockfile`
first. It also runs in the repository's `nix develop` shell.

`tsconfig.effect.json` starts from production TypeScript in `effect-runtime`,
`local-machine`, `local-collectors`, and `usage-engine-runtime`. TypeScript follows
their imports, including other workspace source and shared testing helpers;
the exclusions avoid selecting test suites as entry points, not all transitive
imports. Svelte files are still checked by the existing Svelte gate.

The pilot retains the upstream correctness and anti-pattern diagnostics, with
explicit error-channel checks (`unsafeEffectTypeAssertion`,
`effectTryWithoutCatch`, `globalJsonInEffect`, and `returnEffectInGen`). General
style suggestions, API-stability notices, and broad generic-error preferences
are omitted. Three selected simplifications remain visible: `mapConstToAs`,
`provideMergeAllToArray`, and `effectSucceedWithUndefined`. Treat findings as
review candidates: JSON already protected by a domain error handler and
intentional scheduling choices may need no change.

Effect findings are warnings and do not make this command fail. TypeScript
errors, unknown rule names, invalid compiler configuration, and tool failures
still return a failing exit code. Inspect the output even when the command
succeeds; no automatic fixes or diagnostic baseline are applied. The integration
tests in `tools/check-effect.test.ts` exercise the installed compiler, including
this distinction between advisory findings and failures. Recheck them and the
rule policy when upgrading either pinned version.

## Tests

Run unit/integration tests:

```sh
bun run test
```

Run the deterministic browser suites (after `bun x playwright install chromium` once):

```sh
bun run test:e2e
bun run test:e2e-demo
```

After a production build, exercise the supervised loopback lifecycle and the
direct revision-keyed SQLite query path:

```sh
bun run test:web-production
bun run test:web-dev-build-isolation
bun run test:e2e-production
bun run --cwd apps/web benchmark:session-scroll
```

After the build, verify that server-only capabilities stay out of the emitted
browser closure:

```sh
bun run test:web-client-manifest
```

The ordinary suite includes request-policy coverage, axe accessibility checks,
and focused visual snapshots. The demo-isolation suite proves the synthetic
runtime cannot reach local data or control capabilities. The production suite
exercises exact-revision oRPC procedures, verifies explicit secret sentinels stay
out of initial SSR HTML, and runs the 5,000-session scroll proof. Useful bounded
report data is intentionally allowed in the initial payload.

### Optional mutation testing

Mutation-test one package:

```sh
bun run test:mutation packages/report-core --mutate src/work-thread-seeds.ts
```

Stryker (pinned `@stryker-mutator/core` with the `@hughescr/stryker-bun-runner`
test runner) changes the code under `--mutate` and reports each change that no
test detects. The shared `stryker.config.json` runs the package's `src` tests
with per-test coverage, so each mutant runs only the tests that reach it.
Without `--mutate`, Stryker mutates the whole package `src`, which is slow for
the large packages; target the files you changed. Other Stryker options follow
the package directory, for example `--incremental` to reuse earlier results.
The HTML report is written to `<package-dir>/reports/mutation/mutation.html`.
Mutation testing is advisory and is not part of `verify`.

Stryker copies the package into a sandbox under `<package-dir>/.stryker-tmp/`,
so a test that reads a file outside its package through a relative path fails
the initial run (in `apps/web`, the README checks of
`first-run.test.ts`). For such a package, add `--inPlace`, which mutates the
checkout itself and restores it afterwards: run it only in a worktree that no
other session uses. `apps/web` also needs the preparation its `test` script
runs first (`bun --filter @ai-usage/design-system build` and
`bun run --cwd apps/web dev:prepare`). Stryker stops when a test already fails
without mutation; restrict the run with `--testFiles <test-file>` to the tests
that cover the mutated files.
