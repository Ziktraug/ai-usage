# ADR 0059: Ultracite 8 rule policy

- **Status**: Accepted
- **Date**: 2026-10-22

## Context

Ultracite 8.0.1 (on Biome 2.5.15, see plan 119 D2/D3) keeps the `check` and
`fix` commands and the preset entry names, but its `core` preset turns on about
45 more error rules. A repository-wide `ultracite check` on the upgraded tree
reported 1,844 diagnostics. Biome could fix none of them automatically except
the `package.json` key order. Per rule:

| Rule | Diagnostics |
| --- | --- |
| `performance/noAwaitInLoops` | 473 |
| `style/useDestructuring` | 382 |
| `style/noIncrementDecrement` | 211 |
| `style/useConsistentMethodSignatures` | 194 |
| `suspicious/noShadow` | 108 |
| `correctness/noUndeclaredDependencies` | 107 |
| `style/useErrorCause` | 104 |
| `suspicious/noUnnecessaryConditions` | 82 |
| `suspicious/noReturnAssign` | 60 |
| `suspicious/noEqualsToNull` | 57 |
| `assist/source/useSortedPackageJson` | 33 |
| `complexity/noUselessReturn` | 25 |
| `suppressions/unused` | 8 |

Some of these rules find real defects, or make one class of defect impossible
to write. Others only restate a style the repository does not use. A few would
change behaviour if their diagnostics were "fixed".

## Decision

### Rules turned off repository-wide

`biome.json` turns these rules off under `linter.rules`. Biome 2.5.15 rejects
comments in `biome.json`, so the reasons are recorded here:

- `performance/noAwaitInLoops`: the sequential awaits are deliberate. They
  cover ordered writes, bounded readers that must not fan out, migrations
  that apply in order, and test steps whose order is the point of the test.
  Rewriting them as `Promise.all` would change concurrency semantics.
- `style/useDestructuring`: style only.
- `style/noIncrementDecrement`: style only.
- `suspicious/noEqualsToNull`: `value == null` is the repository's deliberate
  nullish check.
- `suspicious/noReturnAssign`: it fires on idiomatic Svelte handlers such as
  `onclick={() => (open = false)}`, which Biome 2.5.15's own formatter
  produces.
- `suspicious/noUnnecessaryConditions`: it judges conditions from declared
  types. Runtime guards at untyped boundaries (parsed JSON, stored rows,
  subprocess output, hostile proxies) are deliberate validation and must not
  be removed because a type says they cannot fail.

### Rules kept and fixed

- `style/useConsistentMethodSignatures`: interface and type-literal members
  use property style (`run: (sql: string) => unknown`). Property-style
  members are checked contravariantly, while method signatures stay
  bivariant. This exposed one real looseness. The SQLite statement ports of
  the served-revision and session-query readers declared `(...params:
  unknown[])` and passed those values to `bun:sqlite`, which binds only SQL
  values. Those ports now take `SqliteQueryBinding`
  (`bigint | boolean | null | number | string | Uint8Array`), so a raw
  `bun:sqlite` `Database` satisfies them without a cast.
- `suspicious/noShadow`: the inner binding is renamed. Behaviour does not
  change.
- `correctness/noUndeclaredDependencies`: every workspace declares what it
  imports. Root scripts and `tools/` belong to the root package, so it declares
  the `@ai-usage/*` packages they import as `workspace:*` devDependencies, and
  `effect`, `pg` and `@types/pg` with the same specifiers as the workspaces
  that own them. `tools/check-package-boundaries.ts` polices only
  `@ai-usage/*` workspaces, so the root declarations do not weaken it.
- `complexity/noUselessReturn`, `suppressions/unused` and
  `assist/source/useSortedPackageJson` are applied as reported.
- `style/useErrorCause`: an error created in a `catch` carries the caught error
  as `cause`. Typed error classes take a trailing `options?: ErrorOptions` and
  pass it to `super`. Their public messages and codes do not change. The
  engine, server and MCP diagnostics print a closed vocabulary. CLI output
  prints the error's own message, and wide events classify errors without
  walking the `cause` chain. The `cause` is still visible wherever a whole
  error object is printed to the local terminal, for example SvelteKit's
  default log of an unexpected server error or Bun's report of an uncaught
  error. That is why a redaction boundary never attaches one (case 3 below).

  Biome 2.5.15 accepts a cause only as a `{ cause }` object literal in the
  second constructor argument. In three cases the code is correct and the
  rule cannot see that. Those sites carry a justified
  `biome-ignore lint/style/useErrorCause` comment:

  1. The cause is passed in a trailing `ErrorOptions` argument that is not the
     second argument, for example `new MemoryRepositoryError(code, operation,
     { cause })`. Moving `ErrorOptions` to the second position would rewrite
     hundreds of call sites. The same holds for a positional cause
     (`HistoryArchiveError`).
  2. `AggregateError` and its subclasses already keep the caught errors in
     `errors`.
  3. Redaction boundaries. Here the caught error can carry secret material, so
     the thrown error stays deliberately opaque. A Bun URL parse error keeps
     the raw input, a database password included, in `input`. A JSON parse
     error quotes the document it rejects, such as the private Device
     credential or a token-bearing rendezvous file. The Device token key ring
     is secret by definition.

  If Biome learns to read `ErrorOptions` in other positions, the first kind
  of suppression shows up as `suppressions/unused` and is deleted.

## Consequences

- `ultracite check` is clean outside `apps/web` and `packages/design-system`.
  Those two are linted under the same policy once their framework upgrades
  (SvelteKit 3, Panda 2) land.
- `lefthook.yml` and `.lintstagedrc.json` are unchanged. They call
  `lint-staged` and `ultracite fix`, and both commands kept their interface.
- A new `throw new Error(...)` inside a `catch` without a cause fails the
  check. A redaction boundary has to say so in its suppression.
- Promise concurrency, nullish checks and runtime validation guards stay as
  written. Re-enabling one of the six rules needs a new ADR.

## Rejected alternatives

- Turning `useErrorCause` off: it would also stop catching the common case,
  `throw new Error(message)` inside a `catch`, which Biome checks correctly.
- Putting `ErrorOptions` second in every typed error constructor: this would
  churn hundreds of call sites (`MemoryRepositoryError` alone has 135) only
  to fit the rule's positional check.
- Fixing `noAwaitInLoops` with `Promise.all`: this changes ordering and
  resource bounds, which tests would catch only by luck.
