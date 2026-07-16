# Harden Source Ownership, Publication, Cancellation, and Client Contracts

**Priority:** P1
**Effort:** L
**Depends on:** 022 initial implementation at `4f5f700`
**Status:** DONE — implementation and plan 024 second-review closure are complete
**Planned at:** `4f5f700` on 2026-07-16
**Branch:** continue `feat/source-control-plane`; do not push or open a PR without explicit approval

## Outcome

Bring plan 022's implementation to its intended architecture and safety bar. A
base collector must never erase another source's durable enrichment, every
publication request must eventually be represented by a publication attempt,
and a timed-out run must stop its provider work before it can mutate storage.
The server remains the sole owner of source policy and operational state; the
browser consumes a strictly validated snapshot plus explicit publication
events.

Plan 022 must remain `IN PROGRESS` until this follow-up's done criteria pass.

## Why this is a follow-up rather than isolated patches

The review findings expose ownership mistakes at shared seams:

- `usage_rows.row_json` currently mixes producer-owned base facts with
  RTK-owned enrichment, so a later producer upsert can erase RTK data.
- publication uses a boolean queued/running guard where it needs monotonic
  demand tracking; callers can mistake a rejected enqueue for accepted work,
  and one manifest read bypasses the queue entirely;
- Effect interrupts the scheduler fiber at timeout, but the independently
  cached provider Promise can keep running and writing;
- server snapshots are cast into trusted client state without validating the
  nested axes that the UI immediately dereferences;
- ordinary finite web reads and CLI quota reads bypass the application seams
  selected by the architecture.

Fixing only the visible symptoms would preserve these ambiguous ownership
boundaries. The steps below first freeze the failures with tests, then move each
piece of state to one explicit owner.

## Non-negotiable invariants

1. Collection, enrichment, disabling, timeout, absence, empty results, and
   failures never delete previously durable usage data.
2. Session collectors own base normalized rows. `rtk.savings` owns a separate
   durable enrichment contribution; neither writer replaces the other's data.
3. Disabling a source removes future jobs only. A job already picked by a
   worker finishes normally, including its writes and dependent publication.
4. Source policy is config-only and server-local. Restart reloads default
   config; there is no client-owned or additional runtime policy database.
5. Every accepted publication request advances monotonic demand, even while a
   publication is queued or running. Successful publication acknowledges only
   the demand and data generation it actually captured.
6. Report assembly and revision creation have one runtime owner and consume
   stored data only. Reads and mutations never publish around that owner.
7. Timeout and scope shutdown abort provider work. Once a run is reported as
   `timed-out`, that run cannot subsequently write rows, quota observations,
   checkpoints, or attempt state.
8. SSE is progressive enhancement over typed server state. Reconnects remain
   correct without a replay log, and malformed payloads never enter UI state.
9. Exact-revision report loading remains owned by the existing served-report
   session; TanStack Query owns ordinary finite reads and mutations only.
10. `misconfigured`, `not-detected`, `disabled`, `timed-out`, and publication
    states have one semantic classification shared by every web presentation.

## Scope

Expected implementation areas:

- `packages/usage-store/src/index.ts` and its tests/migrations;
- `packages/report-core/src/source-control.ts` and contract tests;
- `packages/report-data/src/source-adapters.ts`, `source-control.ts`,
  `provider-quota.ts`, `index.ts`, package exports/README, and tests;
- a small number of focused `packages/report-data/src/source-control-*.ts`
  modules when they create deep ownership boundaries rather than line-count
  fragmentation;
- `packages/local-collectors/src/codex-app-server.ts` and cancellation tests;
- `apps/cli/src/quota.ts`, `main.ts`, and CLI tests;
- `apps/web/src/source-control-client.ts`, source-control server adapters,
  report publication adapters, Skills/dashboard/source routes, focused web
  presentation/query modules, and tests;
- `apps/web/e2e/**` for source-control and client-first regressions;
- `docs/architecture.md`, `docs/public-package-interfaces.md`, relevant package
  READMEs, and this plan index.

