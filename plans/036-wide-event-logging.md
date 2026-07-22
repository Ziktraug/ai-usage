# Plan 036: Wide-event logging for Effect program executions

> **Executor instructions**: Follow this plan in order. Run every verification
> command and confirm the expected result before continuing. If a STOP condition
> occurs, preserve the worktree and report it instead of improvising. Update the
> status in `plans/README.md` only after every success criterion passes.
>
> **Prior art** (read before editing code):
> - `../../exalibur-svelte/packages/effect-runtime`
> - `../../exalibur-svelte/docs/adr/0011-effect-runtime-and-wide-event-hop-tree-observability.md`
> - `../../exalibur-svelte/plans/done/020-wide-event-logging-effect-runtime.md`
> - `../../../github/exalibur` branch `feat/XLB-0/effect-poc`
>   (`packages/effect-runtime/src/observability`, `timer`)
> - Local ADRs:
>   `../docs/adr/0001-boundary-scoped-observability-on-bounded-workers.md`
>   and `../docs/adr/0002-effect-runtime-package-for-wide-events.md`
>
> Port the model, not either package wholesale. Keep boundary-owned emission,
> immutable hop reconstruction, a current-parent `FiberRef`, canonical
> sanitize-on-emit, and a bounded async file appender. Drop Exalibur-specific
> environment labels, OpenAPI blocks, cache summaries, and slow-span views.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 022-024 (Effect control plane and scoped Nitro Bun runtime)
- **Category**: observability, Effect runtime, local filesystem
- **Planned at**: commit `4e2cc48`, 2026-07-21
- **Design reviewed**: 2026-07-21
- **Docs**: `CONTEXT.md` terms **Wide event** and
  **Effect program execution**; ADRs 0001-0002

## Drift Check

Run before implementation:

```sh
git status --short
git diff --stat 4e2cc48..HEAD -- \
  packages/report-data/src/source-control.ts \
  packages/report-data/src/source-control-state.ts \
  packages/report-data/src/provider-quota-refresh.ts \
  packages/report-data/src/provider-quota.ts \
  apps/web/server/plugins \
  apps/web/src/server/source-control.server.ts \
  apps/web/src/server/report-payload.server.ts \
  apps/web/src/server/revision-query-runner.server.ts \
  apps/cli/src/main.ts \
  tools/check-package-boundaries.ts
bun test packages/report-data/src/source-control.test.ts \
  packages/report-data/src/provider-quota.test.ts
```

If scoped behavior changed after `4e2cc48`, update the current-state facts and
tests in this plan before implementation. Do not overwrite unrelated worktree
changes.

## Why This Matters

`ai-usage` already runs collectors, publication, quota refresh, web reads, and
CLI commands through Effect. Observability is split across `console.error`,
optional `[perf]` lines, and state projections that do not tell the complete
story of one execution.

A wide event gives an operator one bounded, structured record for an actual
boundary execution: what ran, its business outcome, elapsed time, meaningful
child hops, and allowlisted local context. It does not require OpenTelemetry or
change the browser/SSE contract.

## Non-goals (v1)

- OTLP export or `traceparent` propagation
- Remote log aggregators, Sentry, browser logs, or SSE/debug-panel mirroring
- Persisting logs in SQLite or the usage store
- Instrumenting pure `report-core` functions
- Migrating every existing `AI_USAGE_PERF` span
- Slow-span thresholds or derived cache views
- Logging raw `Cause`, provider bodies, filesystem records, or transcripts
- Refactoring the source-control worker pool
- A durability guarantee for observability records

## Locked Architecture

### 1. Boundary ownership

One **outer application or control-plane boundary** owns one wide event. A
reusable helper never emits its own event merely because it uses Effect.

An execution is a fresh boundary scope, not necessarily a fresh carrier fiber.
The existing bounded source-control workers remain in place. A worker loop is
not a boundary; a runnable job inside it is. The boundary runner creates a fresh
controller, `Ref`, and root span for every invocation and restores the current
hop `FiberRef` afterward.

