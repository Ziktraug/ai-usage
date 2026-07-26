# Plan 044: Unify the exact-revision query lifecycle

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 96b3dff..HEAD -- apps/web/src/server/revision-query-runner.server.ts apps/web/src/server/revision-query-runner.server.test.ts apps/web/src/server/web-process-runtime.server.ts apps/web/src/server/web-process-runtime.server.test.ts`
> Plan 043 intentionally changes all four files. Confirm plan 043 is `DONE`,
> then compare the current behavior with the invariants below. Any unrelated
> semantic mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 043
- **Category**: architecture
- **Planned at**: commit `96b3dff`, 2026-07-26

## Why this matters

All seven query kinds use the same immutable revision lease and bounded artifact
process, but `sessions` has a separate execute/expired/parse/result pipeline so
it can emit a wide event. The two branches already differ in measurement and
error placement. One lifecycle should own execution and validation; Session
observability should decorate that lifecycle instead of reimplementing it.

## Current state

- `apps/web/src/server/revision-query-runner.server.ts:119-163` defines one
  injectable bounded execution dependency used by every query kind.
- `apps/web/src/server/revision-query-runner.server.ts:170-198` defines shared
  `QueryFailed` and `RevisionExpired` result constructors.
- `apps/web/src/server/revision-query-runner.server.ts:200-254` implements a
  Session-only Effect pipeline with execution/parse measurements and result
  annotations.
- `apps/web/src/server/revision-query-runner.server.ts:256-343` already keeps
  request parsing, fingerprinting, revision extraction, serialization, and
  result validation in data-driven query specs.
- `apps/web/src/server/revision-query-runner.server.ts:375-405` branches before
  execution: Session uses the observed pipeline; every other kind separately
  executes, maps expiry, parses, and catches failure.
- `apps/web/src/server/revision-query-runner.server.test.ts:64-132` covers
  generic exact-revision success/expiry/failure, while lines 134-267 separately
  cover the same Session outcomes plus wide-event truthfulness.
- `packages/effect-runtime/src/measured.ts:52-76` provides
  `withMeasuredIfAvailable`, which records a service hop under an existing
  boundary and becomes a no-op when no boundary is active.

## Target design

Inside `revision-query-runner.server.ts`, create one package-private generic
Effect named `runParsedRevisionQuery`:

```ts
const runParsedRevisionQuery = <Result extends RevisionQueryResult>(
  kind: RevisionQueryKind,
  request: ParsedRevisionRequest<Result>,
  dependencies: RevisionQueryRunnerDependencies,
): Effect.Effect<SessionQueryServerResult<Result>, never>;
```

It owns this complete sequence for every kind:

1. build the execution request;
2. call the injected dependency;
3. annotate bounded execution diagnostics when a boundary exists;
4. map an unavailable lease/artifact to `RevisionExpired`;
5. parse and validate the serialized payload;
6. map throws/rejections/validation errors to `QueryFailed`;
7. construct the successful `{ data, ok, requestFingerprint, revision }`.

Wrap execute and parse with `withMeasuredIfAvailable`. Generic query kinds run
this dependency-free Effect with `Effect.runPromise`, preserving their ability
to execute without an installed process runtime and without emitting an event.
`sessions` runs it through `getWebProcessRuntime().effects.runEffect` after
wrapping the same Effect in the existing
`runBoundaryEffect({ boundary: "web.sessions.read", ... })` and adds bounded
success annotations inside that boundary. Do not add events for the other six
query kinds.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Runner tests | `bun test apps/web/src/server/revision-query-runner.server.test.ts` | exit 0 |
| Runtime tests | `bun test apps/web/src/server/web-process-runtime.server.test.ts` | exit 0 |
| Production exact-revision flow | `bun run test:e2e-production` | exit 0 |
| Format check | `bun run check` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Full tests | `bun run test` | exit 0 |
| Diff safety | `git diff --check` | exit 0, no output |

## Scope

**In scope**:

- `apps/web/src/server/revision-query-runner.server.ts`
- `apps/web/src/server/revision-query-runner.server.test.ts`
- `apps/web/src/server/web-process-runtime.server.ts` and its test only if the
  effect-executor type needs a generic error-environment correction
- `docs/architecture.md` — only if its exact-revision paragraph describes two
  runner lifecycles after the implementation

**Out of scope**:

- request/result shapes or public query-kind names;
- report revision leases, artifact budgets, subprocess commands, or timeouts;
- query-spec parsers and domain validation rules;
- emitting wide events for non-Session query kinds;
- changing boundary classification or annotation cardinality;
- browser retry/supersession/commit behavior;
- moving the artifact runner into report-core or report-data.

## Git workflow

- Branch: `refactor/044-unify-revision-query-lifecycle`
- Prefer a parity-test commit followed by one implementation commit. Example
  messages: `Cover exact revision query lifecycle parity` and
  `Unify revision query execution and validation`.
- Do not push or open a pull request unless explicitly requested.

## Steps

### Step 1: Freeze parity across observed and unobserved queries

Before refactoring, add a compact table-driven matrix using one representative
generic kind (`session-detail-anchor`) and `sessions`. For both paths, assert:

- valid execution produces the parsed typed result with the requested revision
  and fingerprint;
- `{ ok: false }` execution maps to `RevisionExpired`;
- a dependency rejection maps to `QueryFailed`;
- invalid JSON, wrong revision, and wrong request fingerprint map to
  `QueryFailed`.

Keep the existing Session-specific assertions for one event, failure
classification, `revision.execute`/`revision.parse` services, bounded diagnostic
annotations, and success summary. Also assert the representative generic query
does not emit its own boundary event.

Use plan 043's lightweight process runtime fixture only for Session cases.
Generic cases must continue to pass with no process runtime installed. Do not
reintroduce policy stores, publication ports, source maps, or source schedulers.

**Verify**:

```sh
bun test apps/web/src/server/revision-query-runner.server.test.ts
```

The parity matrix passes against the pre-refactor behavior.

### Step 2: Extract one typed Effect lifecycle

Implement `runParsedRevisionQuery` with `Effect.tryPromise`,
`Effect.try`, and `withMeasuredIfAvailable`. Catch failures inside this shared
Effect so every kind returns the existing typed protocol failure rather than
rejecting.

Keep execution diagnostics attached to the `revision.execute` measured service
when an outer boundary exists. Parsing must remain inside the shared Effect and,
for Session, therefore inside `web.sessions.read`; a result must never be
classified as success before revision/fingerprint validation completes.

Do not weaken generic result types with `any` or assertions. If TypeScript
cannot preserve the `Result` relation, deepen `RevisionQuerySpec` or add a
generic helper; do not create kind-specific execution branches.

**Verify**: the runner test exits 0 and both paths pass the same error matrix.

### Step 3: Make observability a wrapper, not a second runner

Replace `runSessionQueryBoundary` with a small wrapper that accepts the shared
Effect:

- call `runBoundaryEffect` with the existing boundary name, initial
  fingerprint/revision annotations, and classifier;
- on successful Session data, annotate `hasCursor`, `hasMore`, `itemCount`,
  `pageSize`, `queryKind`, and `sessionCount`;
- return the exact shared protocol result for success, expiry, parse failure,
  and dependency failure.

In `runRevisionQueryForServer`, parse the spec once, construct the shared Effect
once, then:

- for `sessions`, add the boundary wrapper and execute it through
  `getWebProcessRuntime().effects.runEffect`;
- for every other kind, execute the unwrapped dependency-free Effect through
  `Effect.runPromise`.

There must be no direct `dependencies.execute` or `request.parseResult` call
outside `runParsedRevisionQuery`.

**Verify**:

```sh
bun test apps/web/src/server/revision-query-runner.server.test.ts
```

The Session event and generic no-event assertions both pass.

### Step 4: Run architecture and repository gates

Update `docs/architecture.md` only if necessary to say that all finite
exact-revision queries share one execute/validate lifecycle, with Session
wide-event observation applied as a decorator.

**Verify**:

```sh
test "$(grep -Ec "dependencies\\.execute" apps/web/src/server/revision-query-runner.server.ts)" -eq 1
test "$(grep -Ec "request\\.parseResult" apps/web/src/server/revision-query-runner.server.ts)" -eq 1
bun run check
bun run typecheck
bun run test
bun run test:e2e-production
git diff --check
```

All commands exit 0.

## Test plan

- A table-driven parity matrix covers success, expiry, dependency rejection,
  malformed JSON, revision mismatch, and fingerprint mismatch for Session and
  one generic exact-revision query.
- Existing request parsers/specs retain their focused unit coverage.
- Session emits exactly one truthful boundary event with measured execute/parse
  services; generic kinds emit no new boundary.
- Production E2E proves the immutable revision lease and bounded artifact
  process still serve real web requests.

## Done criteria

- [ ] One typed Effect owns execute, expiry mapping, parse/validation, and
      protocol result construction for all seven query kinds.
- [ ] Session observability wraps that lifecycle without reimplementing it.
- [ ] Generic query kinds emit no new wide events.
- [ ] Generic query kinds still run without an installed web process runtime.
- [ ] Session validation finishes before its boundary is classified.
- [ ] Revision leases, bounded process behavior, request/result contracts, and
      browser coordination are unchanged.
- [ ] The parity matrix, targeted/full tests, production E2E, formatting, and
      typechecking pass.
- [ ] This plan's row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- the refactor changes a public request/result shape or query-kind name;
- generic query kinds begin emitting wide events;
- Session parsing or fingerprint/revision validation moves outside its event;
- the shared lifecycle requires a new process runtime or subprocess;
- lease retention, artifact byte/row limits, timeout, or cancellation behavior
  changes;
- TypeScript safety would require `any` or unchecked result casts;
- a verification command fails twice after one reasonable correction.

## Maintenance notes

Keep query specs declarative and keep the lifecycle singular. A future query
kind should add parsing/fingerprint/revision data plus focused tests, not another
execution branch. Observability belongs around the lifecycle and must not become
an alternative implementation of it.