Do not redesign report calculations, add a persisted runtime policy store,
delete historical rows/enrichments, add a general WebSocket protocol, or move
exact-revision report payloads into TanStack Query.

## Before implementation: drift and safety check

The executor must read this plan and plan 022 fully, then run:

```bash
git status --short --branch
git rev-parse --short HEAD
git diff --stat 4f5f700..HEAD -- packages/usage-store packages/report-core packages/report-data packages/local-collectors apps/cli apps/web docs plans
```

If in-scope behavior has changed since `4f5f700`, re-read the changed modules
and update this plan before coding. Preserve unrelated worktree changes.

### STOP conditions

Stop and ask for direction if any of the following becomes necessary:

- rewriting or deleting existing `usage_rows` to migrate RTK enrichment;
- clearing an enrichment because a later RTK run does not reproduce it;
- persisting enable/disable state outside the existing default config;
- aborting a collector merely because the user disabled it after the worker
  picked it;
- allowing a read endpoint or mutation to call the publication builder
  directly;
- weakening exact-revision semantics, immutable revision leases, row runtime
  validation, or existing bounded I/O limits;
- exposing raw paths, raw errors, normalized rows, or credentials through SSE;
- making the CLI depend directly on `usage-store` or raw collectors for an
  application use case;
- introducing a second report/publication scheduler or a second browser owner
  for exact report revisions.

## Step 1 — Add regression tests for the three P1 failures

Freeze current behavior before refactoring.

### RTK ownership regression

In usage-store/report-data integration tests:

1. import a session base row;
2. persist RTK savings for that row;
3. re-import the same base identity without RTK fields;
4. disable or omit the RTK run;
5. assert that the stored report projection still contains the prior savings.

Also cover a changed base row with the same stable row key, a no-op base
re-import, restart/reopen of the database, and an RTK run returning no match.
No test may rely on rewriting the base row to keep enrichment fields.

### Publication demand regressions

Use a controllable publication port to prove:

- a mutation request arriving during publication causes one follow-up attempt;
- multiple concurrent requests coalesce without being lost;
- a producer change followed by an unchanged RTK run still publishes exactly
  once after RTK reaches the required watermark;
- producer no-op plus RTK no-op does not publish;
- an unchanged periodic RTK run does not rebuild a report;
- a failed publication does not acknowledge pending demand;
- two concurrent manifest/bootstrap reads cannot publish out of order.

### Timeout regression

Use a fake source/provider that waits for its `AbortSignal`, then attempts a
write. Assert the scheduler reports `timed-out`, the signal is aborted, and the
write never happens. Add a separate test proving that policy disable during a
picked run does not abort it.

These tests should fail for the intended reason at `4f5f700`; do not commit a
test that passes because it fails earlier on setup or an unrelated assertion.

## Step 2 — Give RTK enrichment its own durable contribution

Do not solve enrichment loss by teaching the generic base-row upsert to retain
a list of RTK JSON properties. That would keep mixed ownership and make future
enrichers equally fragile.

### Storage model

Add an additive usage-store table keyed by stable usage row identity and
enrichment source id. Store a validated, versioned enrichment payload and its
semantic content hash. The initial supported source id is `rtk.savings`, but
the table/API should express “one source-owned contribution” rather than a
generic JSON patch.

Expose narrow operations that:

- query enrichable base rows with their stable row keys, without previously
  composed RTK fields;
- upsert validated RTK contributions idempotently;
- overlay valid contributions when producing active report rows;
- advance semantic store generation only when the active composed projection
  changes.

The base collector continues to upsert only its normalized base row. RTK reads
base rows and writes only its own contribution. An empty, disabled, failed,
unavailable, or unmatched RTK run leaves existing contributions untouched.

### Additive migration

During a versioned schema migration, copy any valid legacy RTK fields already
embedded in `usage_rows.row_json` into the new contribution table inside an
idempotent transaction. Insert only when that row has no RTK contribution; a
later open must never overwrite a newer contribution with stale embedded
fields. Do not rewrite or delete the original row. The migration must not
advance report generation when the composed projection is unchanged. Isolate
invalid legacy enrichment using the existing corrupt-data discipline rather
than failing all report reads.

