# ADR 0056: Run every Effect surface on Effect 4

- **Status**: Accepted
- **Date**: 2026-10-22
- **Amends**: [ADR 0001](0001-boundary-scoped-observability-on-bounded-workers.md)

## Context

The usage engine, the CLI, the web server reads and the shared packages
(`effect-runtime`, `usage-store`, `local-machine`, `local-collectors`,
`report-data`, `usage-merge`, `usage-engine-runtime`) were written against
Effect 3. Effect 4.0 (GA 2026-10-01) is a major release: a rewritten fiber
runtime, renamed combinators (`catchAll` → `catch`, `either` → `result`,
`fork` → `forkChild`, `async` → `callback`, …), `Either` replaced by `Result`,
`FiberRef` replaced by `Context.Reference`, `Context.Tag` replaced by
`Context.Service`, a flat `Cause`, `Effect.runPromise` rejecting with the typed
failure itself instead of a `FiberFailure` wrapper, `Effect.timeout` that
awaits the interrupted source (no `Effect.disconnect`), layer memoisation
shared across `Effect.provide` calls within one fiber tree, and a scheduler that
dispatches yields through `setImmediate` rather than microtasks.

The repository relies on several of these semantics: the best-effort wide-event
sink must bound how long an uninterruptible boundary finalizer waits for a
transport; the current-hop carrier of ADR 0001 must stay fiber-local and
inheritable; the source-control tests must wait until a timer is registered
with the test clock before advancing it; and the Promise boundaries in the web
server and the CLI surface typed store failures as values.

## Decision

Migrate the whole repository to `effect@^4.0.5` in one change, using the
idiomatic v4 API rather than compatibility shims. The migration preserves
behaviour except where the new rejection shape makes typed error handling that
Effect 3 had silently disabled take effect; those changes are kept on purpose
and listed under Consequences.

- Services are `Context.Service` classes; the current-hop carrier is a
  `Context.Reference` scoped with `Effect.provideService`.
- `Either` at Promise boundaries becomes `Result` (`Effect.result`,
  `Result.isFailure`, `.failure`/`.success`); the Result-then-throw pattern
  stays because it keeps the typed failure explicit even though `runPromise`
  now rejects with it directly.
- The best-effort sink forks the transport detached, awaits its exit with a
  `timeoutOption`, and abandons it (signals interrupt without waiting) whenever
  the wait ends without that exit: the budget is spent, or the wait itself is
  interrupted, as when an enclosing combined sink's budget runs out first. Tests
  prove an uninterruptible transport cannot hold an uninterruptible caller
  beyond the budget and a hanging transport behind a combined sink is
  interrupted when the combined submission is abandoned.
- `run*` evaluates the effect synchronously before it looks at an `AbortSignal`,
  so the usage-engine writer gate checks an already-aborted signal before it
  runs anything; otherwise a free permit would start an uninterruptible write
  that Effect 3 never started.
- Tests read the test clock from `effect/testing`; the source-control tests
  record pending sleeps through a wrapper around the real `TestClock` instead
  of the removed `TestClock.sleeps`, so their synchronisation stays exact.
- `FiberMap.run`/`FiberHandle.run` keep the v4 default (start immediately);
  timer registration becomes synchronous with the state transition that
  announces it, which only strengthens the ordering the tests rely on.
- Code that unwrapped `FiberFailure` is deleted; `runPromise` rejections are
  the typed error, the defect, or an `Error` for interrupt-only causes.

## Consequences

- No Effect 3 API name remains in `packages/`, `apps/` or `tools/`; the grep
  for `FiberRef`, `Either`, `TestContext`, `catchAll`, `Context.Tag`,
  `GenericTag`, `Layer.scoped`, `Effect.fork(`, `yieldNow()`, `disconnect`,
  `withConsole` and `isFiberFailure` is part of the migration evidence.
- Yields now reach the macrotask queue, so the explicit `Effect.sleep(0)`
  slicing in the Codex collector keeps its purpose (op-count yielding still
  cannot split one long synchronous parse) and its comment is rewritten.
- `Effect.runSync`/`runPromise` rejections are plain values: callers that
  format an error message see the typed error's own message, not a pretty
  printed cause.
- Deliberate behaviour change in the usage engine: errors thrown inside the
  writer gate (`writerGate.run`) used to reach the command coordinator wrapped
  in a `FiberFailure`, so its `UsageEngineCommandError` and
  `UsageEngineFatalConsistencyError` branches never matched and every such
  failure completed as `command-failed` (after a fatal error the gate itself
  still closed, but the engine stayed ready and kept admitting commands whose
  writes then failed). They now match, as the coordinator was
  written to do: a merge file with invalid JSON completes `merge-invalid-json`
  (the web upload answers 400), a stale project-source selection completes
  `command-rejected`, and an unreconciled machine-label compensation puts the
  engine in the degraded `mutation-consistency-unknown` state, closes command
  admission, rejects queued commands with `engine-busy` and stops the drain
  until restart recovery. `live.test.ts` pins these outcomes through the live
  mutation port, the writer gate and the coordinator.
- `usage-engine check` now reports the store's typed reason (for example
  `schema-too-new`) instead of always `storage-failure`, because
  `inspectStore` receives the `UsageStoreError` itself.
- Future Effect upgrades follow this ADR's method: mapping table verified
  against the installed `.d.ts`, dependency-ordered package migration, and
  repeated runs of the timing-sensitive suites.

## Rejected alternative

A compatibility layer re-exporting the Effect 3 names (`catchAll`, `either`,
`fork`, …) on top of Effect 4 would have shrunk the diff but left two
vocabularies in the codebase and hidden the semantic changes (timeout
interruption, rejection shape, fork start) behind familiar names.

## Evidence

- `packages/effect-runtime/src/sink.ts` and `sink.test.ts` (submit budget,
  abandoned combined submission).
- `packages/usage-engine-runtime/src/writer-gate.ts` and `writer-gate.test.ts`
  (pre-aborted signal), `live.test.ts` (typed command outcomes and the degraded
  consistency state).
- `apps/usage-engine/src/process-check.test.ts` (typed store reason).
- `packages/effect-runtime/src/wide-event.ts` (`currentWideEventHop` reference).
- `packages/usage-engine-runtime/src/source-control.test.ts`
  (`makeRecordingTestClockLayer`).