Start a control-plane boundary only after `startSourceJobTransition` or
`startPublicationJobTransition` confirms that work will run. Queue admission,
stale jobs, skipped jobs, and long-lived loops do not emit.

| Owner | Event boundary | Nested operations |
| --- | --- | --- |
| Runnable source-control source job | `source.run` | collector, persistence, quota owner work |
| Runnable publication job | `publication` | capture, revision lookup/commit, materialization |
| Selected finite web adapter | `web.sessions.read` | revision lease and bounded runner |
| CLI quota command | `cli.quota` | one-shot source and quota owner work |

`quota.refresh` is normally a hop, not a second event. Inside the single-flight,
the selected owner records `quota.refresh`; joiners record
`quota.refresh.wait`. Interrupting a joiner affects its enclosing boundary but
must not mark the shared owner work interrupted. If a future application adapter
invokes quota refresh without another boundary, that adapter may explicitly own
a `quota.refresh` event.

### 2. Outcomes describe business results

```ts
type BoundaryOutcome =
  | 'success'
  | 'degraded'
  | 'failure'
  | 'interrupted'
  | 'timed-out';
```

The boundary runner has a safe default classifier for Effect exits and accepts
a total, observability-only classifier for domains that encode failure in a
success value. If a custom classifier throws, the runner falls back to the
Effect exit classification; observability never changes the program result.

Required mappings:

- Effect success -> `success`
- typed failure or defect -> `failure`
- interruption-only cause or `ProviderQuotaRefreshAborted` -> `interrupted`
- source `timed-out` completion -> `timed-out`
- source warnings/unavailable result -> `degraded`
- publication `undefined` failure result -> `failure`
- quota live/backfill failure returned with usable stored data -> `degraded`
- quota success without a degraded sub-result -> `success`

Known tagged errors may contribute an allowlisted public tag, code, and public
message. Generic `Error.message`, `Cause.pretty`, stack traces, defects, and raw
causes never enter the snapshot or a default console/file sink.

### 3. Canonical event contract

```ts
type LogScalar = boolean | number | string | null;
type LogValue =
  | LogScalar
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };

interface SanitizedTaggedError {
  readonly tag: string;
  readonly code?: string;
  readonly message?: string;
}

interface WideEventSnapshot {
  readonly schemaVersion: 1;
  readonly event: 'wide-event';
  readonly eventId: string;
  readonly boundary: string;
  readonly startedAt: string;
  readonly emittedAt: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly outcome: BoundaryOutcome;
  readonly durationMs: number;
  readonly error: SanitizedTaggedError | null;
  readonly annotations: Readonly<Record<string, LogValue>>;
  readonly services: readonly ServiceHop[];
}

interface ServiceHop {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly outcome: BoundaryOutcome;
  readonly durationMs: number;
  readonly annotations?: Readonly<Record<string, LogValue>>;
  readonly children?: readonly ServiceHop[];
}
```

Use `Clock.currentTimeNanos` for elapsed duration and UTC ISO wall-clock values
for `startedAt`/`emittedAt`. Enable Effect's native tracer without an exporter.
The boundary owns a root `Effect.withSpan`; every `withMeasured` hop owns a child
span, so trace and span ids are required rather than synthetic or optional.

`eventId` is a fresh `randomUUID`. Boundary names are stable constants owned by
their application adapters. Each boundary defines allowlisted annotation keys;
callers never spread arbitrary domain inputs, request objects, records, or
errors into annotations.

### 4. Hop tree and emission

`withMeasured` opens one hop. A flat atomic list stores completed hops with
`id`, `parentId`, and sequence. A `FiberRef` stores only the current parent hop
id. Emission reconstructs the immutable tree in sequence order, so parallel
children cannot lose updates and tests remain deterministic.

The public `WideEventService` can annotate or measure but cannot emit. Only the
boundary-private controller can finalize. Its atomic emitted flag guarantees a
single canonical snapshot and one submission to each configured sink on
success, degraded completion, failure, timeout, or interruption.

