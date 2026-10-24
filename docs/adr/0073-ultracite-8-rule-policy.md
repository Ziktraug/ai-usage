# ADR 0073: Ultracite 8 rule policy

- **Status**: Accepted
- **Date**: 2026-10-22; amended 2026-10-24 (platform-only text removed,
  [ADR 0074](0074-local-only-single-operator-product.md)) and 2026-10-24
  (nursery rules turned on)

> Amended 2026-10-24: plan 120 phase A deletes `apps/server` and Better Auth, so
> this record no longer names the server's diagnostics, the root `pg` and
> `@types/pg` declarations, or the server's database URL, base URL and Device
> token key ring parsers and shared authentication's base URL parser as
> redaction boundaries. The rule decisions are unchanged.

> Amended 2026-10-24 (nursery rules): two Biome nursery promise rules and five
> Svelte nursery guards are on. See "Amendment 2026-10-24: nursery rules" at the
> end.

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
- `style/useErrorCause`: Biome 2.5.15 accepts a cause only as a `{ cause }`
  object literal in the second constructor argument. The repository's typed
  errors take a trailing `options?: ErrorOptions`, which is often the third or
  a later argument (`new MemoryRepositoryError(code, operation, { cause })`),
  and `AggregateError` keeps the caught errors in `errors`. With the rule on,
  the repository needed 61 suppressions. 53 of them marked correct code: 40
  causes passed in a trailing `ErrorOptions`, 12 `AggregateError`s and one
  positional cause (`HistoryArchiveError`). The cause convention below still
  applies. Review enforces it, not the linter.

### Rules kept and fixed

- `style/useConsistentMethodSignatures`: interface and type-literal members
  use property style (`run: (sql: string) => unknown`). Property-style
  members are checked contravariantly, while method signatures stay
  bivariant. This exposed one real looseness. The SQLite statement ports of
  the served-revision and session-query readers declared `(...params:
  unknown[])` and passed those values to `bun:sqlite`, which binds only SQL
  values. Those ports now take `SqliteQueryBinding`
  (`bigint | boolean | null | number | string | Uint8Array`), so a raw
  `bun:sqlite` `Database` satisfies them without a cast. In `apps/web`,
  `packages/design-system` and the remaining `tools/` scripts the same
  conversion exposed no type error.
- `suspicious/noShadow`: the inner binding is renamed. Behaviour does not
  change.
- `correctness/noUndeclaredDependencies`: every workspace declares what it
  imports. Root scripts and `tools/` belong to the root package, so it declares
  the `@ai-usage/*` packages they import as `workspace:*` devDependencies, and
  `effect` with the same specifier as the workspaces that own it.
  `tools/check-package-boundaries.ts` polices only `@ai-usage/*` workspaces,
  so the root declarations do not weaken it.
  `packages/design-system` declares `vite`, `playwright` and
  `@sveltejs/vite-plugin-svelte`, which its browser and SSR tests import, as
  devDependencies with the versions `apps/web` pins.
- `complexity/noUselessReturn`, `suppressions/unused` and
  `assist/source/useSortedPackageJson` are applied as reported. A `return;`
  that was the only statement of a `catch` becomes a comment that says why the
  failure reads as `undefined`.

### Error cause convention

An error created in a `catch` carries the caught error as `cause`. Typed error
classes take a trailing `options?: ErrorOptions` and pass it to `super`. Their
public messages and codes do not change. The engine and MCP diagnostics print
a closed vocabulary. CLI output prints the error's own message, and wide
events classify errors without walking the `cause` chain.
The `cause` is still visible wherever a whole error object is printed to the
local terminal, for example SvelteKit's default log of an unexpected server
error or Bun's report of an uncaught error.

That is why a redaction boundary never attaches a cause. There the caught
error can carry secret material, so the thrown error stays deliberately
opaque, and a plain `// No cause: redaction boundary, ...` comment above the
`throw` says what the cause would leak. A Bun URL parse error keeps the raw
input, credentials included, in `input`. A JSON parse error quotes the
document it rejects, such as the private Device credential or a token-bearing
rendezvous file. The boundaries are the replication client's base URL parser,
the private Device credential reader, the usage-engine rendezvous reader and
the Memory service client.

`AggregateError` and its subclasses keep the caught errors in `errors` and
take no separate `cause`.

## Consequences

- `ultracite check` is clean across the repository, `apps/web` and
  `packages/design-system` included.
- `lefthook.yml` and `.lintstagedrc.json` are unchanged. They call
  `lint-staged` and `ultracite fix`, and both commands kept their interface.
- No linter catches a `catch` that drops the cause any more. Review checks the
  convention, and a redaction boundary documents itself with its `No cause:`
  comment.
- Promise concurrency, nullish checks and runtime validation guards stay as
  written. Re-enabling one of the seven rules needs a new ADR.

## Rejected alternatives

