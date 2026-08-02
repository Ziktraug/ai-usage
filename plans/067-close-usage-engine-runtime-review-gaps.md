# Plan 067: Close the post-cutover usage-engine runtime review gaps

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If a STOP condition occurs, stop and report rather than weakening
> the sole-writer, loopback, bounded-error, or shutdown guarantees. When done,
> update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat d9cc99c..HEAD -- apps/usage-engine/src/control-server.ts apps/usage-engine/src/control-server.test.ts apps/usage-engine/src/main.ts apps/usage-engine/src/process.ts apps/usage-engine/src/process.test.ts packages/usage-engine-control/src/contracts.ts packages/usage-engine-control/src/errors.ts packages/usage-engine-runtime/package.json packages/usage-engine-runtime/src/live.ts packages/usage-engine-runtime/src/live.test.ts packages/usage-engine-runtime/src/merge.ts packages/usage-engine-runtime/src/source-adapters.ts packages/usage-engine-runtime/src/source-adapters.test.ts packages/usage-merge/package.json packages/usage-merge/src/index.ts packages/usage-merge/src/index.test.ts tools/check-package-boundaries.ts tools/check-package-boundaries.test.ts docs/public-package-interfaces.md`
> This plan was written while a separate runtime-path consolidation was
> uncommitted in the implementation worktree. Let that work settle first. If it
> changes one of the paths above, re-read the current-state excerpts and update
> this plan before implementation. Do not mix runtime-path ownership changes
> into this correction.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plan 066
- **Category**: bug, tech-debt, performance
- **Planned at**: commit `d9cc99c`, 2026-08-01

## Why this matters

Plan 066 completed the structural cutover: the Bun usage engine is the sole
writer and poller, while web and CLI read SQLite. A post-cutover review found
that several failure paths are still less trustworthy than the architecture
they protect. The control server can report internal failures as invalid client
input, a dead runtime event stream can look healthy forever, forced cleanup
failures disappear, and source snapshot synchronization still spins with
`scheduler.yield()`.

The review also found a second implementation of the manual merge workflow in
the engine runtime even though `@ai-usage/usage-merge` is the documented owner.
These gaps do not justify reopening the data-plane design. Fix them while
preserving the completed sole-writer cutover and the engine-owned polling model.

## Decisions locked

| Concern | Decision |
| --- | --- |
| Provider usage polling | `codex.usage-limits` remains an engine-owned scheduled source at the existing five-minute cadence. Web and CLI never poll providers; they read stored observations and use `collect-fresh-quota` for an explicit refresh. |
| Timer ownership | Source control owns the only quota cadence. The adapter continues to pass `liveCadenceMs: 0`, so provider orchestration cannot create a second timer. |
| Control failures | Invalid JSON/contracts remain bounded 4xx responses. Unexpected runtime failures become a generic bounded 5xx/503 response and a sanitized internal diagnostic; raw causes, paths, tokens, and payloads never cross the HTTP response. |
| Event stream failure | Unexpected termination of `runtime.changes()` fails closed: connected SSE clients close, new operational requests report engine unavailable, and one bounded diagnostic is emitted. Normal handler disposal is not an error. |
| Forced shutdown | A second signal may still stop waiting. Any cleanup deliberately continued in the background must report a bounded failure instead of swallowing it; it must not delay process termination indefinitely. |
| Merge ownership | `@ai-usage/usage-merge` owns parsing, digest, preview, confirmation, warnings, and store-error mapping. Engine-runtime adapts that service to commands and inbox/operator-file handling; it does not fork the workflow. |
| Snapshot synchronization | Direct snapshots can advance the local monotonic view immediately. Waiting for a later generation uses an abortable notification/stream failure signal and a finite startup deadline, never a yield-and-reread spin loop. |
| Data plane | No report/quota/session data endpoint is added. Store schema, revision model, and read-only web/CLI access remain unchanged. |

## Current state

- `apps/usage-engine/src/control-server.ts:493-527` parses a command and awaits
  `runtime.executeCommand` inside one `try/catch`. After handling timeout/abort,
  every other exception becomes `command-rejected` with HTTP 400. A runtime
  defect is therefore indistinguishable from malformed client input.

- `apps/usage-engine/src/control-server.ts:273-281` ends the runtime event pump
  with `.catch(() => undefined)`. It neither closes subscribers nor marks the
  handler unavailable. Heartbeats can keep a dead control stream apparently
  alive.

- `apps/usage-engine/src/process.ts:130-135` detaches late cleanup and discards
  its rejection. `disposeRuntimeForProcess` repeats that pattern at `:204-206`
  after forced termination. Retaining or releasing the writer lock may be the
  right safety choice, but operators receive no bounded signal when cleanup
  fails.

- `packages/usage-engine-runtime/src/live.ts:214-249` uses repeated
  `hostScheduler.yield()` calls while waiting for publication acknowledgement or
  for the subscription to catch a directly read generation. There is no finite
  startup deadline or explicit subscription-failure exit for these loops.

- `packages/usage-engine-runtime/src/merge.ts:101-171` duplicates the digest,
  bundle parser, preview, confirmation, warning projection, and error mapping
  already present in `packages/usage-merge/src/index.ts:117-258`.
  `docs/public-package-interfaces.md:133-145` says engine-runtime should depend
  on usage-merge because usage-merge retains this workflow ownership, but the
  engine-runtime manifest does not declare that dependency.

- The desired polling design is already present:
  `packages/report-core/src/source-control.ts:64-71` defines
  `codex.usage-limits` at five minutes;
  `packages/usage-engine-runtime/src/source-adapters.ts:395-440` registers the
  source and forces `liveCadenceMs: 0`; root `dev` starts engine and web, and the
  old Nitro source-control plugin is gone. This plan protects that behavior; it
  does not redesign its cadence.

Use these repository conventions:

- Runtime input is parsed at boundaries and returned through stable, bounded
  error codes; see the separate body-size and request-deadline handling in
  `control-server.ts:493-512`.
- Process resources are acquired and released in explicit reverse order; see
  the tracked server/rendezvous cleanup in `process.ts`.
- Effect workflows expose one deep owner and adapters map errors at the edge;
  `createUsageFileMergeService` in `packages/usage-merge/src/index.ts` is the
  owner to reuse.
- Tests use injected clocks, ports, iterators, signals, and temporary homes.
  Never use the maintainer's real config, store, histories, logs, or rendezvous.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Control tests | `bun test apps/usage-engine/src/control-server.test.ts packages/usage-engine-control` | all pass |
| Process tests | `bun test apps/usage-engine/src/process.test.ts apps/usage-engine/src/process-child.test.ts` | all pass |
| Runtime tests | `bun test packages/usage-engine-runtime` | all pass |
| Merge tests | `bun test packages/usage-merge packages/usage-engine-runtime/src/live.test.ts` | all pass |
| Boundary tests | `bun test tools/check-package-boundaries.test.ts tools/usage-engine-public-exports.test.ts` | all pass |
| Engine integration | `bun test apps/usage-engine` | all pass |
| Check | `bun run check` | Ultracite exits 0 |
| Boundaries | `bun run lint` | exit 0 |
| Types | `bun run typecheck` | all tasks pass |
| Full tests | `bun run test` | all pass |
| Build | `bun run build` | exit 0 |
| Production lifecycle | `bun run test:web-production` | engine and web descendants stop cleanly |
| Diff hygiene | `git diff --check` | no output, exit 0 |

## Scope

**In scope**:

- Correct classification and sanitized reporting of control-server failures.
- Fail-closed SSE behavior when the runtime event iterator ends unexpectedly.
- Observable bounded reporting for forced/deferred cleanup failures.
- Abortable, finite, non-spinning source snapshot/startup synchronization.
- Reuse of `@ai-usage/usage-merge` by engine-runtime and deletion of the
  duplicated engine merge workflow.
- Regression coverage proving that quota polling remains exclusively
  engine-owned with one five-minute scheduler cadence and no provider timer.
- Package-boundary/public-interface documentation needed for those ownership
  rules.

**Out of scope**:

- Store schema, served revisions, SQLite query plans, report calculations, or
  retention policy.
- Changing the five-minute quota cadence, adaptive polling, retry backoff, or
  adding another provider. Those require separate measured product decisions.
- Reintroducing web/CLI polling, writer access, a quota data API, a second
  engine timer, or the retired Nitro scheduler.
- Runtime path, lock-file location, rendezvous path, or no-follow file-helper
  consolidation currently being developed outside this plan.
- UI presentation, CLI output formats, source policy semantics, worker count,
  or collection cadence for non-quota sources.

## Git workflow

- Start only after the current runtime-path WIP has landed and the worktree is
  clean. Use a dedicated branch/worktree based on the then-current usage-engine
  branch.
- Prefer four reviewable commits:
  `Make usage engine control failures truthful`,
  `Report deferred engine cleanup failures`,
  `Reuse the usage merge workflow`, and
  `Make engine snapshot waits finite`.
- Run the focused verification for a commit before starting the next one.
- Do not push, update a PR, or merge unless the operator explicitly asks.

## Steps

### Step 1: Separate invalid commands from internal control failures

1. In `control-server.ts`, parse JSON and
   `parseUsageEngineCommandRequest` in a contract-only `try/catch`. Return the
   existing bounded 400 response only from that block.
2. Await `runtime.executeCommand` and parse its result in a second block. Keep
   `RequestBoundaryError` mapping for abort/timeout. On any other failure, call
   an injected internal-failure reporter with a closed boundary identifier (for
   example `command-execution`) and return a generic
   `engine-unavailable` 503 response. Do not return or log `String(error)`.
3. Thread the reporter through `startUsageEngineControlServer`. Production must
   emit one bounded operational diagnostic without raw cause/path/token data;
   tests inject a recorder.
4. Add tests where malformed JSON and an invalid contract produce 400 without
   invoking runtime, while synchronous rejection, asynchronous rejection, and
   invalid runtime result produce 503 and exactly one sanitized diagnostic.

**Verify**:
`bun test apps/usage-engine/src/control-server.test.ts` -> all command boundary
cases pass.

### Step 2: Fail closed when the runtime event source dies

1. Track event-pump state explicitly: `running`, `failed`, or `disposed`.
   Completion/error before handler disposal is a failure; iterator completion
   caused by `dispose()` is normal.
2. On unexpected completion/failure, report exactly one sanitized
   `event-stream` internal failure, close every subscriber, clear bounded replay
   state if needed to prevent stale replay, and reject new status/command/event
   requests with `engine-unavailable` 503.
3. Make disposal idempotent whether the iterator is pending, completed, failed,
   or throws from `return()`. Preserve the original authoritative failure while
   surfacing a cleanup failure through the reporter.
4. Add tests for iterator rejection, unexpected `done`, failure with active
   subscribers, disposal after failure, and normal disposal. Prove no heartbeat
   continues after failure and no raw thrown message reaches HTTP/SSE.

**Verify**:
`bun test apps/usage-engine/src/control-server.test.ts` -> all event failure and
existing replay/backpressure cases pass.

### Step 3: Make deferred cleanup failure observable without hanging shutdown

1. Add a narrow `reportCleanupFailure(resource)` dependency to
   `UsageEngineProcessDependencies`; its resource value is a closed union such
   as `control-server | rendezvous | runtime`. Never pass the raw cause to a
   client or serialize it into output.
2. Replace `.catch(() => undefined)` in `scheduleLateCleanup` and forced runtime
   disposal with a handler that invokes the reporter once. Keep the detached
   behavior only where the second signal explicitly ended the waiting budget.
3. Production writes/emits a bounded generic diagnostic. Foreground JSON stdout
   remains parseable and unchanged; diagnostics use the engine log/stderr path.
4. Extend process tests for late acquisition followed by cleanup rejection,
   forced runtime cleanup rejection, reporter failure, and successful cleanup.
   A reporter failure must not create an unhandled rejection or keep the process
   alive.

**Verify**:
`bun test apps/usage-engine/src/process.test.ts apps/usage-engine/src/process-child.test.ts`
-> all cleanup and signal cases pass with no unhandled rejection.

### Step 4: Restore one owner for the manual merge workflow

1. Add `@ai-usage/usage-merge` to engine-runtime dependencies. Instantiate
   `createUsageFileMergeService` in `live.ts` with the engine-owned database,
   machine, and injected clock.
2. Keep inbox/operator-file reading and cleanup in engine-runtime. Pass the
   resulting `{ bytes, text }` to usage-merge preview/confirm and adapt its
   already-bounded results to engine command output.
3. Map `UsageMergeError.reason` at the runtime command boundary without
   duplicating bundle parsing, digest calculation, warning projection, or store
   error mapping. Preserve `preview-stale` as a stable non-retryable completion.
4. Delete `packages/usage-engine-runtime/src/merge.ts` and move any unique tests
   to `packages/usage-merge/src/index.test.ts` or the live command integration
   test. Update package-boundary tests and public-interface docs to match the
   actual dependency.

**Verify**:
`bun test packages/usage-merge packages/usage-engine-runtime/src/live.test.ts tools/check-package-boundaries.test.ts`
-> preview/confirm/stale/self-merge/inbox-cleanup cases pass and repository search
finds no second digest/preview implementation in engine-runtime.

### Step 5: Replace snapshot spin loops with abortable notifications

1. Give the source-control subscription task an explicit settlement signal.
   Any unexpected stream failure/completion rejects pending generation waits;
   normal disposal aborts them with the existing abort classification.
2. When `getSnapshot` returns a newer generation, feed it through the same
   monotonic `publishSnapshot` function immediately. Do not wait for the stream
   to repeat a generation already read directly.
3. Replace initial-publication `yield()` polling with the generation notification
   path plus a finite injected startup deadline. Preserve the existing failure
   when publication reports `lastOutcome: failed`.
4. Ensure every pending wait removes its abort/deadline listener and subscriber
   on success, failure, timeout, and disposal. Do not introduce `setInterval`, a
   busy loop, or an unbounded promise.
5. Add tests for direct snapshot ahead of stream, stream failure, stream normal
   completion before disposal, initial publication timeout, abort, disposal,
   monotonic duplicate suppression, and successful coalesced publication.

**Verify**:
`bun test packages/usage-engine-runtime/src/live.test.ts` -> all synchronization
and existing source/publication tests pass; `grep -n "hostScheduler.yield"
packages/usage-engine-runtime/src/live.ts` returns no matches.

### Step 6: Lock in sole ownership of provider usage polling

1. Keep `codex.usage-limits` at exactly 300,000 ms and keep
   `liveCadenceMs: 0` in the adapter. Do not add a quota-specific interval.
2. Extend source-adapter/runtime tests to prove one scheduled run is admitted
   per source-control cadence, a manual `collect-fresh-quota` joins/resets the
   same source lifecycle, and stopping autonomous collection prevents later
   polls.
3. Extend boundary/static tests so production web and CLI cannot import provider
   refresh/polling modules, source adapters, or writer exports. They may import
   the read model and control client only.
4. Document in `docs/public-package-interfaces.md` that provider usage polling
   is an engine source, while web/CLI display stored freshness and explicit
   refresh uses the control command.

**Verify**:
`bun test packages/usage-engine-runtime/src/source-adapters.test.ts packages/usage-engine-runtime/src/source-control.test.ts tools/check-package-boundaries.test.ts`
-> cadence, manual refresh, shutdown, and dependency rules pass.

### Step 7: Run the complete post-cutover gate

1. Run every command under **Commands you will need** from an isolated temporary
   home where a runtime is involved.
2. Search production code for `.catch(() => undefined)` in engine lifecycle and
   control paths, `hostScheduler.yield` in `live.ts`, the deleted engine merge
   service, web/CLI provider polling imports, and any new report-data route in
   control server. Only deliberate test fixtures/documentation may match.
3. Inspect the complete diff for raw errors, paths, tokens, payloads, or private
   data in diagnostics. Run `git diff --check`.
4. Update this plan and its index row to `DONE` only after all checks pass.

**Verify**: full check/lint/typecheck/test/build/production lifecycle commands
exit 0 and the forbidden-pattern searches have no production matches.

## Test plan

- **Control classification**: invalid client input versus internal runtime
  failure, bounded 4xx/5xx responses, timeout/abort, diagnostic sanitization.
- **SSE lifecycle**: rejection, premature completion, active subscriber closure,
  heartbeat cleanup, disposal races, replay/backpressure preservation.
- **Process cleanup**: successful, failed, delayed, and forced cleanup; no
  unhandled rejection; structured foreground stdout unchanged.
- **Merge**: preview, confirmation, stale digest/token, self-merge, invalid
  bundle, warning bounds, inbox cleanup, and publication after commit through
  one usage-merge owner.
- **Snapshot synchronization**: direct-read/stream races, duplicate generations,
  failure, timeout, abort, disposal, and publication success.
- **Polling ownership**: five-minute cadence, no nested provider timer, manual
  refresh joins the source, shutdown stops cadence, web/CLI remain read-only.

## Done criteria

- [ ] Invalid command contracts return bounded 4xx responses; unexpected runtime
      failures return generic 503 and emit one sanitized diagnostic.
- [ ] Unexpected runtime event-stream completion closes SSE clients and makes
      the control handler unavailable instead of continuing heartbeats.
- [ ] No engine lifecycle/control cleanup rejection is silently discarded.
- [ ] `@ai-usage/usage-merge` is the only manual merge workflow owner and
      engine-runtime contains no duplicate digest/preview/confirm implementation.
- [ ] `live.ts` contains no yield-based snapshot synchronization or unbounded
      startup wait.
- [ ] `codex.usage-limits` remains exclusively engine-owned at five minutes,
      with no nested polling timer and no web/CLI polling import.
- [ ] Control still exposes no report, session, focused, quota-history, or file
      data endpoint.
- [ ] Check, lint, typecheck, focused/full tests, build, production lifecycle,
      and diff hygiene all pass.
- [ ] No runtime-path/lock-location work or unrelated product behavior is mixed
      into this diff.
- [ ] `plans/README.md` is updated to `DONE` only after every criterion passes.

## STOP conditions

Stop and report instead of improvising if:

- the separate runtime-path consolidation is still modifying an in-scope file;
- distinguishing invalid input from runtime failure would expose raw causes or
  require a new public error payload;
- an event-stream failure cannot close subscribers without weakening existing
  replay/backpressure bounds;
- forced shutdown can only report cleanup failure by waiting indefinitely;
- usage-merge cannot serve engine preview/confirmation without gaining app,
  control-transport, inbox, or scheduler knowledge;
- snapshot synchronization requires polling, an unbounded timer, or accepting a
  non-monotonic generation;
- quota polling exists outside engine source control, or removing it would
  change the stored provider observation contract;
- any step requires changing store schema, report results, quota cadence, CLI
  output, or UI behavior.

## Maintenance notes

Provider usage polling is ordinary engine source work, not a web refresh concern.
Future provider integrations should register another bounded source or extend
the provider-neutral adapter; they must not add timers in web, CLI, or provider
orchestration underneath source control.

The control plane deliberately exposes operational state rather than internal
causes. Diagnostics should remain useful through stable boundary/resource codes
and wide-event correlation, never by returning exception messages.

If shutdown semantics evolve, preserve the distinction between stopping the
process promptly after a second signal and pretending detached cleanup
succeeded. Prompt exit and truthful diagnostics are both requirements.