Final classification, sanitization, and sink submission run in an
uninterruptible finalizer. Submission is bounded and best-effort; sink failure
is swallowed after updating sink diagnostics and never replaces the business
exit.

### 5. Sanitization and budgets

Sanitize before the canonical snapshot is returned or submitted. Sinks accept
only a `WideEventSnapshot` and defensively serialize it again. Sanitization must
handle cycles, throwing getters/proxies, `bigint`, Effect `Secret`/`Redacted`
values, non-finite numbers, and serialization errors.

V1 named limits:

- 256 KiB maximum serialized event
- 256 completed hops and 16 hop levels
- 64 keys per annotation object and 8 annotation levels
- 128 array items
- 4 KiB per string; 1 KiB for public error messages

Truncation is deterministic and adds `observabilityTruncated: true` at the root.
If the final byte budget is still exceeded, emit a minimal safe snapshot that
retains identity, timestamps, boundary, outcome, duration, and the truncation
marker. Sensitive-looking keys (`token`, `password`, `authorization`, `secret`,
`cookie`) are replaced case-insensitively, but key redaction is only defense in
depth: boundary annotation allowlists remain mandatory.

### 6. Shared package API

```ts
class WideEventService extends Context.Tag('...')<WideEventService, WideEventShape>() {}
class WideEventSink extends Context.Tag('...')<WideEventSink, WideEventSinkShape>() {}

interface BoundaryClassification {
  readonly outcome: BoundaryOutcome;
  readonly error?: SanitizedTaggedError | null;
  readonly annotations?: Readonly<Record<string, LogValue>>;
}

interface BoundaryRunOptions<A, E> {
  readonly boundary: string;
  readonly annotations?: Readonly<Record<string, LogValue>>;
  readonly classify?: (exit: Exit.Exit<A, E>) => BoundaryClassification;
}

const runBoundaryEffect: <A, E, R>(
  options: BoundaryRunOptions<A, E>,
  effect: Effect.Effect<A, E, R | WideEventService>,
) => Effect.Effect<A, E, R | WideEventSink>;

interface MeasuredOptions<A, E> {
  readonly classify?: (exit: Exit.Exit<A, E>) => BoundaryOutcome;
}

const withMeasured = <A, E>(
  name: string,
  options?: MeasuredOptions<A, E>,
) => <R>(effect: Effect.Effect<A, E, R>):
  Effect.Effect<A, E, R | WideEventService>;

const withMeasuredIfAvailable = <A, E>(
  name: string,
  options?: MeasuredOptions<A, E>,
) => <R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
```

`withMeasuredIfAvailable` uses `Effect.serviceOption(WideEventService)`. It is a
no-op when no outer boundary exists and is reserved for reusable infrastructure
such as the quota single-flight owner/joiner split. It never creates or emits a
wide event. Its optional total classifier handles domain results such as a
partially failed quota refresh; classifier failure falls back to the Effect exit
outcome and cannot affect the wrapped operation.

`@ai-usage/effect-runtime` imports no domain workspace package. Runtime-neutral
model/runner exports and Node-only sink exports use separate package subpaths.

### 7. Sink and lifecycle contract

- **Web**: NDJSON file plus pretty stderr when `process.stderr.isTTY`; one-line
  JSON stderr when non-TTY or `LOG_FORMAT=json`.
- **CLI**: NDJSON file only, including on failures. No wide-event or sink
  diagnostic output on stdout/stderr.
- **Tests**: injected capture or no-op sink; no mutable global event state.

The file sink owns a bounded queue of 128 accepted records. Offer never waits
for filesystem I/O. Queue-full drops the new record and increments a diagnostic
counter. A single scoped worker performs serialization and async appends with a
one-second timeout; a timeout opens the file circuit for the process and drops
pending records. Scope close drains for at most two seconds, then interrupts the
worker.

Resolve `AI_USAGE_LOG_DIR` only when it is absolute. Otherwise walk upward from
the Node sink module location until a parsed `package.json` identifies the
`ai-usage` workspace, then use `<root>/logs`. If neither succeeds, install a
no-op file sink.

