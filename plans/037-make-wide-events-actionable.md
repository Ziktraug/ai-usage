# Plan 037: Make wide events truthful, actionable, and readable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
>
> ```sh
> git status --short
> git diff --stat a186682..HEAD -- \
>   packages/effect-runtime \
>   packages/report-data/src/source-control.ts \
>   packages/report-data/src/source-control-state.ts \
>   apps/web/server/plugins/source-control.ts \
>   apps/web/src/server/revision-query-runner.server.ts \
>   apps/web/src/server/source-control.server.ts \
>   apps/cli/src/main.ts \
>   docs/adr \
>   docs/architecture.md \
>   CONTEXT.md
> ```
>
> This plan was written against commit `a186682` plus the uncommitted
> post-review changes already present on 2026-07-22. In particular, the expected
> baseline has a one-line pretty renderer, business classifiers for Session and
> CLI quota results, queue-delay annotations, and the bounded file-sink shutdown
> follow-up. Do not discard or overwrite those local changes. If the current
> files do not match the excerpts and facts below, stop and report the drift.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/036-wide-event-logging.md` (DONE)
- **Category**: bug, security, performance, DX, architecture, tests, docs
- **Planned at**: commit `a186682`, 2026-07-22, with the dirty-worktree baseline described above

## Why this matters

Plan 036 established a strong wide-event foundation: bounded and sanitized
NDJSON, fresh event state per execution, deterministic measured-hop trees,
private file permissions, safe shutdown, and business-aware outcomes. The
follow-up audit found that the canonical records are structurally sound but the
operator experience and a few event semantics are incomplete.

The current TTY projection renders every real event above 160 characters and
routes every outcome through `console.error`; the result wraps without semantic
indentation and makes routine success look like failure. The selected Session
boundary can also emit `success` before result parsing later returns
`QueryFailed`. File-sink losses are counted but invisible in production, most
failure/degradation events lack a bounded reason code, and the persisted records
cannot identify their producer version or correlate source changes with the
publication generations that consume them.

This plan fixes those issues without weakening the guarantees from plan 036.
The NDJSON remains the exhaustive machine record. The terminal becomes a
purpose-built projection with severity, progressive detail, and application-
owned summaries. The source-control worker pool, product results, privacy
boundary, and best-effort delivery contract remain unchanged.

## Evidence from the audit

The executor does not need the original audit session. These are the measured
facts behind the plan:

- `logs/wide-events-2026-07-21.ndjson` and
  `logs/wide-events-2026-07-22.ndjson` contain 470 parseable records.
- All 470 `eventId`, root `spanId`, and root `traceId` values are unique; all
  hop trace IDs match their owning event; timestamps and durations are
  consistent; no credential was found by the audit.
- Outcome distribution is 460 `success`, 8 `degraded`, and 2 `failure`.
- Boundary distribution is 221 `web.sessions.read`, 212 `source.run`, 35
  `publication`, and 2 `cli.quota`.
- Applying the current renderer to those records produces line lengths of 166
  minimum, 174 median, 243 p95, and 271 maximum. Every line exceeds 160
  characters before the Turbo/Bun prefix is added.
- All 221 `web.sessions.read` events have no measured service hop. Across all
  records, 223 of 470 events have no hop.
- For source and publication events with one hop, the boundary minus hop
  overhead is approximately 1.3 ms at p50. The hop usually repeats the root
  duration rather than decomposing it.
- Of 147 records with `queueDelayMs`, 40 exceed one second and the maximum is
  5,054 ms. `cursor.commit-attribution` has roughly 3,043 ms queue-delay p50
  for roughly 7.8 ms execution p50. This is evidence for a separate scheduler
  investigation, not permission to change the worker pool in this plan.
- The 30-day file retention contract can mix events produced by different code
  versions, but schema v1 has no producer/version/resource context.

## Current state

### Canonical model and boundary

- `packages/effect-runtime/src/model.ts` defines schema v1 with event identity,
  boundary, timing, outcome, sanitized error, arbitrary annotations, and a hop
  tree. It has no producer resource.
- `packages/effect-runtime/src/boundary.ts` creates a new root trace for each
  boundary and computes `durationMs` before best-effort sink submission.
- `packages/effect-runtime/src/wide-event.ts` reconstructs immutable services
  from completed hops and sanitizes once before returning a snapshot.
- Plan 036 deliberately rejected cross-service trace propagation. Keep traces
  scoped to one boundary; use explicit domain generation fields for causal
  relations that are many-to-one.

Current model excerpt (`packages/effect-runtime/src/model.ts:23-37`):

```ts
export interface WideEventSnapshot {
  readonly annotations: Readonly<Record<string, LogValue>>;
  readonly boundary: string;
  readonly durationMs: number;
  readonly emittedAt: string;
  readonly error: SanitizedTaggedError | null;
  readonly event: 'wide-event';
  readonly eventId: string;
  readonly outcome: BoundaryOutcome;
  readonly schemaVersion: 1;
  readonly services: readonly ServiceHop[];
  readonly spanId: string;
  readonly startedAt: string;
  readonly traceId: string;
}
```

### Session boundary truthfulness and depth

`apps/web/src/server/revision-query-runner.server.ts:248-274` currently runs
only `dependencies.execute` inside `web.sessions.read`. The validated projection
is built afterward:

```ts
const execution =
  kind === 'sessions'
    ? await getWebSourceControlRuntime().runEffect(
        runBoundaryEffect(options, Effect.tryPromise(() => dependencies.execute(executeRequest))),
      )
    : await dependencies.execute(executeRequest);

