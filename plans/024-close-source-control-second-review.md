# Plan 024: Close Source-Control Data, Cancellation, State, and Client Review Gaps

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update plans 022, 023, and 024 in
> `plans/README.md`; do not mark any of them `DONE` while a done criterion below
> is unmet.
>
> **Drift check (run first)**:
> `git diff --stat 106d5d9..HEAD -- packages/usage-store packages/report-core packages/report-data packages/local-collectors apps/web docs plans`
> If any in-scope file changed since this plan was written, compare the
> "Current state" facts against the live code before proceeding. If a cited
> behavior changed materially, stop and update the plan before coding.

## Status

- **Status**: IN PROGRESS
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plan 023 implementation at `106d5d9`
- **Category**: bug, tech-debt, tests, docs
- **Planned at**: commit `106d5d9`, 2026-07-16

## Why this matters

The first hardening pass fixed the common RTK overwrite path, lossless
publication demand, and provider abort propagation, but its second review found
two remaining P1 holes. A portable export/import roundtrip drops RTK savings
from the report projection, and quota writes run in independent Promises that
can commit after the scheduler has already reported a timeout. The same review
also found that source transitions remain in the large runtime closure, partial
source catalogues still pass client decoding, and the Skills Query integration
uses unsafe casts and a mutation wrapper that does not own a domain operation.

This plan closes those findings without changing the product decisions: data is
never deleted, disable-after-pick lets the run finish, source policy remains
default-config-only, publication remains server-owned, and exact report
revisions remain outside TanStack Query.

## Current state

### Portable RTK is stored in the wrong representation

- `packages/usage-store/src/index.ts:1892-1907` exports composed report rows, so
  portable rows include RTK savings.
- `packages/usage-store/src/index.ts:891-916` validates a peer bundle and passes
  its serialized rows directly to `importMergeRows`.
- `packages/usage-store/src/index.ts:851-866` writes those serialized rows only
  to `usage_rows`; it does not split an incoming RTK contribution.
- `packages/usage-store/src/index.ts:1087-1092` always strips embedded RTK fields
  and overlays only `usage_row_enrichments`. Because the schema migration ran
  before a new peer row was inserted, the imported savings disappear from the
  active projection.
- The failure was reproduced at `106d5d9`: a bundle with
  `rtkSavedTokens: 7` imported successfully, but `queryReportRows` returned the
  row without `rtkSavedTokens`.

### Quota persistence outlives the scheduler fiber

- `packages/report-data/src/source-control.ts:478-496` aborts the per-run
  controller and records `timed-out` when `Effect.timeoutOption` wins.
- `packages/report-data/src/provider-quota.ts:181-305` implements the owner work
  as an async function containing multiple independent `Effect.runPromise`
  calls.
- Signal checks at `provider-quota.ts:207`, `216`, `276`, and `299` happen
  around durable calls, but cannot interrupt an already-running independent
  import or attempt write.
- `packages/report-data/src/provider-quota.test.ts:39-97` aborts while the fake
  collector is waiting. It does not suspend inside the durable phase, so it
  cannot prove the no-post-timeout-write invariant.

### State, client, and presentation ownership are incomplete

- `packages/report-data/src/source-control-state.ts` owns state types,
  classification helpers, sanitizers, and projection, but the actual queue,
  source completion, policy, RTK, and publication transitions remain nested in
  `createSourceControl` at `source-control.ts:123-725`.
- `packages/report-data/src/source-control-state.test.ts` tests three helper
  scenarios but not queue-depth balance or begin/finish publication transitions.
- `packages/report-core/src/source-control.ts:521-550` accepts unique valid
  source entries without requiring the complete seven-source catalogue. Its
  current test fixture intentionally contains only `claude.sessions`, proving a
  partial snapshot passes.
- `apps/web/src/skills-route-controller.ts:137-138` asserts Query data to
  `ProjectInventoriesResult` rather than narrowing or decoding it.
- `apps/web/src/skills-route-controller.ts:139-140` creates one mutation whose
  variable is an arbitrary `() => Promise<void>`; `runOperation` still owns all
  meaningful pending/error/domain behavior.