On POSIX, create/repair the owned directory as `0700` and files as `0600`.
Reject symlink, non-directory/non-regular, and multi-link lock/log paths before
use; do not chmod through aliases and do not change the process umask.

All target selection, size checks, append, rotation, and sweep occur inside a
bounded cooperative interprocess lock. Never append unlocked after lock timeout.
Rotate before `currentSize + lineBytes` would exceed 50 MiB. Under the same lock,
retain the newest 30 matching regular files by `(mtime, filename)` and ignore
unrelated entries. Test stale-lock recovery and concurrent web/CLI writers in
subprocesses.

The web Nitro plugin owns one process-scoped `ManagedRuntime` containing the
sink and source-control layers. Finite web adapters execute their selected
Effect boundaries through the same runtime. Nitro close and hot reload dispose
that runtime once. The CLI runs inside `Effect.scoped`; the file-sink finalizer
finishes before its explicit `process.exit` decision.

## Work Packages

### WP0 - Freeze contracts with tests

1. Add package-level model/classifier tests before implementation.
2. Cover default success/failure/interruption and custom `timed-out`,
   `degraded`, and swallowed-domain-failure classifications.
3. Add fixtures containing secrets, cycles, throwing getters, `bigint`, deep
   values, too many hops, and an oversized event.
4. Confirm the existing source-control baseline and queue behavior are unchanged.

Verify:

```sh
bun test packages/effect-runtime/src/model.test.ts \
  packages/effect-runtime/src/sanitize.test.ts
bun test packages/report-data/src/source-control.test.ts
```

### WP1 - Build `@ai-usage/effect-runtime`

1. Create the package with runtime-neutral model, boundary runner, classifier,
   hop controller, sanitizer, capture/no-op sinks, and Node-only exports.
2. Use `Effect.withSpan`, `Effect.withTracerEnabled(true)`, and the monotonic
   Effect clock. Keep emission private to the boundary controller.
3. Test nested/parallel hops, deterministic order, sequential boundaries on one
   fiber, emit-once, and finalization on interruption.
4. Add the inverse package-boundary policy and declared public exports.

Verify:

```sh
bun test packages/effect-runtime/src
bun run --cwd packages/effect-runtime check
bun run lint
```

### WP2 - Implement private bounded Node sinks

1. Implement pretty/JSON console sinks and the scoped async file sink exactly as
   specified above.
2. Add workspace-root resolution, absolute override validation, `0700`/`0600`
   enforcement, no-follow/single-link validation, interprocess locking,
   rotation, retention, queue bounds, circuit breaking, and scoped drain.
3. Use subprocess tests for concurrent writers and CLI-style explicit exit.
4. Prove every filesystem/serialization failure leaves the supplied business
   Effect result unchanged.

Verify:

```sh
bun test packages/effect-runtime/src/node
bun run --cwd packages/effect-runtime check
```

### WP3 - Compose one web runtime

1. Extend the scoped Nitro runtime so one `ManagedRuntime` owns the web sink and
   source-control layers. Do not create one appender per route.
2. Expose a server-only helper for finite adapters to run an Effect boundary
   through that runtime.
3. Preserve hot-reload, SIGINT/SIGTERM, production-smoke, and exactly-once
   disposal behavior. Add `@ai-usage/effect-runtime` to the persistent runtime
   package list.
4. Select pretty versus JSON from stderr TTY and `LOG_FORMAT`; inject silence in
   unit/E2E fixtures.

Verify:

```sh
bun test apps/web/src/server/persistent-source-runtime.test.ts \
  apps/web/src/server/source-control.server.test.ts
bun run --cwd apps/web check
```

### WP4 - Instrument control-plane jobs without changing workers

1. Keep the current worker pool. Place `source.run` and `publication` boundaries
   only inside successful start decisions.
2. Refactor the internal job result just enough for custom classification to see
   source completion and publication failure values. Do not expose raw errors.
3. Annotate allowlisted `sourceId`, counts, warnings count, changed flag,
   revision, queue delay, and domain outcome. Add measured hops around real
   collector/persistence and publication seams; do not invent phase names that
   the code cannot own.