return {
  data: request.parseResult(execution.serializedPayload),
  ok: true,
  requestFingerprint: request.fingerprint,
  revision: request.revision,
};
```

If `parseResult` rejects a malformed payload, fingerprint, or revision, the
client receives `QueryFailed` after an already-emitted success event. The plan
036 boundary table also expected revision execution and parsing-related work to
be visible, while the current 221 persisted events have `services: []`.

### Failure and degradation details

`packages/report-data/src/source-control.ts:305-321` converts a typed source
failure into `{ _tag: 'failed' }`; the stable failure category is discarded.
Successful degraded results retain bounded `SourceWarning.code` values, but
`sourceRunAnnotations` logs only `warningsCount`. Publication failures similarly
become `undefined` without a stable `failureKind` annotation.

`packages/effect-runtime/src/classifier.ts:18-32` reads `publicMessage`, then
falls back to a generic `.message` for three allowlisted tags:

```ts
const message =
  readOwnString(value, 'publicMessage') ?? readOwnString(value, 'message');
```

`packages/effect-runtime/src/sanitize.ts:159-178` bounds that string but does
not scrub credential-shaped substrings. Current records did not expose a
credential; this is defensive hardening before more boundaries are added.

### Console projection

`packages/effect-runtime/src/node/console-sink.ts:74-103` joins header,
annotations, services, error, and ID with ` | ` and uses `console.error` for
every outcome. `packages/effect-runtime/src/node/file-sink.test.ts:196-219`
currently freezes the one-line behavior with a minimal synthetic fixture.

The domain-free package decision in
`docs/adr/0002-effect-runtime-package-for-wide-events.md` remains valid. Do not
teach `@ai-usage/effect-runtime` what `sourceId`, revisions, or Session pages
mean. Instead, inject a pure presentation projector from the web application.

### File delivery diagnostics and retention

`packages/effect-runtime/src/node/file-sink.ts:181-348`:

- defaults `warn` to a no-op;
- counts accepted, dropped, and failed deliveries;
- opens its circuit only after `withTimeout` returns an `AppendBlockedError`;
- after an append timeout, waits for a non-cooperative pending append before
  returning the timeout, so the circuit is not visible at the deadline;
- selects a target and runs a full retention sweep under the interprocess lock
  for every record.

`packages/effect-runtime/src/node/index.ts:35-70` does not provide a web warning
sink, and production code does not read `diagnostics()`. The CLI silence
contract is intentional and must remain unchanged.

### Repository conventions to preserve

- Use Effect services/layers at executable boundaries. Do not introduce a
  process-global mutable event or controller.
- Keep `@ai-usage/effect-runtime` independent of every other `@ai-usage/*`
  package. `tools/check-package-boundaries.ts` enforces this.
- Prefer stable low-cardinality codes over messages. Existing exemplars are
  `SourceWarning.code` and `SourceReason.code` in
  `packages/report-core/src/source-control.ts`.
- Use a `FiberRef` only for request/execution-local parentage. Do not use it for
  process resource metadata.
- Keep application-specific formatting in `apps/web/src/server`; the runtime
  package owns only generic rendering mechanics.
- All logger/sink failures remain best-effort and must not change a product
  Effect result.
- Tests use Bun's `describe`/`test`/`expect`, injected clocks/writers, and
  deterministic sanitized fixtures. Match
  `packages/effect-runtime/src/node/file-sink.test.ts` and
  `apps/web/src/server/revision-query-runner.server.test.ts`.
- Follow the root `AGENTS.md` Ultracite standards. Run `bun x ultracite fix`
  only after reviewing its scope; never accept unrelated formatting changes.

## Target architecture

### 1. Truthful boundaries

`web.sessions.read` owns the complete observable result: bounded execution,
schema/fingerprint/revision validation, projection, and final protocol mapping.
It emits `success` only if the result returned to the caller is successful.

Use these measured operations:

- `revision.execute`: the Promise-based revision lease plus bounded artifact
  execution as one live Effect hop;
- `revision.parse`: synchronous JSON/schema/fingerprint/revision validation as
  a second Effect hop.

Do not refactor the revision registry from Promise to Effect solely for
telemetry. Instead, let the default execution dependency return bounded phase
timings such as `leaseWaitMs` and `boundedRunnerMs`; annotate those on the
`revision.execute` hop while it is current. This gives useful decomposition
without creating a second runtime or losing the current wide-event service.

For a successful Session page, annotate only allowlisted summaries:

- `queryKind: 'sessions'`;
- `pageSize`;
- `hasCursor`;
- `itemCount`;
- `sessionCount`;
- `hasMore` (`nextCursor !== null`).

Keep `fingerprint` and `revision`; never log the raw query, filter text, cursor,
serialized request, serialized payload, rows, paths, or prompt-derived fields.

### 2. Explainable, safe outcomes

Every non-success event must have a stable, bounded reason when the domain
already owns one:

- source Effect failure: `failureKind: 'source-run-error'`;
- source timeout: `failureKind: 'source-timeout'`;
- source unavailable/degraded result: `unavailableCode` from the bounded domain
  enum/code;
- source warnings: sorted unique `warningCodes`, capped by the existing source
  warning budget;
- publication failure: `failureKind: 'publication-failed'`;
- revision expiry: `failureKind: 'revision-expired'`;
- invalid or failed revision result: `failureKind: 'query-failed'`.

Do not persist raw causes, stack traces, arbitrary exception messages, provider
bodies, filesystem records, requests, or response payloads. Default tagged-error
classification may use `_tag`, `code`, and explicit `publicMessage`; it must not
fall back to generic `.message`. Any explicitly approved public error message
must pass a bounded credential-string scrubber before persistence or console
rendering.

### 3. Schema v2 resource context

Promote producer identity to a typed top-level resource rather than hiding it
inside occurrence annotations:

```ts
export interface WideEventResource {
  readonly instanceId: string;
  readonly runtimeMode: 'development' | 'production' | 'test' | 'unknown';
  readonly serviceName: 'ai-usage';
  readonly serviceVersion: string;
  readonly surface: 'cli' | 'web';
}

export interface WideEventSnapshot {
  readonly schemaVersion: 2;
  readonly resource: WideEventResource;
  // Existing v1 fields remain with the same meaning.
}
```

Add a domain-free `WideEventResourceService` and layer in
`@ai-usage/effect-runtime`. Executable adapters provide the values once per
process. Generate `instanceId` once at the composition root; do not use a new ID
per event. The service name/version/mode/surface are configuration values, not
read from the environment inside the generic package.

Existing v1 NDJSON files are historical append-only data and must not be
rewritten. New records use schema v2. Any repository-owned log-analysis fixture
or parser touched by this plan must accept both v1 and v2 while treating the
resource as absent for v1.

### 4. Domain correlation without abusing trace IDs

Keep one fresh trace per boundary. Correlate source-to-publication work with the
existing monotonic control-plane generations:

- add the resulting dirty generation to the finish decision for a source that
  changed data, and annotate it as `publicationDataGeneration`;
- add `previousPublishedGeneration`, `dataTarget`, and `requestTarget` to the
  publication start decision and publication event;
- add a stable low-cardinality `trigger` to `SourceJob`, distinguishing at
  least `cadence`, `detection`, `manual`, and `dependency` admission;
- never create an unbounded array of causal event IDs for a coalesced
  publication.

The generation interval
`previousPublishedGeneration < publicationDataGeneration <= dataTarget`
identifies source changes consumed by a publication while preserving the
many-to-one semantics.

### 5. Terminal projection separated from storage

The file sink always receives every event. Console selection is independent:

- `success` maps to `info`;
- `degraded`, `interrupted`, and `timed-out` map to `warn`;
- `failure` maps to `error`;
- `LOG_LEVEL=debug|info|warn|error` controls console filtering only;
- default `info` preserves all events;
- `debug` shows the complete hop tree and remaining annotations;
- `info` shows one short semantic summary and only useful direct hops;
- `warn` and `error` expand anomaly context automatically;
- JSON console output remains one compact JSON object per physical line;
- pretty TTY output may be multi-line but is written as one console call;
- the CLI remains file-only and emits no wide-event or sink diagnostic output.

Define a generic projection contract in the runtime package, for example:

```ts
export interface PrettyWideEventView {
  readonly details?: readonly string[];
  readonly subject: string;
  readonly summary?: readonly string[];
}

export type PrettyWideEventProjector = (
  event: WideEventSnapshot,
) => PrettyWideEventView;
```

The generic fallback uses `event.boundary` as the subject and renders bounded
annotations only at debug/anomaly detail. The web projector lives in a new
`apps/web/src/server/wide-event-presentation.server.ts` and handles known
boundaries without importing Node sink internals.

Representative info output, after stripping ANSI:

```text
10:18:33.342Z ✓ cursor.commit-attribution 5.0ms  unchanged  38→38  queue=293ms  event=bd0aa8a8
10:18:30.323Z ✓ publication 372.0ms  changed  revision=mrvx…  event=7f2d1c9b
```

Representative debug expansion:

```text
10:18:33.342Z ✓ cursor.commit-attribution 5.0ms  unchanged  38→38  queue=293ms  event=bd0aa8a8
└─ ✓ source.execute 4.1ms
resource web/development ai-usage@0.1.0 instance=91c2f83a
```

Do not hardcode a target line width by truncating the whole rendered event.
Bound individual values and ensure the info header fixture stays at or below 140
characters without the task-runner prefix. Preserve complete values in NDJSON.

### 6. Observable best-effort file delivery

Keep delivery best-effort, but make its failure state visible:

- define stable warning kinds: `append-failure`, `append-timeout`,
  `circuit-open`, `queue-full`, `lock-timeout`, and `sweep-failure`;
- warnings contain only kind, fixed message, and bounded counters;
- rate-limit each warning kind to at most once per 30 seconds;
- route web file-sink warnings directly to the console warning channel, never
  back through the file sink;
- keep CLI warnings silent;
- expose per-transport diagnostics (`file`, `console`) rather than presenting a
  sum of deliveries as a count of logical events;
- on web runtime shutdown, emit one console-only summary only when a sink has
  dropped or failed records.

At the append deadline, mark the circuit open and reject/drop new submissions
immediately, even if the active append ignores `AbortSignal`. Keep the private
append task and cooperative lock alive until the actual I/O settles; never
release the lock early and never start a second append concurrently.

### 7. Bounded retention work

Continue selecting the active target under the cooperative interprocess lock on
every append; another process may have rotated it. Run the full retention sweep
only on the first successful append in a process and when the selected target
filename changes because of a day or size rotation. This preserves eventual
30-file retention while removing the second directory scan/stat/sort from the
steady-state path.

Do not cache file size across processes, batch records into a single write, or
weaken no-follow/single-link/permission checks in this plan.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Runtime tests | `bun test packages/effect-runtime/src` | all tests pass |
| Source tests | `bun test packages/report-data/src/source-control.test.ts packages/report-data/src/provider-quota.test.ts` | all tests pass |
| Web/CLI tests | `bun test apps/web/src/server/revision-query-runner.server.test.ts apps/web/src/server/source-control.server.test.ts apps/cli/src/main.integration.test.ts` | all tests pass |
| Runtime typecheck | `bun run --cwd packages/effect-runtime check` | exit 0, no diagnostics |
| Repository typecheck | `bun run typecheck` | 18 tasks pass |
| Lint | `bun run lint` | exit 0, no lint or boundary errors |
| Full tests | `bun run test` | all workspace and tool tests pass |
| Formatting check | `bun run check` | Ultracite exits 0 |
| Diff hygiene | `git diff --check` | no output, exit 0 |

Do not run `bun install`; the verified workspace already has its dependencies.

## Scope

**In scope** (the only implementation files that may be modified or created):

- `packages/effect-runtime/src/model.ts`
- `packages/effect-runtime/src/model.test.ts`
- `packages/effect-runtime/src/boundary.ts`
- `packages/effect-runtime/src/boundary.test.ts`
- `packages/effect-runtime/src/classifier.ts`
- `packages/effect-runtime/src/sanitize.ts`
- `packages/effect-runtime/src/sanitize.test.ts`
- `packages/effect-runtime/src/sink.ts`
- `packages/effect-runtime/src/wide-event.ts`
- `packages/effect-runtime/src/index.ts`
- `packages/effect-runtime/src/resource.ts` (create if the service is kept separate)
- `packages/effect-runtime/src/node/console-sink.ts`
- `packages/effect-runtime/src/node/console-sink.test.ts` (create)
- `packages/effect-runtime/src/node/file-sink.ts`
- `packages/effect-runtime/src/node/file-sink.test.ts`
- `packages/effect-runtime/src/node/index.ts`
- `packages/effect-runtime/README.md`
- `packages/report-data/src/source-control.ts`
- `packages/report-data/src/source-control.test.ts`
- `packages/report-data/src/source-control-state.ts`
- `packages/report-data/src/source-control-state.test.ts`
- `apps/web/src/server/revision-query-runner.server.ts`
- `apps/web/src/server/revision-query-runner.server.test.ts`
- `apps/web/src/server/source-control.server.ts`
- `apps/web/src/server/source-control.server.test.ts`
- `apps/web/server/plugins/source-control.ts`
- `apps/web/src/server/wide-event-presentation.server.ts` (create)
- `apps/web/src/server/wide-event-presentation.server.test.ts` (create)
- `apps/cli/src/main.ts`
- `apps/cli/src/main.integration.test.ts`
- `docs/adr/0008-wide-event-presentation-provenance-and-delivery.md` (create)
- `docs/architecture.md`
- `docs/public-package-interfaces.md`
- `CONTEXT.md`
- `plans/037-make-wide-events-actionable.md`
- `plans/README.md`

If generated formatting changes are required in an in-scope file, they are
allowed. Revert or exclude unrelated generated output before completion.

**Out of scope** (do not touch even if related):

- Existing files under `logs/`; do not rewrite, migrate, normalize, or commit
  observed events.
- The source-control worker count, queue implementation, backpressure,
  scheduling priority, cadence, publication ordering, and RTK dependency rules.
- OTLP exporters, remote logging, Sentry, browser logging, SSE/debug panels, or
  log persistence in SQLite.
- Raw Effect `Cause`, stack traces, provider payloads, session rows, prompts,
  transcripts, raw filters, cursors, serialized requests, and serialized
  responses.
- HTTP/cache-specific fields copied from `../exalibur-svelte`.
- Changes to CLI stdout/stderr product output.
- A new logging dependency or terminal-color dependency.
- Refactoring the Promise-based revision registry beyond the small diagnostic
  timing result described above.
- Broad migration of legacy `AI_USAGE_PERF` instrumentation.
- Compression, log shipping, or a durability guarantee.

## Git workflow

- Continue on the operator-selected branch; do not discard the current dirty
  worktree and do not create or switch branches without instruction.
- Make one commit per coherent work package only after its verification passes.
- Match the existing imperative commit style, for example
  `Implement wide-event logging` or `Document wide-event CI follow-up`.
- Do not push or open a pull request unless the operator explicitly asks.

## Steps

### Step 0: Freeze the audited behavior with characterization tests

Before changing production code:

1. Move console-specific tests out of
   `packages/effect-runtime/src/node/file-sink.test.ts` into the new
   `console-sink.test.ts` so presentation and file delivery have separate
   ownership.
2. Add sanitized fixtures matching the real shapes of `source.run`,
   `publication`, `web.sessions.read`, one degraded event, and one failed event.
3. Add a characterization test proving the current Session mismatch: a
   successful execution with an invalid Session result currently returns
   `QueryFailed` while the capture sink records `success`. Mark the assertion as
   the red test to be changed in Step 1; do not commit a permanently failing
   suite.
4. Add helpers that strip only the ANSI codes emitted by the renderer. Do not
   add snapshots containing local paths, real revisions, real fingerprints, or
   copied log records.
5. Record the current relevant test counts in the plan execution log section
   when implementation starts.

**Verify**:

```sh
bun test packages/effect-runtime/src/node/console-sink.test.ts \
  packages/effect-runtime/src/node/file-sink.test.ts \
  apps/web/src/server/revision-query-runner.server.test.ts
```

Expected: all committed characterization tests pass; the test description for
the Session mismatch clearly names the behavior Step 1 will reverse.

### Step 1: Make `web.sessions.read` own the final result

1. Introduce an internal execution result that can carry optional bounded phase
   timings from `defaultDependencies.execute`. Keep the injected test dependency
   ergonomic; omitted diagnostics must be accepted and must not invent zero
   timings.
2. In the default dependency, measure with a monotonic clock:
   - time from lease request to the registry invoking the lease callback;
   - time spent in `runBoundedArtifactProcess`.
   Bound values with the same maximum-duration policy used elsewhere.
3. Build the Session Effect so `revision.execute` wraps the execution Promise.
   While that hop is current, attach the available phase timings as hop
   annotations.
4. If execution returns `ok: false`, return the final `RevisionExpired` protocol
   result from inside the boundary and classify it as failure with
   `failureKind: 'revision-expired'`.
5. If execution returns `ok: true`, run `request.parseResult` inside
   `withMeasured('revision.parse')` using `Effect.try`. Map validation or parsing
   errors to the final `QueryFailed` protocol result inside the boundary and
   classify it as failure with `failureKind: 'query-failed'`.
6. On success, annotate the allowlisted Session page summary and return the
   exact existing success protocol shape. Non-Session query kinds keep their
   current behavior.
7. Do not duplicate parsing outside the boundary.
8. Extend tests for:
   - success with both hops and output annotations;
   - expired revision -> one failure event;
   - malformed JSON -> one failure event;
   - valid JSON with mismatched fingerprint -> one failure event;
   - valid JSON with mismatched revision -> one failure event;
   - dependency rejection -> one failure event;
   - product result parity for every case.

**Verify**:

```sh
bun test apps/web/src/server/revision-query-runner.server.test.ts
```

Expected: all tests pass; every `sessions` invocation emits exactly one event,
and event outcome equals the final protocol result.

### Step 2: Preserve bounded anomaly reasons and harden public messages

1. Extend internal `SourceExecutionCompletion` failure/timeout variants with a
   stable code, not an error object. Keep all raw `SourceRunError.cause` values
   out of control state and telemetry.
2. Add `failureKind`, `unavailableCode`, and sorted unique `warningCodes` to
   source annotations only when applicable. Retain counts and domain outcome.
3. Add a fixed `failureKind` for publication failure. Do not attach the
   publication port's unknown failure value.
4. Update Session and CLI classifiers to return stable failure/degradation
   annotations where their domain result already owns a code.
5. Change default tagged-error projection to use explicit `publicMessage` only;
   remove fallback to generic `.message`.
6. Add a small, top-level, reusable string scrubber in the sanitizer for
   approved public error messages. It must redact credential-bearing URL query
   values and common authorization credential forms while preserving a bounded
   diagnostic prefix. Keep the patterns compiled at module scope.
7. Test fake credential-shaped strings in public error messages, unknown tags,
   hostile accessors, stable source failure codes, warning-code deduplication,
   and absence of raw cause/message data in serialized output.

**Verify**:

```sh
bun test packages/effect-runtime/src/model.test.ts \
  packages/effect-runtime/src/sanitize.test.ts \
  packages/report-data/src/source-control-state.test.ts \
  packages/report-data/src/source-control.test.ts \
  apps/cli/src/main.integration.test.ts
```

Expected: all tests pass; no test snapshot or serialized event contains its
fake credential value or a raw source/publication cause.

### Step 3: Add schema v2 resource context and generation correlation

1. Add `WideEventResource`, `WideEventResourceService`, and a resource layer to
   the runtime-neutral package. Validate/bound all resource strings through the
   canonical sanitizer; hostile or oversized configuration must produce bounded
   fallback values rather than break a product Effect.
2. Make `runBoundaryEffect` require the resource service in production
   composition. Tests may use an explicit deterministic test resource helper;
   do not hide missing production composition behind an implicit process-global
   default.
3. Update `WideEventSnapshot` to schema v2 with the required `resource` field.
   Update minimal/truncated fallback snapshots and all sample events.
4. At the web composition root, provide one process-scoped resource with a
   single stable instance ID. Pass `serviceName`, package version, validated
   runtime mode, and `surface: 'web'` explicitly.
5. At the CLI composition root, provide a separate process-scoped resource with
   `surface: 'cli'`. Preserve file-only behavior.
6. Update `WebSourceControlRuntime` Effect environment types and fixture layers
   explicitly. E2E/demo fixtures must use deterministic non-local resource data.
7. Add `trigger` to `SourceJob` and thread the correct value through cadence,
   detection, manual, and dependency admission sites. Keep the queue semantics
   identical.
8. Extend source finish and publication start decisions with the generation
   fields defined in Target Architecture section 4. Annotate events without
   changing state-transition outcomes.
9. Test sequential and concurrent workers to prove trigger/generation metadata
   is isolated and does not change job admission, ordering, queue depth,
   publication coalescing, or RTK gating.
10. Add a v1/v2 compatibility test only for repository-owned analysis helpers
    touched by this plan. Do not create a general ingestion API if none exists.

**Verify**:

```sh
bun test packages/effect-runtime/src \
  packages/report-data/src/source-control-state.test.ts \
  packages/report-data/src/source-control.test.ts \
  apps/web/src/server/source-control.server.test.ts \
  apps/cli/src/main.integration.test.ts
bun run --cwd packages/effect-runtime check
```

Expected: all tests and typechecking pass; new snapshots are schema v2; v1
fixtures remain readable where applicable; source-control behavioral assertions
are unchanged apart from added metadata.

### Step 4: Replace serialization-shaped pretty output with a terminal view

1. Add console severity, filtering, detail level, ANSI helpers, generic
   `PrettyWideEventView`, and projector option to `console-sink.ts`.
2. Keep JSON rendering byte-for-byte equivalent to canonical serialization
   except for the intentional schema v2 resource addition. JSON output never
   includes ANSI or newlines.
3. Make the injected writer receive severity so tests can assert routing.
   Default pretty writers use `console.info`, `console.warn`, or `console.error`.
4. Parse `LOG_LEVEL` defensively. Unknown values use `info`; do not throw during
   runtime construction. Keep `LOG_FORMAT=json` and TTY selection behavior.
5. Implement the generic renderer:
   - first line: timestamp, outcome symbol, projected subject, duration,
     projected summary, short event ID;
   - subsequent lines: useful hop tree and anomaly/error detail;
   - debug: complete bounded tree, remaining annotations, and resource line;
   - info: suppress a single child hop when it merely repeats almost the entire
     root operation and has no distinct annotations; otherwise show useful
     direct hops;
   - warn/error: show reason codes and failing/degraded hops even when the
     configured detail level is info.
6. Create the web projector with exhaustive handling for `source.run`,
   `publication`, and `web.sessions.read`; use the generic fallback for future
   boundaries. Do not make the projector responsible for sanitization.
7. Wire the projector into the web sink layer. Keep fixtures able to inject a
   writer/projector without touching real console output.
8. Add ANSI-stripped golden tests for:
   - source success;
   - unchanged source success;
   - degraded source with warning codes;
   - publication success/failure;
   - Session success/failure;
   - nested hops at info and debug;
   - `LOG_LEVEL` filtering;
   - severity routing;
   - JSON one-line invariants;
   - truncation and absence of sensitive values.
9. Assert representative info headers are at most 140 characters without the
   task-runner prefix. Do not assert that pretty output contains no newline.

**Verify**:

```sh
bun test packages/effect-runtime/src/node/console-sink.test.ts \
  apps/web/src/server/wide-event-presentation.server.test.ts \
  apps/web/src/server/source-control.server.test.ts
```

Expected: all golden tests pass; success/warn/error events use their matching
writer; JSON remains one physical line; representative info headers fit the
140-character test budget.

### Step 5: Make file-delivery failure observable and deadlines honest

1. Replace free-form file warning strings with a typed warning kind plus fixed,
   sanitized metadata. Add per-kind 30-second rate limiting using an injected
   clock in tests.
2. Change combined sink diagnostics so callers can distinguish logical event
   submission from file and console delivery. Do not sum two successful
   transports into “two events.”
3. In web composition, route file warnings directly to the selected console
   warning writer. Prevent recursion into the file sink.
4. On scoped web shutdown, print a single summary only when file or console
   diagnostics report dropped/failed delivery. Do not emit a second wide event
   for observability failure.
5. Keep CLI warning and summary callbacks as no-ops.
6. At append timeout, set `circuitOpen` synchronously in the timeout callback,
   rate-limit one warning, and drop queued records. Continue awaiting the active
   append privately while holding the cooperative lock.
7. Add a non-cooperative append test that proves, before releasing the append:
   - the deadline has elapsed;
   - a later submission is immediately dropped;
   - the lock is still unavailable to another writer;
   - no second append starts.
   Then release it and prove the lock becomes available and final diagnostics
   settle exactly once.
8. Preserve existing queue-full, shutdown, abort-aware append, filesystem
   failure, stale lock, and concurrent subprocess tests.

**Verify**:

```sh
bun test packages/effect-runtime/src/node/file-sink.test.ts \
  packages/effect-runtime/src/node/console-sink.test.ts \
  apps/web/src/server/source-control.server.test.ts \
  apps/cli/src/main.integration.test.ts
```

Expected: all tests pass; the non-cooperative test observes an open circuit at
the configured deadline while the interprocess lock remains held until I/O
settles; CLI stderr assertions remain unchanged.

### Step 6: Remove steady-state retention sweeps

1. Track the last target filename swept by each file-sink instance.
2. Keep target selection under the lock for every append.
3. Sweep before releasing the lock only when no target has yet been swept by
   this process or the target filename differs from the last swept target.
4. If sweep fails, report a rate-limited `sweep-failure` but do not fail an
   otherwise successful append. Do not mark a target as swept until the sweep
   completes successfully; this permits a later retry.
5. Add injected filesystem-operation counters or a narrow equivalent test seam
   proving N steady-state appends to one target perform one sweep, while day and
   size rotations each trigger another sweep.
6. Re-run the two-process writer test and retention-order tests. Do not cache
   target size or weaken file safety checks.

**Verify**:

```sh
bun test packages/effect-runtime/src/node/file-sink.test.ts
```

Expected: all tests pass; steady-state sweep count is one; each target change
adds exactly one successful sweep; rotation and 30-file retention semantics are
unchanged.

### Step 7: Record the scheduler evidence without changing scheduling

1. Add a “Scheduler signal exposed by wide events” section to
   `docs/architecture.md` summarizing how `queueDelayMs`, `trigger`,
   `sourceId`, duration, and publication generations should be queried.
2. Record the audit baseline from this plan without copying local event IDs,
   revisions, fingerprints, paths, or other high-cardinality values.
3. State that the existing evidence justifies a separate scheduler performance
   plan, but does not by itself choose between more workers, priority lanes, or
   queue partitioning.
4. Add a follow-up entry to `plans/README.md` under deferred product/technical
   directions. Do not reserve another plan number and do not modify worker
   configuration in this plan.

**Verify**:

```sh
rg -n "queueDelayMs|publicationDataGeneration|scheduler" \
  docs/architecture.md plans/README.md
```

Expected: matches document the signal and explicit deferral; no source file
changes worker count or scheduling policy.

### Step 8: Supersede the affected ADR clauses and close the plan

1. Create ADR 0008. It must explicitly supersede only these plan-036/ADR-0002
   choices:
   - one physical line for TTY pretty output;
   - absence of producer resource context;
   - silent web file-sink diagnostics;
   - generic `.message` fallback for allowlisted tagged errors.
2. Preserve these plan-036 decisions:
   - one canonical event per real boundary;
   - fresh isolated event state;
   - domain-free runtime package;
   - NDJSON one object per physical line;
   - CLI file-only output;
   - best-effort bounded delivery;
   - private permissions, cooperative locking, rotation, and retention;
   - no raw causes, payloads, prompts, or credentials;
   - no OTLP/remote exporter in this scope.
3. Update `CONTEXT.md`, `docs/architecture.md`,
   `docs/public-package-interfaces.md`, and the runtime README for schema v2,
   resource ownership, severity/detail selection, application projector,
   failure codes, and diagnostics.
4. Update the status and dependency notes in `plans/README.md` only after every
   gate passes.
5. Add an execution-log section to this plan containing exact command results,
   notable implementation decisions, and any conditional step rejected by a
   STOP condition. Do not mark DONE with a failing or skipped required gate.

**Verify**:

```sh
bun run check
bun run lint
bun run typecheck
bun run test
git diff --check
git status --short
```

Expected: every command exits 0; only in-scope files are modified; no file under
`logs/` is tracked or changed by the implementation.

## Test plan

### Runtime model and sanitization

- Schema v2 success, failure, minimal fallback, and truncation retain a bounded
  resource.
- Missing production resource layer is a type/composition failure, not a hidden
  process-global fallback.
- Explicit public messages are scrubbed and bounded.
- Generic `.message` is not persisted by default classification.
- Unknown tags, defects, causes, and hostile accessors remain safe.

### Boundary and hop behavior

- Existing nested/parallel ordering, sequential isolation, emit-once, and
  interruption tests remain green.
- Session execution and parsing are distinct hops.
- Parsing/protocol failure produces one failure event and one failure result.
- Phase timings attach to `revision.execute`, never root or a sibling event.

### Source control

- Source failure/timeout/unavailable/warning events contain only stable codes.
- `trigger` is correct for cadence, detection, manual, and dependency runs.
- Changed source generation correlates with the publication target interval.
- Multiple workers retain event/resource/correlation isolation.
- Queue admission, depth, cadence, RTK ordering, publication coalescing, timeout,
  and shutdown behavior remain unchanged.

### Console

- Golden fixtures cover real boundary shapes and anomalies.
- Outcome-to-severity mapping and `LOG_LEVEL` filtering are exact.
- Pretty may be multi-line and uses one writer call per event.
- JSON is always one line and contains no ANSI.
- Info headers meet the 140-character fixture budget.
- Debug contains full bounded detail; info avoids redundant details; anomalies
  expand reasons.
- App projector and generic fallback both work.

### File delivery

- Warning kinds are rate-limited and contain no raw error object.
- Web receives console-only warnings; CLI remains silent.
- Per-transport diagnostics do not double-count logical events.
- A non-cooperative append opens the circuit at deadline but keeps the lock
  until settlement.
- Queue, drain, rotation, retention, permissions, no-follow, stale-lock, and
  subprocess concurrency tests remain green.
- Steady-state appends sweep once per target, not once per event.

### System gates

- Package-boundary checks prove `@ai-usage/effect-runtime` imports no domain
  workspace package.
- No raw local log fixture is committed.
- CLI product stdout/stderr integration snapshots remain unchanged.
- Full repository lint, typecheck, tests, Ultracite check, and diff hygiene pass.

## Done criteria

All items must hold:

- [x] `web.sessions.read` includes execution and parsing and cannot log success
      when the returned protocol result is failure.
- [x] Successful Session events contain useful bounded result summaries and
      measured execution/parse detail.
- [x] Source, publication, Session, and CLI anomaly events expose stable bounded
      reason codes without raw causes or arbitrary messages.
- [x] Generic `.message` fallback is removed; approved public messages are
      scrubbed and bounded.
- [x] New events use schema v2 with process-scoped web/CLI resource context.
- [x] Historical v1 files are untouched; touched analysis seams accept v1/v2.
- [x] Source triggers and publication generations support many-to-one causal
      queries without changing control-plane behavior.
- [x] Pretty TTY output uses semantic projection, severity, progressive detail,
      and multi-line trees where useful.
- [x] Representative info headers are at most 140 characters in golden tests.
- [x] JSON console and NDJSON remain one JSON object per physical line.
- [x] Console filtering never filters the file sink.
- [x] Web file-sink loss is rate-limited and visible; CLI remains silent.
- [x] Diagnostics distinguish logical events from per-transport delivery.
- [x] Append timeout opens the circuit at the deadline without releasing the
      cooperative lock before I/O settlement.
- [x] Retention sweeps occur once per selected target, not once per append.
- [x] Existing private permissions, rotation, retention, shutdown, concurrent
      writer, and best-effort product-result guarantees still pass.
- [x] Scheduler queue-delay evidence is documented and worker changes are
      explicitly deferred.
- [x] ADR 0008 and architecture/interface/context docs match the implementation.
- [x] `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`, and
      `git diff --check` all exit 0.
- [x] `git status --short` lists only in-scope files introduced by this plan;
      the captured pre-existing dirty-worktree baseline remains untouched.
- [x] `plans/README.md` marks plan 037 DONE only after all preceding checks pass.

## STOP conditions

Stop and report back; do not improvise if any condition occurs:

- In-scope code no longer matches the current-state excerpts or the expected
  dirty-worktree baseline.
- The implementation would require discarding, resetting, or overwriting
  pre-existing uncommitted work.
- Making the Session boundary truthful requires changing a public protocol
  response shape or weakening result validation.
- Phase timing requires running a nested Effect runtime or refactoring the
  revision registry's ownership model. Keep one `revision.execute` hop and
  report the unavailable inner phase instead.
- Resource context requires `@ai-usage/effect-runtime` to import another
  workspace package or read application environment/config directly.
- Correlation requires changing queue admission, worker count, scheduling,
  cadence, publication ordering, or RTK dependency semantics.
- A proposed reason code can only be obtained by logging a raw cause, message,
  payload, path, request, cursor, prompt, transcript, or credential.
- Pretty rendering requires domain imports inside the runtime package.
- A file warning routes back through the failing file sink or can recursively
  emit itself.
- Opening the append circuit at deadline would release the cooperative lock
  while the original append may still write.
- Retention optimization requires caching a cross-process file size or weakening
  no-follow, single-link, mode, or lock validation.
- CLI wide events or sink diagnostics reach stdout/stderr.
- Any formatter changes a file outside Scope.
- A verification command fails twice after one reasonable focused correction.

## Maintenance notes

- Treat the canonical event and its terminal projection as separate products.
  Schema changes require a schema decision; presentation changes require golden
  tests but must not force a schema bump.
- Application projectors must be total. Unknown boundaries use the generic
  fallback so adding instrumentation cannot crash the sink.
- Stable error/warning codes are query dimensions. Review additions for bounded
  cardinality and document their vocabulary; do not use dynamic messages as
  codes.
- `resource.instanceId` identifies one process lifetime, not a machine or user.
  Do not derive it from paths, hostnames, account IDs, or harness credentials.
- Trace IDs remain execution-local. Control-plane generations carry causal
  relations across coalesced asynchronous jobs.
- Reviewers should scrutinize Session result parity, stdout/stderr changes,
  resource layer completeness, circuit/lock concurrency, and any accidental raw
  values in fixtures or snapshots.
- If event volume later justifies scheduler changes, start a separate measured
  plan using `queueDelayMs` grouped by `sourceId` and `trigger`. Do not infer a
  scheduler design from one development startup burst.
- If a real OTLP exporter is later added, map schema v2 resource fields and
  outcome/error codes to current OpenTelemetry semantic conventions rather than
  introducing a second vocabulary.

## References

- `plans/036-wide-event-logging.md` — original implemented architecture and
  privacy/lifecycle constraints.
- `docs/adr/0001-boundary-scoped-observability-on-bounded-workers.md` — worker
  and event-scope decision that remains in force.
- `docs/adr/0002-effect-runtime-package-for-wide-events.md` — package and sink
  ownership decision partially superseded by ADR 0008.
- `../exalibur-svelte/packages/effect-runtime/src/runtime-logger.ts` — reference
  for ANSI outcome symbols, tree projection, and info/debug detail; do not copy
  its HTTP/cache domain model.
- Honeycomb, “Logging Best Practices: An Engineer's Checklist”:
  <https://www.honeycomb.io/blog/engineers-checklist-logging-best-practices>
- Brandur Leach, “Using Canonical Log Lines for Online Visibility”:
  <https://brandur.org/canonical-log-lines>
- OpenTelemetry Logs Data Model:
  <https://opentelemetry.io/docs/specs/otel/logs/data-model/>
- OpenTelemetry error recording guidance:
  <https://opentelemetry.io/docs/specs/semconv/general/recording-errors/>

## Execution log

### 2026-07-22

- Drift check confirmed commit `a186682` plus the documented dirty-worktree
  baseline. Existing changes outside this plan's scope were preserved.
- Step 0 characterization command passed: 26 tests across the console sink,
  file sink, and revision-query runner. It froze the Session mismatch before
  Step 1 moved parsing and final protocol mapping inside the boundary.
- Session verification passed with 8 tests covering success, expiry, malformed
  JSON, fingerprint/revision mismatch, dependency rejection, phase annotations,
  and protocol/event outcome parity.
- Runtime/source/web/CLI focused verification passed with 97 tests across nine
  files; the delivery-focused command passed 43 tests across four files.
- `bun run --cwd packages/effect-runtime check`: passed with no diagnostics.
- `bun run check`: passed; Ultracite checked 512 files with no fixes required.
- `bun run lint`: passed; restricted imports and all workspace/package boundary
  checks passed.
- `bun run typecheck`: passed, 18 of 18 Turbo tasks successful.
- `bun run test`: passed, 18 of 18 package tasks successful, including 458 web
  tests, followed by 9 passing tool tests.
- The CLI-owned wide-event analysis helper now has an explicit compatibility
  test for historical schema v1 records without `resource` and current schema
  v2 records with required resource context.
- `git diff --check`: passed. Final status hygiene matched the captured baseline:
  this plan introduced no unexpected out-of-scope changes, and pre-existing
  out-of-scope modifications remain preserved.
- `git diff --check`: passed with no output.
- Scheduler evidence query matched `queueDelayMs`, `trigger`,
  `publicationDataGeneration`, and the explicit scheduler-policy deferral in
  `docs/architecture.md` and `plans/README.md`.

Material decisions:

- Schema v2 uses one explicitly layered process resource. Historical schema-v1
  files remain untouched.
- Session execution diagnostics annotate the current `revision.execute` hop;
  parsing owns a separate `revision.parse` hop and returns the final existing
  protocol shape from inside `web.sessions.read`.
- Trace ids remain boundary-local. Source triggers and monotonic publication
  generation intervals provide many-to-one causal correlation.
- Pretty terminal output is an application-projected view; canonical JSON and
  NDJSON remain single-line records. Console filtering never filters the file
  transport.
- A timed-out non-cooperative append opens the circuit at the deadline but
  retains the cooperative lock until the private append settles. Retention
  sweeps run once per successfully selected target.

The first repository typecheck exposed a generic inference error in the Session
failure helper. A focused correction still left the same command failing, so
the executor stopped under the plan's STOP condition. The operator explicitly
instructed the executor to resume and fix the errors. The final fix modeled the
helper as the exact protocol failure variant rather than an uninferable generic;
the web check, regression tests, and all repository gates then passed.

### Post-review remediation

- Removed the implicit test resource from generic sink layers. Production web
  composition now requires an explicit resource layer, while tests use the
  explicitly named deterministic test helper and E2E supplies fixed fixture
  identity.
- Shutdown diagnostics now count an unsettled active append as lost before the
  bounded shutdown returns. A throwing console diagnostic writer is contained
  and cannot fail runtime disposal.
- Pretty rendering now reports hop omission only after the budget is actually
  exceeded and retains the path to nested anomalous hops at info detail.
- Session requests are parsed once before entering their truthful boundary.
- Added focused regression coverage for each review finding. The complete
  sequential gate (`check`, `lint`, `typecheck`, `test`, `build`, and
  `git diff --check`) passed; the full web suite contains 460 passing tests and
  the runtime package contains 59 passing tests.