- Tone-to-CSS mapping is duplicated in
  `apps/web/src/components/source-control-summary.tsx:93-103` and
  `apps/web/src/routes/sources.tsx:94-102`.
- The summary derives elapsed time from `snapshot.generatedAt` at
  `source-control-summary.tsx:145-151`; it freezes when a running source emits
  no progress or other state change.
- `docs/public-package-interfaces.md:34` still claims
  `@ai-usage/local-collectors/codex-history` serves CLI quota output even though
  the CLI now uses the report-data one-shot application port.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused store | `bun test packages/usage-store/src/index.test.ts` | all tests pass |
| Focused scheduler | `bun test packages/report-data/src/source-control-state.test.ts packages/report-data/src/source-control.test.ts packages/report-data/src/provider-quota.test.ts` | all tests pass |
| Focused contracts/web | `bun test packages/report-core/src/source-control.test.ts apps/web/src/source-control-client.test.ts apps/web/src/server/source-control-api.server.test.ts apps/web/src/skills-route-controller.test.ts` | all existing/new tests pass; if the controller test is split, use its exact successor path |
| Lint and boundaries | `bun run lint` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Workspace tests | `bun run test` | exit 0 |
| Production build | `bun run build` | exit 0 |
| Ultracite | `bun run check` | exit 0, no findings |
| Browser E2E | `bun run test:e2e` | all tests pass |
| Production E2E | `bun run test:e2e-production` | all tests pass |
| Bun smoke | `bun run test:web-production` | healthy loopback-only production routes |
| Whitespace | `git diff --check 106d5d9...HEAD` | no output |

## Scope

**In scope**:

- `packages/usage-store/src/index.ts` and `index.test.ts`;
- `packages/report-data/src/provider-quota.ts`, a private focused runtime module
  if needed, and provider quota tests;
- `packages/report-data/src/source-control.ts`,
  `source-control-state.ts`, and their tests;
- `packages/report-core/src/source-control.ts` and its tests;
- `apps/web/src/skills-route-controller.ts`, `web-query-options.ts`, a focused
  browser-safe Skills result contract if needed, and tests;
- `apps/web/src/source-control-presentation.ts`,
  `components/source-control-summary.tsx`, `routes/sources.tsx`, and tests;
- `apps/web/server/plugins/source-control.ts` and `apps/web/e2e/**` only for a
  deterministic source-control E2E fixture;
- `docs/architecture.md`, `docs/public-package-interfaces.md`, affected package
  READMEs, and plans 022–024/index status.

**Out of scope**:

- deleting, clearing, or rewriting old usage rows merely to normalize them;
- changing merge bundle wire format or invalidating existing bundles;
- persisting enable/disable state outside the existing config defaults;
- cancelling a source because it was disabled after a worker picked it;
- redesigning publication generations, SSE transport, report calculations, or
  immutable revision leasing unless a regression test proves they are involved;
- moving exact-revision report payloads into TanStack Query;
- adding WebSockets, client-owned scheduling, or a new policy database;
- changing collector cadences or business-source identities.

## Git workflow

- Continue on `feat/source-control-plane` unless the operator asks for another
  branch.
- Commit one logical step at a time using the repository's conventional style,
  for example `fix(usage-store): preserve portable RTK contributions`.
- Do not push or open a pull request without explicit authorization.
- Preserve unrelated worktree changes and never use destructive Git commands.

## Steps

### Step 1: Freeze both remaining P1 failures before changing implementation

In `packages/usage-store/src/index.test.ts`, add an end-to-end portable
roundtrip regression:

1. import a local base row and a separate RTK contribution on machine A;
2. export machine A with `exportLocalMergeBundle`;
3. import that bundle into a fresh machine B store after its schema migration
   has completed;
4. assert machine B's active report projection retains every RTK metric;
5. re-import the same bundle and assert semantic no-op behavior;
6. import a later version of the same base row without RTK fields and assert the
   existing contribution remains;
7. import changed RTK fields with an unchanged base row and assert the composed
   projection and generation change exactly once.