Tests must cover first migration, repeated migration, projected equivalence,
base updates, corrupt enrichment, and semantic generation/no-op behavior.

## Step 3 — Extract and harden the source-control state machine

Keep `SourceControlService` and `sourceControlLayer` as the public deep facade,
but move pure internal state and transitions out of the 557-line
`createSourceControl` closure. A suitable split is:

- a pure `source-control-state.ts` for state, invariants, start/finish/policy
  transitions, publication/RTK watermarks, and view projection;
- the existing `source-control.ts` for scoped Effect resources, queue, timers,
  workers, and service construction;
- a publication coordinator module only if it can own the full request/start/
  finish protocol behind a narrow interface.

Do not scatter individual helpers into shallow files. Pure transition tests
must cover stale queued policy revisions, queue-depth balance, disable while
queued, disable while running, re-enable of an unavailable source, RTK
dependency release, timeout classification, and generation monotonicity.

Fix the current re-enable defect: enabling an unavailable source derives its
reason from availability/detection state and must never retain
`policy-disabled`. Represent source execution completion as a discriminated
result so timeout maps to the existing `timed-out` outcome/reason instead of
the generic `run-failed` path.

## Step 4 — Make timeout cancellation reach the provider boundary

Create an `AbortController` for each picked source job and pass its signal in
the existing run context. Link the controller to Effect interruption, timeout,
and runtime scope finalization; clean up listeners/timers on every exit.

Redesign `refreshLocalProviderQuotas` single-flight behavior. The current
module-level `Map<string, Promise<...>>` lets the scheduler stop awaiting while
the shared Promise continues. The replacement must have explicit ownership:

- the owner run controls an abortable fiber/task and removes it on completion;
- a timed-out owner aborts the Codex app-server child and prevents all later
  import/checkpoint/attempt writes from that run;
- joined callers may await existing work, but a caller cancellation must not
  accidentally abort work it does not own;
- an aborted/failed flight cannot poison the next refresh.

Audit both live app-server and rollout backfill paths. Check the signal before
every durable phase, not only inside collection. In the app-server adapter,
abort must terminate the child process and remove the abort listener; rejecting
the Promise while leaving the child alive is insufficient.

Add fake-process tests for abort before spawn/collection completion, timeout,
normal completion cleanup, child exit, no post-abort writes, joined callers,
and a successful retry after abort.

## Step 5 — Replace publication booleans with monotonic demand

Model publication with at least:

- a monotonic requested generation;
- the data/dirty generation covered by a request;
- the generations captured by the running job;
- acknowledged request/data generations from the last successful publication;
- queued/running state and the last outcome/revision needed by the view.

Every `requestPublication` advances or records demand even if a job is already
queued/running. `beginPublication` captures a target. Success acknowledges only
that target; failure acknowledges nothing. Finish enqueues one successor when
new demand or dirty data remains. Queue deduplication is an implementation
detail and must never be observable as a rejected publication request.

Producer changes that require RTK remain blocked until RTK completes the
required generation. Once released, the producer's dirty generation is enough
to publish even when RTK itself reports no storage change. Remove the current
`job.sourceId === 'rtk.savings'` unconditional publication behavior.

Only the source-control publication port may call report assembly and revision
publication. Remove the direct call from manifest/bootstrap reads and mutation
fallbacks. When no revision exists, the read adapter should request publication
and return a typed pending/unavailable result; the client retries after the
explicit publication event. It must not build a revision on the request path.

Keep revision registry commits serialized. Add a concurrency test proving an
older assembly cannot become current after a newer publication, even if its
build completes later.

## Step 6 — Remove collection side doors and restore package boundaries

Make known-project-source reads stored-only. Remove the empty-store fallback in
`createKnownLocalProjectSources` that calls
`collectConfiguredLocalRowsWithWarnings`. Rename the API if that makes its
contract unambiguous, and update Skills to use the stored-only seam. Web reads
must never launch global collectors.

