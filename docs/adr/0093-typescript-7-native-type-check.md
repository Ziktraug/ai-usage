# ADR 0093: Type-check non-Svelte projects with native TypeScript 7, once per package

- **Status**: Accepted
- **Date**: 2026-11-21

## Context

Workspace packages are consumed as TypeScript source, so a library package emits nothing. Every
library and app package still declared both `"build": "tsc --noEmit"` and `"check": "tsc --noEmit"`,
and turbo's `check`, `test` and `build` tasks all depend on `^build`. `turbo run check` therefore
ran 31 tasks, 28 of them the same `tsc --noEmit`: each package was type-checked twice, and
`turbo run test` and `turbo run build` type-checked every library again as a side effect.

TypeScript 7.0 ships the native compiler as the `typescript` package's `tsc` binary, without the
JavaScript compiler API. Measured on 2026-11-21, TypeScript 7.0.2 reports 0 errors on the 16
projects under `apps/{cli,mcp,usage-engine}` and `packages/*`, on `tsconfig.tools.json` and on
`apps/web/tsconfig.e2e.json`, the same result as TypeScript 6.0.3, in 4.8 s run one after the
other against 37.9 s.

Three tools need the JavaScript compiler API that TypeScript 7.0 does not ship: `svelte-check`,
`svelte-kit sync`, and `tools/check-typescript-coverage.ts`. TypeScript 6 therefore cannot be
replaced; both versions have to be installed.

## Decision

1. **Two installed compilers.** `typescript` stays 6.0.x for `svelte-check`, `svelte-kit sync` and
   the compiler-API coverage tool. TypeScript 7 is installed beside it under the alias
   `@typescript/native` (`npm:typescript@7.0.2`), the alias form `svelte-check` documents.
2. **Non-Svelte projects are type-checked by TypeScript 7.** Each `check` script of
   `apps/{cli,mcp,usage-engine}` and `packages/*`, the root `typecheck` step for
   `tsconfig.tools.json`, and the Web `typecheck` step for `apps/web/tsconfig.e2e.json` run the
   native compiler. The Svelte project (`apps/web/tsconfig.json`) stays on `svelte-check` with
   TypeScript 6; `check:svelte` is unchanged.
3. **`tsc` is always invoked with an explicit package**:
   `bun x --no-install --package @typescript/native tsc …` (or `--package typescript` for
   TypeScript 6). Both packages publish a `tsc` binary, so `node_modules/.bin/tsc` is whichever
   one the installer linked last. A bare `tsc` in a `package.json` script is not allowed.
   `--no-install` makes a missing install fail instead of downloading a compiler. Verified on Bun
   1.4.4: with `.bin/tsc` forced onto TypeScript 6, `--package @typescript/native` still runs
   7.0.2, and with the alias absent the command exits 1.
4. **Library packages have no `build` script.** Type-checking belongs to `check`. Only
   `@ai-usage/design-system` (Panda codegen, cssgen and the `panda lib` manifest) and
   `@ai-usage/web` (the production build) keep a `build`. The design-system `build` no longer
   type-checks; the Web production build still runs the Web `typecheck` through its wrapper
   (`apps/web/sveltekit-production-build.ts`). `turbo.json` is unchanged: turbo keeps a package
   without the script as an empty node, so `^build` still orders
   `@ai-usage/design-system#build` before the Web tasks.

This does not contradict the superseded [ADR 0011](0011-sveltekit-bun-runtime.md), whose context
notes that root tools may remain on TypeScript 6: the tools that need the compiler API still do.
`check:effect` is also unchanged; it runs the compiler bundled with `@effect/tsgo`, not
`@typescript/native`.

## Rejected alternative

**`svelte-check --tsgo`, to move the Svelte project to the native compiler too.** Tested on
2026-11-21 and rejected: it reports 18 false implicit-`any` errors on callbacks passed to
`@ai-usage/design-system/svelte` components, because Svelte files outside the tsconfig root are
not typed in that mode, and `--tsgo-experimental-api` crashes under Bun.

## Consequences

- `turbo run check` executes 18 tasks instead of 31: 16 package checks, the design-system build
  and the Web check. `turbo run build` executes only the design-system and Web builds.
- A type error in a library no longer fails `turbo run test` or `turbo run build` through
  `^build`, and `bun --filter @ai-usage/design-system build` no longer type-checks the design
  system. `bun run typecheck` is the gate that reports both; `bun run verify` and CI run it.
- Source shared with the Web app is checked by TypeScript 7 in its own project and by
  TypeScript 6 through `svelte-check` where the Web project imports it. The coverage tool still
  resolves project file lists with the TypeScript 6 API.
- A new package copies the explicit `check` form. In a root or workspace `package.json` script, a
  `tsc` invocation without `bun x --no-install --package …`, or a `build` script that invokes
  `tsc`, fails `bun test tools`. The guard reads script text only: it does not see workflows,
  hooks, or a type-check reached through another script, as in the Web build wrapper.

## Revisit when

TypeScript 7.1 is stable with its compiler API, and `svelte-check` supports the native compiler
properly (sveltejs/language-tools #3193 and #3142). Then one TypeScript version can serve every
project and the `@typescript/native` alias can go.

## Evidence

- Scripts: the `check` script of each workspace `package.json`, and `typecheck` in the root and
  `apps/web` manifests.
- Guards: `tools/check-typescript-coverage.test.ts` (every `tsc` invocation in a manifest script
  selects its package; no `build` script invokes `tsc`; the root `typecheck` steps).
- Coverage: `tools/check-typescript-coverage.ts` lists the projects `bun run typecheck` executes.