Also assert that preview and confirm classifications agree after incoming rows
are canonicalized. The test must fail at `106d5d9` because the projected RTK
fields are absent, not because of machine identity or bundle validation.

For quota cancellation, first extract an internal dependency-injected refresh
factory in `packages/report-data/src/provider-quota.ts` or a private sibling
module. Its persistence port must expose the existing query/import/attempt
operations as Effects; it is not a new public package export. In
`provider-quota.test.ts`, supply a fake durable operation that:

1. signals when the write phase has been entered;
2. remains interruptible until explicitly released;
3. records whether a commit action ran;
4. receives an owner interruption while suspended;
5. proves the scheduler-facing refresh exits as aborted and the commit action
   remains false after release.

Add separate cases for a joined caller cancelling without stopping the owner,
owner cancellation stopping all joiners, and a successful fresh flight after
abort.

**Verify**:

```bash
bun test packages/usage-store/src/index.test.ts packages/report-data/src/provider-quota.test.ts
```

Expected before fixes: the new RTK projection and durable-phase interruption
tests fail for their named assertions. Expected after steps 2–3: all pass.

### Step 2: Canonicalize RTK contributions on every import path

Create one pure internal preparation function in
`packages/usage-store/src/index.ts` that accepts a validated
`SerializedMergeRow` and returns:

- the same stable row identity/status/source with RTK fields removed and its
  base `contentHash` recomputed; and
- an optional strictly validated `RtkSavingsContribution` with its own content
  hash.

Use this preparation function for local imports, peer imports, preview, and
confirm. Do not special-case only `importPeerMergeBundle`: every post-migration
write path must be unable to create a new mixed-ownership row.

Within the existing `BEGIN IMMEDIATE` import transaction:

- classify and insert/update the canonical base row;
- insert/update/touch an incoming RTK contribution using the same statements
  and schema version as `upsertRtkSavingsContributions`;
- never delete or clear an existing contribution when an incoming row omits
  RTK fields;
- count a changed active contribution as a semantic projection change even
  when the base row is unchanged;
- advance store generation at most once for the complete transaction;
- keep `ImportResult` row-based and make preview compute the same
  classification as confirm.

Extract shared enrichment statements/classification helpers rather than
duplicating the migration, normal RTK upsert, and merge-import logic. Keep the
versioned legacy migration additive: it may populate a missing contribution,
but it must neither overwrite a newer contribution nor rewrite an old row.

Preserve the existing bundle parser and byte/row limits. Recompute only the
canonical stored base hash; never mutate the caller's validated bundle object.

**Verify**:

```bash
bun test packages/usage-store/src/index.test.ts
```

Expected: portable RTK roundtrip, absent-field preservation, changed
contribution, preview/confirm, migration, local re-import, and generation tests
all pass.

### Step 3: Make quota single-flight and persistence one interruptible Effect

Replace the async `runRefresh` plus nested `Effect.runPromise` calls with one
Effect program. Query, collection, import, attempt recording, backfill, and
latest projection must all be yielded by the same owner fiber. The only
Promise boundary should be the provider process adapter already wrapped as an
interruptible Effect.

Replace `Map<string, Promise<...>>` ownership with an Effect-native flight that
stores a fiber/deferred result per database-and-machine key:

- the first caller owns the flight;
- owner interruption interrupts the flight and aborts the provider child via a
  scoped `AbortController` finalizer;
- joined callers await the same result but their interruption only stops their
  own wait;
- an owner failure/interruption completes joiners consistently and removes the
  map entry;
- a later caller always starts a clean flight.

Do not attempt to cancel halfway through a synchronous SQLite transaction.
Instead, keep each transaction atomic/uninterruptible and in the owner fiber:
if it has begun, the scheduler cannot publish `timed-out` until it returns; if
interruption wins first, the transaction must not begin. This ordering is what
guarantees there is no commit after the timeout becomes observable.

Keep live failure classification and warning behavior, but never record a
failed attempt merely because the owner was interrupted. Verify both live and
backfill import/checkpoint paths use the same interruption discipline.

**Verify**:

```bash
bun test packages/report-data/src/provider-quota.test.ts packages/report-data/src/source-control.test.ts packages/local-collectors/src/codex-app-server.test.ts
```

Expected: mid-durable-phase owner interruption, joined-caller isolation,
provider child abort, no post-timeout write, normal cadence, and retry tests all
pass without timers or leaked fibers.

### Step 4: Move all source-control transitions into the pure state module

Deepen `packages/report-data/src/source-control-state.ts` so it owns every
business transition. Use pure functions returning a typed result such as
`{ state, decision }`; decisions tell the runtime which queue/timer/provider
effect to perform without importing Effect, Queue, FiberMap, or server ports.

Move these behaviors out of `createSourceControl`:

- request and deduplicated queue admission for sources/publication;
- detection application;
- source job begin/stale-policy decision;
- progress update and source completion;
- dirty/RTK required/completed watermark changes;
- publication begin/wait target and publication finish/acknowledgement;
- policy enable/disable transition.

Leave `source-control.ts` responsible only for scoped resources and
interpretation: obtaining time, applying a pure transition atomically through
`SubscriptionRef.modify`, offering jobs, managing cadence fibers, invoking
sources/publication, and handling service commands.

Expand `source-control-state.test.ts` with table-driven pure tests for:

- queue depth on accepted, rejected, stale, and completed jobs;
- disable while queued and disable while running;
- re-enable while unavailable;
- timeout/failure/unavailable outcomes;
- producer dirty generation and RTK dependency release;
- publication requested/captured/acknowledged generations;
- demand arriving while publication runs;
- publication failure preserving demand;
- generation monotonicity.

Keep the existing integration tests as runtime interpreter tests. Do not split
helpers into many shallow files; `source-control-state.ts` is the single owner.

**Verify**:

```bash
bun test packages/report-data/src/source-control-state.test.ts packages/report-data/src/source-control.test.ts
rg -n "const (beginSourceJob|completeSource|beginPublication|finishPublication)" packages/report-data/src/source-control.ts
```

Expected: tests pass and the `rg` command returns no matches. Runtime code may
have orchestration functions, but no inline state-transition implementations
with those responsibilities.

### Step 5: Require the exact bounded source-control catalogue

Refactor the browser-safe decoders in
`packages/report-core/src/source-control.ts` to construct validated domain
objects rather than returning an unchecked `as SourceControlView` cast.

For snapshots:

- require exactly `collectionSourceDefinitions.length` entries;
- require each canonical source id exactly once, with no missing/extra ids;
- retain strict nested key, union, timestamp, warning, and size validation;
- add explicit operational bounds in `sourceControlBounds` for queue depth,
  counts, durations/cadence, and generations, derived from the scheduler's
  existing queue/cadence/timeout constraints rather than parser-only magic;
- validate `runningCount`, lifecycle consistency, publication generation
  ordering, and queue bounds together.

Make server sanitizers use the same bounds so the server cannot emit state the
client rejects. Keep `chooseNewestSourceControlSnapshot` pure and shared.

Change the test fixture to contain the complete catalogue. Add explicit
rejections for empty, missing, duplicate, unknown, oversized-count, invalid
generation-order, and inconsistent running snapshots. Command responses and
`report-published` events must continue to use their strict decoders.

**Verify**:

```bash
bun test packages/report-core/src/source-control.test.ts apps/web/src/source-control-client.test.ts apps/web/src/server/source-control-api.server.test.ts
```

Expected: all valid server snapshots parse; every partial or out-of-bound
fixture fails before entering client state.

### Step 6: Give Skills mutations a typed Query operation and unify presentation

In `apps/web/src/web-query-options.ts` or a focused sibling module:

- give `loadSkillInventories` an explicit validated
  `Promise<ProjectInventoriesResult>` result;
- introduce a discriminated `SkillsMutationRequest` union for the actual
  operations used by the controller (save config, toggle, reconcile one/all,
  preview, create target, refresh);
- implement one typed mutation function over that union, or separate focused
  mutations where result shapes differ materially;
