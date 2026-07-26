# Plan 043: Deepen the web process runtime seam

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 96b3dff..HEAD -- apps/web/src/server/source-control.server.ts apps/web/src/server/source-control.server.test.ts apps/web/src/server/source-control-api.server.ts apps/web/src/server/source-control-api.server.test.ts apps/web/src/server/revision-query-runner.server.ts apps/web/src/server/revision-query-runner.server.test.ts apps/web/server/plugins/source-control.ts docs/architecture.md`
> If an in-scope file changed, compare the current-state excerpts below with the
> live code. Any semantic mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 038
- **Category**: architecture
- **Planned at**: commit `96b3dff`, 2026-07-26

## Why this matters

`WebSourceControlRuntime` is the process composition root for both source
control and wide-event execution, but its public shape flattens those unrelated
capabilities into one source-control-named interface. Session query code reaches
through that interface only to run a wide-event Effect, and its tests construct
a fake source scheduler to obtain that executor. Give the process lifetime one
honest owner and expose two narrow ports backed by the same `ManagedRuntime`.

## Current state

- `apps/web/src/server/source-control.server.ts:24-37` declares
  `WebSourceControlRuntime`; source-control commands and a generic `runEffect`
  method are peers on the same interface.
- `apps/web/src/server/source-control.server.ts:89-134` creates one
  `ManagedRuntime` containing `SourceControl`, `WideEventResourceService`, and
  `WideEventSink`. Keeping this single scoped owner is correct.
- `apps/web/src/server/source-control.server.ts:136-198` stores, replaces, and
  disposes that process runtime in globals named only for source control.
- `apps/web/src/server/source-control-api.server.ts:11,105-132` accepts the
  complete runtime even though it needs only source-control commands and
  snapshots.
- `apps/web/src/server/revision-query-runner.server.ts:55,200-254` imports the
  source-control runtime solely to execute a Session wide-event Effect.
- `apps/web/src/server/revision-query-runner.server.test.ts:134-267` repeats
  full `createWebSourceControlRuntime` setup with an empty source map, policy
  store, and publication port only to test query events.
- `apps/web/server/plugins/source-control.ts:64-123` correctly creates one
  process-scoped wide-event resource, serializes hot replacement, drains the
  previous runtime, and starts source control after the initial-response gate.

## Target interface

Add `apps/web/src/server/web-process-runtime.server.ts` as the process-lifetime
seam. Define these exact responsibilities:

```ts
export interface WebEffectExecutor {
  readonly runEffect: <A, E>(
    effect: Effect.Effect<A, E, WideEventResourceService | WideEventSink>,
  ) => Promise<A>;
}

export interface WebSourceControlPort {
  readonly detectAll: () => Promise<void>;
  readonly getSnapshot: () => Promise<SourceControlView>;
  readonly requestPublication: () => Promise<boolean>;
  readonly runAllEnabled: () => Promise<number>;
  readonly runNow: (sourceId: CollectionSourceId) => Promise<boolean>;
  readonly setEnabled: (
    sourceId: CollectionSourceId,
    enabled: boolean,
  ) => Promise<void>;
  readonly start: () => Promise<SourceControlView>;
  readonly subscribe: (
    listener: (snapshot: SourceControlView) => void,
  ) => () => void;
}