4. Test sequential isolation, `workerCount > 1` isolation, swallowed failures,
   timeout, active shutdown interruption, stale jobs without events, and
   unchanged queue depth/order/cadence/publication wake behavior.

Verify:

```sh
bun test packages/report-data/src/source-control.test.ts \
  apps/web/src/server/source-control.server.test.ts
bun run --cwd packages/report-data check
```

### WP5 - Instrument quota, one web read, and one CLI command

1. Inside the quota single-flight, measure owner work as `quota.refresh` and
   joiners as `quota.refresh.wait` only when an outer event is available.
2. Test owner success/degradation/failure/interruption, joiner interruption, and
   exactly one owner hop. Classify returned partial failures as `degraded`; a
   joiner must never emit or reclassify owner work.
3. Wrap one exact-revision Session read as `web.sessions.read` using the shared
   web runtime; annotate only revision and canonical request fingerprint.
4. Wrap the CLI quota command as `cli.quota` before the existing error handlers.
   Compose only the file sink and await scope finalization before `process.exit`.
5. Remove overlapping root `[perf]` lines on these instrumented paths. Detailed
   legacy `AI_USAGE_PERF` spans outside the boundary migration remain a v1
   non-goal.

Verify:

```sh
bun test packages/report-data/src/provider-quota.test.ts \
  apps/web/src/server/revision-query-runner.server.test.ts \
  apps/cli/src/main.integration.test.ts
bun run --cwd apps/cli check
bun run --cwd apps/web check
```

### WP6 - Documentation and closure

1. Update `docs/architecture.md`, `docs/public-package-interfaces.md`, package
   ownership READMEs, `.gitignore`, and the persistent runtime package list.
2. Confirm `CONTEXT.md`, both ADRs, event types, outcome mappings, permissions,
   and actual composition roots match the implementation.
3. Add a short execution log with exact commands/results, then mark plan 036
   `DONE` only if all criteria pass.

Verify:

```sh
bun run check
bun run lint
bun run typecheck
bun run test
git diff --check
```

## STOP Conditions

- `report-core` imports Effect or `@ai-usage/effect-runtime`
- `@ai-usage/effect-runtime` imports another `@ai-usage/*` package
- raw `Cause`, stack, generic error message, provider body, record, path, prompt,
  transcript, credential, or cookie enters an event or default sink
- a reusable helper emits a nested wide event
- a stale/skipped queue job emits, or an active job fails to emit on interruption
- source-control workers, queue admission, backpressure, or ordering are refactored
- process-global mutable event/controller state is shared across executions
- filesystem I/O blocks a business fiber
- file writes occur without the cooperative lock or through symlink/multi-link paths
- CLI wide events or sink diagnostics reach stdout/stderr
- web routes create independent file appenders
- sink, classifier, sanitizer, or renderer failure changes a business result
- OTLP, Sentry, remote export, SSE, or debug-panel scope enters this plan

## Success Criteria

- [x] Existing bounded workers and queue behavior are unchanged
- [x] Every runnable source/publication job gets fresh isolated event state
- [x] Stale/skipped jobs emit nothing; active shutdown emits `interrupted`
- [x] Domain failures, degradation, timeout, and interruption are classified honestly
- [x] Canonical snapshots are sanitized, versioned, timestamped, traced, and bounded
- [x] Hop nesting/parallelism is deterministic and event emission is exactly once
- [x] Web owns one scoped file + console sink; CLI owns one scoped file-only sink
- [x] CLI failure events drain before explicit exit without terminal pollution
- [x] File queue, lock, permissions, rotation, retention, and multi-process tests pass
- [x] Quota owner/joiner semantics produce one owner hop and no nested event
- [x] `source.run`, `publication`, `web.sessions.read`, and `cli.quota` are wired
- [x] Package boundaries, public exports, docs, lint, types, and tests are green

## References

- Stripe canonical log lines and Charity Majors' wide-event guidance
- Exalibur `@exalibur/effect-runtime` hop-tree implementation
- Plans 022-024, which own the control plane instrumented here