CLI commands that intentionally need fresh local data must explicitly invoke
the one-shot source application port and then read stored results. Keep this
sequence inside `@ai-usage/report-data`; do not recreate orchestration in the
app.

Move the “latest durable provider quota” query behind a provider-neutral
`@ai-usage/report-data/provider-quota` application API. `apps/cli/src/quota.ts`
should render the returned contract and must no longer import local collector
configuration or `usage-store` directly.

Retain `@ai-usage/report-data/one-shot-sources` as an intentional public app
port unless implementation evidence supports a deeper existing facade. In
either case, reconcile `packages/report-data/package.json`, its README,
`docs/architecture.md`, and `docs/public-package-interfaces.md`. Remove the
stale documented CLI quota exception.

Add or extend package-boundary tests so future CLI code cannot reach
`usage-store` or raw collectors for report-data application use cases.

## Step 7 — Strictly decode source-control state and add publication SSE

In a browser-safe report-core module, implement strict parsers for source
snapshots, command responses, and publication events. Validate every nested
union and optional field, including source ids, lifecycle/availability/outcome,
reason code/message, warnings, progress, publication axes, ISO timestamps,
finite non-negative bounded counts/durations/generations, catalogue uniqueness,
and maximum serialized size. Return a typed parse failure; never cast an
unchecked object to `SourceControlView`.

Centralize the pure “choose newest snapshot” rule in the same contract layer so
server and browser do not maintain divergent replacement logic.

Emit a separate `event: report-published` after a successful new revision, with
only bounded metadata such as instance id, source-control generation, revision,
and publication timestamp. Keep `event: snapshot` for operational state. The
client must:

- strictly parse both event types and command responses;
- ignore duplicate publication revisions;
- recover from missed events using the initial/current snapshot on reconnect;
- notify finite-query consumers and the exact served-report session without
  becoming a second revision coordinator.

Do not add replay persistence or WebSockets. Test malformed nested values,
oversized events, reconnect, restart/instance change, duplicate events, and a
publication that happens between initial fetch and stream subscription.

## Step 8 — Move ordinary finite web data to TanStack Query

Create stable query keys and focused query option/fetch modules for:

- Skills snapshot/config/project-source finite reads and their mutations;
- provider quota history;
- any remaining ordinary finite source-control command mutation that benefits
  from standard pending/error/invalidation handling.

Replace manual `onMount`/Promise/signals in `routes/skills.tsx` and quota history
in `dashboard.tsx` with Solid Query primitives. Preserve Skills' dirty-draft,
selection, and mutation-concurrency guards. On `report-published`, invalidate
only finite queries whose durable inputs can have changed; do not refetch every
route blindly.

Keep focused bootstrap and exact revision payload loading in the existing
served-report session. Document this intentional boundary in code/tests so a
later cleanup does not move exact revisions into a generic cache.

## Step 9 — Complete the source-control UI and unify presentation semantics

Create one web presentation helper that maps domain states to semantic labels,
severity/tone, and actionable explanation. Both the compact summary and
`/sources` consume it; report-core must not know CSS classes.

The compact replacement for the old refresh button should expose truthful
hover/focus detail: current running source and elapsed duration, queued sources,
last success, and the next due source where known. Never show a synthetic global
countdown such as “next 42s”.

The dedicated `/sources` view must show:

- every business source independently, including `codex.sessions` and
  `codex.usage-limits`;
- enabled policy, availability, lifecycle, last outcome/reason, cadence,
  timestamps, duration, queue delay, counts/warnings/progress, and run action;
- explicit “Pausing after current run” for disable-during-run;
- publication/pipeline state, current revision, pending demand, last outcome,
  and RTK dependency/watermark in user-facing language;
- friendly first-run, disabled, not-detected, misconfigured, timed-out, and
  failed states without leaking paths or raw errors.

Replace the broad workspace `aria-live` region with a concise status region for
connection, command result, and publication changes. Ensure hover content is
also reachable by keyboard/focus and buttons expose pending/disabled reasons.