- use stable mutation keys and return the typed server result needed to update
  Query data.

In `skills-route-controller.ts`, pass domain variables to `mutateAsync`, never
an arbitrary closure. Use the mutation's pending/error/variables state instead
of duplicating generic transport state. Keep dirty-Markdown replacement guards,
selection, notices, and domain-specific post-success decisions in the
controller. Remove the `ProjectInventoriesResult` assertion; decode or narrow
the server result.

Move the tone-to-class function to one web presentation owner consumed by both
the summary and `/sources`. Keep semantic labels/explanations in
`source-control-presentation.ts`; do not move CSS classes into report-core.

Make elapsed running time truthful. A presentation-only clock may tick while a
running source is visible in the open/focused summary and must stop on cleanup;
it must never schedule collection, mutate server state, or invent a next-run
countdown. Alternatively render the authoritative start timestamp without an
elapsed claim if a live presentation clock cannot be scoped safely.

Add controller tests for typed mutation success/failure, cache update,
dirty-draft protection, and concurrent-operation rejection. Add presentation
tests proving both surfaces classify every availability/lifecycle/outcome the
same way.

**Verify**:

```bash
bun test apps/web/src/skills-route-controller.test.ts apps/web/src/source-control-client.test.ts apps/web/src/source-control-presentation.test.ts
rg -n "as ProjectInventoriesResult|mutationFn: async \(action" apps/web/src
```

Expected: tests pass and `rg` returns no matches. If existing/new tests use
different focused filenames, substitute those exact paths and record the
mapping in the commit.

### Step 7: Add missing system coverage and reconcile documentation

Add a deterministic source-control fixture for browser E2E rather than relying
on a developer's real local files. It must expose the complete seven-source
catalogue and controllable snapshots/commands only when
`VITE_AI_USAGE_E2E=1`; production continues to use real Bun adapters.

Add `apps/web/e2e/sources.spec.ts` covering at minimum:

- `codex.sessions` and `codex.usage-limits` render as separate business sources;
- toggling one does not change the other;
- disable during a picked run renders “Pausing after current run” and then
  dormant/disabled after completion;
- malformed/partial SSE state does not replace the last valid UI state;
- a `report-published` event advances the existing report owner once;
- hover and keyboard focus expose the same summary detail;
- running elapsed detail changes truthfully, while next-due remains an absolute
  per-source fact rather than a global countdown.

Keep config reset-on-server-restart and SSE reconnect/instance replacement in
server/client integration tests where lifecycle control is deterministic. Do
not make Playwright restart a real user server merely to duplicate those tests.

Update:

- `docs/architecture.md` with portable contribution canonicalization and
  Effect-fiber single-flight ownership;
- `docs/public-package-interfaces.md` to remove the stale CLI use of
  `./codex-history` while retaining the export only if a real public caller
  still needs it;
- package READMEs with the completed pure transition and client-contract seams;
- plans 022–024/index statuses only after all gates pass.

**Verify**:

```bash
bun run test:e2e
bun run test:e2e-production
bun run test:web-production
rg -n "codex-history.*CLI quota|CLI quota.*codex-history" docs packages/*/README.md README.md CONTEXT.md
```

Expected: all browser/production tests pass and the final `rg` returns no stale
CLI quota claim.

## Test plan

New or strengthened coverage must include:

- `packages/usage-store/src/index.test.ts`: local export → fresh peer import
  with RTK, repeated no-op, later base without RTK, changed contribution,
  preview/confirm equivalence, and one generation advance;
- `packages/report-data/src/provider-quota.test.ts`: owner interrupted inside a
  fake durable phase, joiner cancellation isolation, backfill/checkpoint abort,
  cleanup, and clean retry;
- `packages/report-data/src/source-control-state.test.ts`: direct pure coverage
  of every queue/policy/run/RTK/publication transition;
- `packages/report-core/src/source-control.test.ts`: exact catalogue and
  explicit numeric bounds;
- focused Skills controller/query tests: typed domain mutation variables,
  runtime result validation, cache/dirty-draft behavior, and errors;
- source presentation tests: one shared semantic/tone mapping and truthful
  running detail;