export interface WebProcessRuntime {
  readonly dispose: () => Promise<void>;
  readonly effects: WebEffectExecutor;
  readonly sourceControl: WebSourceControlPort;
}
```

The module also owns `installWebProcessRuntime`, `replaceWebProcessRuntime`,
`getWebProcessRuntime`, and a non-throwing `tryGetWebProcessRuntime` for the
optional publication-request path. There must be one registry and one
serialized replacement chain.

`createWebProcessRuntime(options)` remains in
`source-control.server.ts`, because that module owns construction of the
source-control layer. It returns the nested interface above, with both ports
delegating to the same `ManagedRuntime`; it must not create a second production
runtime.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Runtime tests | `bun test apps/web/src/server/web-process-runtime.server.test.ts apps/web/src/server/source-control.server.test.ts` | exit 0 |
| Adapter tests | `bun test apps/web/src/server/source-control-api.server.test.ts apps/web/src/server/revision-query-runner.server.test.ts` | exit 0 |
| Production lifecycle | `bun run test:web-production` | exit 0 |
| Format check | `bun run check` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Full tests | `bun run test` | exit 0 |
| Diff safety | `git diff --check` | exit 0, no output |

## Scope

**In scope**:

- new `apps/web/src/server/web-process-runtime.server.ts`
- new `apps/web/src/server/web-process-runtime.server.test.ts`
- `apps/web/src/server/source-control.server.ts`
- `apps/web/src/server/source-control.server.test.ts`
- `apps/web/src/server/source-control-api.server.ts`
- `apps/web/src/server/source-control-api.server.test.ts`
- `apps/web/src/server/revision-query-runner.server.ts`
- `apps/web/src/server/revision-query-runner.server.test.ts`
- `apps/web/server/plugins/source-control.ts`
- `docs/architecture.md` — only the web process-runtime ownership paragraph

**Out of scope**:

- source scheduling, worker-count, timeout, detection, or policy semantics;
- initial publication/collection ordering or the first-response gate;
- changing Session query results or wide-event classification;
- adding a second wide-event sink, resource, registry, or production
  `ManagedRuntime`;
- restructuring `@ai-usage/report-data` source control;
- unifying the revision-query pipeline; plan 044 owns that follow-up.

## Git workflow

- Branch: `refactor/043-deepen-web-process-runtime`
- Prefer one interface/lifecycle commit and one consumer migration commit.
  Example messages: `Extract the web process runtime seam` and
  `Depend on narrow web runtime ports`.
- Do not push or open a pull request unless explicitly requested.

## Steps

### Step 1: Freeze process-lifecycle behavior

Move the install, optional lookup, strict lookup, serialized replacement, and
uninstall behavior into focused tests for the new process runtime module.
Preserve:

- a second direct install fails;
- replacement waits for the complete registered teardown before installing the
  successor;
- stale uninstall callbacks cannot remove a newer runtime;
- `dispose` remains idempotent at the concrete runtime boundary;
- an optional lookup returns `undefined`, while strict lookup throws the current
  not-started error.

Use small object fixtures implementing the nested ports. Do not construct source
adapters in registry tests.

**Verify**:

```sh
bun test apps/web/src/server/web-process-runtime.server.test.ts
```

The new tests pass before migrating consumers.

### Step 2: Return two ports from one managed runtime

In `source-control.server.ts`, rename `WebSourceControlRuntimeOptions` to
`WebProcessRuntimeOptions` and `createWebSourceControlRuntime` to
`createWebProcessRuntime`. Keep layer construction and `withSourceControl`
private to this module.

Return:

- `effects.runEffect`, delegating directly to the existing managed runtime;
- `sourceControl`, containing only the existing source-control operations;
- top-level idempotent `dispose`.

Move registry code out of this module. Rewrite
`requestSourceControlPublicationForServer` to use
`tryGetWebProcessRuntime()?.sourceControl`; preserve `false` when no runtime is
installed and `true` when the request is accepted for handling even if its
inner result is deduplicated.

Remove the old flat interface and old install/get/replace export names after all
in-repository callers migrate; do not leave compatibility aliases that preserve
the misleading seam.

**Verify**:

```sh
bun test apps/web/src/server/web-process-runtime.server.test.ts apps/web/src/server/source-control.server.test.ts
```

Lifecycle, scheduling, subscription, publication, event sink, and disposal
tests all pass.

### Step 3: Migrate production consumers to narrow capabilities

Update:

- `source-control-api.server.ts` to accept `WebSourceControlPort` in its
  injectable functions and default to
  `getWebProcessRuntime().sourceControl`;
- `revision-query-runner.server.ts` to execute its boundary through
  `getWebProcessRuntime().effects.runEffect`;
- the Nitro plugin to create a process runtime, register it with
  `replaceWebProcessRuntime`, call `runtime.sourceControl.start()`, and dispose
  the top-level runtime.

Keep the plugin's existing initial-response release, signal handlers,
hot-reload teardown registration, production-smoke messages, resource instance
ID, and sink selection byte-for-byte unless a type-only adaptation requires a
local change.

**Verify**:

```sh
bun test apps/web/src/server/source-control-api.server.test.ts apps/web/src/server/revision-query-runner.server.test.ts
bun run test:web-production
```

All commands exit 0 and the production process reports one source-control
startup and one shutdown.

### Step 4: Remove source-scheduler setup from query tests

In `revision-query-runner.server.test.ts`, add one focused test fixture that:

1. creates a test-only `ManagedRuntime` from
   `makeTestWideEventSinkLayer(sink)`;
2. exposes it through `WebProcessRuntime.effects`;
3. supplies a source-control port whose methods fail if unexpectedly called;
4. installs/uninstalls the process runtime and disposes the test managed runtime.

Use the fixture for Session wide-event cases. Delete repeated policy store,
publication, empty source-map, and `createWebProcessRuntime` setup from this
test file. A test-only event runtime is allowed; no second runtime may exist in
the production plugin.

**Verify**:

```sh
bun test apps/web/src/server/revision-query-runner.server.test.ts
```

Session event assertions pass without constructing source control.

### Step 5: Document and run repository gates

Update the web runtime paragraph in `docs/architecture.md`: one process-scoped
managed runtime owns the source-control service and wide-event resources, while
finite adapters consume either the source-control port or the effect executor.
Do not claim two lifecycles or two sinks.

**Verify**:

```sh
! grep -RInE "WebSourceControlRuntime|getWebSourceControlRuntime|installWebSourceControlRuntime|replaceWebSourceControlRuntime" apps/web
! grep -RInE "getWebProcessRuntime\\(\\)\\.runEffect" apps/web
bun run check
bun run typecheck
bun run test
bun run test:web-production
git diff --check
```

All commands exit 0.

## Test plan

- Registry tests cover direct install, serialized replacement, custom teardown,
  stale uninstall, absent lookup, and strict lookup.
- Concrete runtime tests prove both nested ports share one lifecycle and that
  top-level disposal remains idempotent.
- Existing source-control API, SSE, scheduler, publication, wide-event, and
  production-smoke tests remain green.
- Session query event tests use only the effect-executor capability and fail if
  source control is touched.

## Done criteria

- [ ] `WebProcessRuntime` names the real process-owned lifetime.
- [ ] Source-control and effect execution are separate narrow ports.
- [ ] One production `ManagedRuntime` and one registry own both ports.
- [ ] Source-control API code cannot call the generic effect executor.
- [ ] Revision-query code does not depend on the source scheduler.
- [ ] Hot replacement drains the complete previous lifecycle before install.
- [ ] Initial publication/collection order and bounded workers are unchanged.
- [ ] Targeted/full tests, production smoke, formatting, and typechecking pass.
- [ ] This plan's row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- the design needs a second production `ManagedRuntime`, wide-event resource,
  sink, or global registry;
- replacement can expose the new runtime before the previous teardown finishes;
- the migration changes source scheduling, worker bounds, publication ordering,
  the initial-response gate, or Session result semantics;
- a finite adapter still needs the complete process runtime after the two ports
  exist;
- production startup or shutdown occurs more than once;
- a verification command fails twice after one reasonable correction.

## Maintenance notes

Name lifetime owners after the lifetime they own, then expose capability ports
that are smaller than the owner. Add a third nested capability only when a real
consumer cannot fit either existing port; do not flatten unrelated methods back
onto `WebProcessRuntime`.