Add component and E2E coverage for all state classes, independent Codex source
toggles, disable during run, restart/default-policy reset, SSE progressive
updates, reconnect, and report refresh after `report-published`.

## Step 10 — Documentation, cleanup, and closure

Reconcile the architecture with the implemented ownership model:

- base usage facts versus source-owned enrichments in usage-store;
- the deep source-control facade and pure state machine;
- cancellation ownership and provider single-flight behavior;
- publication demand generations and the one publication owner;
- stored-only web reads and explicit CLI one-shot orchestration;
- snapshot plus `report-published` SSE semantics;
- TanStack Query versus exact served-report ownership;
- all intentional `@ai-usage/report-data` public subpaths.

Remove obsolete helpers and duplicate status/snapshot logic only after callers
have migrated. Avoid compatibility aliases unless an external consumer is
identified. Update plan 022 and this index to `DONE` only after every gate
below passes and the P1 regression tests prove the invariants.

## Verification

Run focused checks after each step, then the full repository gates.

```bash
bun test packages/usage-store/src packages/report-data/src/source-adapters.test.ts packages/report-data/src/source-control.test.ts
bun test packages/local-collectors/src/codex-app-server.test.ts packages/report-data/src/provider-quota.test.ts
bun test apps/cli/src apps/web/src/source-control-client.test.ts apps/web/src/server
bun run lint
bun run typecheck
bun run test
bun run build
bun run check
bun run test:e2e
bun run test:e2e-production
bun run test:web-production
git diff --check 06e54a3...HEAD
```

If a listed focused test path is renamed during the approved module split,
replace it with the exact successor path and record that mapping in the commit.
Do not use formatter output as proof of business correctness.

## Done criteria

- The RTK regression survives base re-import, restart, RTK disable, no-match,
  and repeated no-op runs without deleting or rewriting prior enrichment.
- No publication request is lost while queued/running; publication cannot be
  invoked from a read or mutation side path; out-of-order current revisions are
  impossible under the concurrency test.
- Timeout aborts the underlying provider and prevents every post-timeout durable
  write, while disable after pick still lets the run finish.
- Unchanged RTK cadence causes no publication, but producer dirty state is
  published after its required RTK pass even when that pass is unchanged.
- Source-control transitions are independently unit-tested behind a deep public
  facade; re-enable and `timed-out` reasons are correct.
- All server snapshots/events/command responses are strictly decoded before
  entering browser state.
- `report-published` exists, dedupes by revision, reconnects safely, and causes
  the existing exact-report owner to advance.
- Skills and quota finite reads use TanStack Query; exact-revision data does
  not.
- Web project-source reads are stored-only, CLI quota respects the report-data
  boundary, and every imported package subpath is documented.
- Summary and `/sources` share status semantics and expose complete truthful,
  keyboard-accessible operational/publication detail.
- All focused regressions, workspace checks, 34+ E2E cases, production smoke,
  Ultracite, and `git diff --check` pass.
- Plans 022 and 023 are marked `DONE` only after the implementation and docs are
  committed locally; no push or PR is created without explicit authorization.

## Suggested commit sequence

1. `test(source-control): freeze follow-up safety regressions`
2. `fix(usage-store): persist source-owned RTK enrichments`
3. `refactor(report-data): extract source-control transitions`
4. `fix(report-data): abort timed-out provider work`
5. `fix(web): make publication demand lossless`
6. `refactor(report-data): remove collection side doors`
7. `fix(web): validate source events and publish revision events`
8. `refactor(web): query finite client data with TanStack Query`
9. `feat(web): complete source control operational detail`
10. `docs(architecture): close source-control follow-up`

Each commit should leave its touched packages type-safe and its targeted tests
green. Do not combine the RTK migration and publication concurrency changes in
one commit.

## Maintenance note

Future sources and enrichers must declare one durable contribution owner, one
cadence/policy identity, and one validated projection contract. A new source
must not add a read-triggered collector, direct publisher, module-global
uninterruptible Promise, client-only policy, or UI-specific state classifier.