- deterministic Sources E2E plus existing reconnect/restart integration tests.

Use the existing test style: Bun `describe`/`test`, temporary private stores,
Effect fakes/Deferred for concurrency, and Playwright role-based locators. Never
use arbitrary sleeps for concurrency assertions; signal phase entry with
Deferred/promises or observable state.

## Done criteria

- [ ] A composed local RTK row survives portable export/import into a fresh
      migrated store, and later imports without RTK do not clear it.
- [ ] Preview and confirm canonicalize the same base/contribution pair, and
      semantic generation advances once per changed transaction.
- [ ] No post-migration import path can create a newly mixed base row with
      embedded-only RTK ownership.
- [ ] Quota collection and every durable phase run in one owner Effect fiber;
      there are no nested `Effect.runPromise` calls in the refresh program.
- [ ] Owner timeout/interruption cannot be observed before an in-flight atomic
      write finishes and cannot start a later write; joined caller cancellation
      does not abort the owner.
- [ ] `createSourceControl` interprets pure state transitions instead of owning
      source/publication/policy transition logic inline.
- [ ] Partial source catalogues and out-of-bound operational numbers are
      rejected before client state replacement, without an unchecked snapshot
      cast.
- [ ] Skills Query mutations receive typed domain variables, inventory results
      are narrowed/decoded, and the arbitrary closure mutation is gone.
- [ ] Summary and `/sources` use one tone mapping and expose truthful running
      detail through hover and keyboard focus.
- [ ] The stale `codex-history` CLI documentation is removed or corrected.
- [ ] New focused tests and Sources E2E cover every regression listed above.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`,
      `bun run check`, both E2E commands, Bun production smoke, and
      `git diff --check 106d5d9...HEAD` all pass.
- [ ] Plans 022, 023, and 024 are marked `DONE` only after the implementation,
      tests, and documentation are committed locally.

## STOP conditions

Stop and report back instead of improvising if:

- preserving portable RTK appears to require deleting or rewriting existing
  historical rows;
- canonical base preparation changes a row key/source fingerprint or requires
  a merge bundle wire-format change;
- preview and confirm cannot share the same canonical preparation without
  weakening bundle validation or stale-preview protection;
- cancellation requires terminating a synchronous SQLite transaction midway;
- a proposed single-flight lets a joiner abort work owned by another caller;
- pure transition extraction changes disable-after-pick, publication demand,
  RTK watermark, queue capacity, or cadence behavior;
- exact catalogue validation would prevent a supported intentionally partial
  server runtime from producing snapshots — tests may construct partial source
  maps internally, but the public view must still project all seven definitions;
- Skills response validation requires importing server-only code into the
  browser bundle;
- deterministic E2E requires exposing a fixture control endpoint in production;
- any step would move policy, scheduling, or exact-report ownership to the
  browser.

## Suggested commit sequence

1. `test(source-control): freeze second-review regressions`
2. `fix(usage-store): preserve portable RTK contributions`
3. `fix(report-data): own quota persistence in an Effect flight`
4. `refactor(report-data): complete pure source transitions`
5. `fix(report-core): require the complete bounded source catalogue`
6. `refactor(web): model typed Skills query mutations`
7. `test(web): cover source control lifecycle end to end`
8. `docs(architecture): close the second source-control review`

Do not combine the RTK storage transaction and quota cancellation changes in a
single commit.

## Maintenance notes

- Every future portable row field needs an explicit owner: base producer,
  source-owned contribution, or portable metadata. Export/import must preserve
  the same composed projection without reintroducing mixed ownership.
- Provider single-flight must remain fiber-owned. A module-level Promise may be
  used only for an external API boundary, never as the owner of durable work.
- New source ids require updating the canonical definitions and strict parser
  fixture together; partial catalogues are internal test/runtime configuration,
  not a public snapshot shape.
- Source-control runtime changes should add a pure transition test first, then
  an interpreter integration test only where Effect resources matter.
- TanStack mutations should represent domain operations and cache effects, not
  serve as wrappers around arbitrary callbacks.