- Keeping `useErrorCause` on with justified suppressions: this took 61
  `biome-ignore lint/style/useErrorCause` comments. 53 of them only told the
  rule about a cause it could not see, which hid the 8 real redaction
  decisions among them, and every new typed-error call site in a `catch`
  would have needed another one. Turning the rule off loses the check of the
  plain `throw new Error(message)` inside a `catch`, which Biome reads
  correctly. The convention above covers that case.
- Putting `ErrorOptions` second in every typed error constructor: this would
  churn hundreds of call sites (`MemoryRepositoryError` alone has 135) only
  to fit the rule's positional check.
- Fixing `noAwaitInLoops` with `Promise.all`: this changes ordering and
  resource bounds, which tests would catch only by luck.

## Amendment 2026-10-24: nursery rules

**Context.** Ultracite 8.0.1 turns on one nursery rule, `useSortedClasses`, and
leaves the rest of Biome's nursery group off. Two nursery rules check promise
handling: `noFloatingPromises` and `noMisusedPromises`. The defects they catch
are easy to miss in review. Before they were turned on, they reported 8 and 10
diagnostics. Five Svelte nursery rules reported none.

**Decision.** `biome.json` turns these nursery rules on at `error`:

- `noFloatingPromises`: a promise statement must be awaited, returned, stored
  where something awaits it, or given a rejection handler.
- `noMisusedPromises`: a promise must not be used where it is almost certainly
  a mistake, for example as a condition (a promise is always truthy).
- `noSvelteAtDebugTags`: no `{@debug}` is left in a template.
- `noSvelteAtHtmlTags`: no `{@html}`, which renders unescaped markup.
- `noSvelteExportLet`: component props come from `$props()`, not `export let`.
- `noSvelteUnnecessaryStateWrap`: no `$state(...)` around a class that is
  already reactive, such as `SvelteMap`.
- `useSvelteKitRuneImports`: app state comes from `$app/state`, not
  `$app/stores`.

The five Svelte rules are guards: the code already follows them, and a
planted violation of each is reported as an error under this configuration.

The 18 promise diagnostics were resolved in code, apart from two suppressions:

- `apps/usage-engine/src/process.ts`: when a second signal forced shutdown, the
  observer of a late rendezvous removal or control-server disposal was chained
  to the settled outcome with no rejection path. The reporter parameter was
  optional, so a caller that left it out would have lost the late failure
  without a trace. No live failure was found: the outcome never rejects, and
  both call sites pass a reporter that cannot throw. The observer now handles
  the cleanup's own rejection and reports it, as the runtime disposal path
  already did, and the reporter is required. A test rejects both cleanups after
  forced termination and expects one report each.
- The usage-engine runtime's pending handoff diagnostics (`live.ts`) and pending
  file-input cleanups (`runtime-command-coordinator.ts`) each kept one promise
  and removed it from a second chain that nothing observed. Each now keeps the
  end of its own chain, which disposal awaits.
- One web test observed two pending queries with `.finally`. It now passes the
  same marker as both handlers of `.then`, and each awaited query still fails
  the test if it rejects. Another test started a late cleanup and then waited a
  fixed number of microtasks for it. It now awaits that cleanup.
- All 10 `noMisusedPromises` diagnostics tested a `Promise | undefined` slot
  for presence, for example `if (active)`. Biome 2.5.15 treats the union as
  always truthy. The checks now compare against `undefined`, which says what
  they test.
- Suppressions: 2, both `lint/nursery/noFloatingPromises` in
  `apps/web/src/lib/query/options/memory-workspace.ts`, which calls TanStack
  Query's `fetchPreviousPage` and `fetchNextPage` without observing the result.
  TanStack Query 5 resolves those promises and records a failure in the query's
  error state unless `throwOnError` is set, so they never reject.

`void` is not used to mark a promise as ignored, although the rule accepts it.
Ultracite's core preset turns on `complexity/noVoid`, and `void` would hide a
rejection, not handle it.

Three other nursery rules stay off because the code does not follow them yet:
`noSvelteLegacyConst` (94 diagnostics), `useSvelteRequireEachKey` (27) and
`usePromiseRejectErrors` (6).

**Consequences.**

- `ultracite check` stays clean with these rules on. A new unobserved promise
  statement, or a promise used as a condition, fails `bun run check`.
- Nursery rules are not stable. A Biome minor or patch release may change what
  they report, their options, their group or their name. A rule that leaves the
  nursery may also get a different default severity. Biome is pinned exactly
  (`"@biomejs/biome": "2.5.15"`, with `ultracite` at `8.0.1`). A Biome upgrade
  reruns `ultracite check` across the repository and reviews this list before
  it lands. Biome 2.5.15 rejects an unknown rule key in `biome.json` (`Found an
  unknown key`), so a rule whose key disappears fails loudly and is not
  silently ignored.
- A further suppression of these rules needs a reason that says why the
  promise cannot reject or is awaited elsewhere. Turning one of them off is a
  dated amendment to this record that states the diagnostics count.
