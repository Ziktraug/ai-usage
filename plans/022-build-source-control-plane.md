# Build a Server-Owned Source Control Plane and Client-First Web App

**Status:** IN PROGRESS  
**Priority:** P1  
**Effort:** L  
**Depends on:** 017, 018, 021  
**Branch:** `feat/source-control-plane` (already created from `06e54a3`)  
**Risk:** High — this changes the Nitro production runtime, collection ownership, scheduling, persistence, report publication, and the web data-loading model.

## Outcome

Replace the browser-owned one-minute refresh illusion with a server-owned control plane whose independently scheduled business sources detect, collect, normalize or enrich, and persist their own contributions before a separate report-publication job reconciles the stored projection.

The delivered product must expose that real model through:

- a dedicated `/sources` view;
- one explicit enable/disable policy per business source;
- independent availability, lifecycle, outcome, cadence, and progress state;
- `Run now`, `Run all enabled`, and `Detect sources again` commands;
- an accessible compact source summary where the old refresh control lived;
- one root-owned SSE connection carrying sanitized, precomputed control-plane snapshots;
- client-side business-data acquisition for every web route, while retaining SolidStart SSR for the application shell and routing.

No operation introduced by this plan may delete collected data. Disabling a source pauses future collection only. Missing input, a disabled source, an empty run, or a failed run must preserve every previously stored row, quota observation, enrichment, and dataset item.

## Why this is one architectural program

The current UI presents collection as one browser timer and one refresh button, but the back end already combines several unrelated collectors, quota probes, enrichment passes, and report reconciliation steps. Adding per-source toggles only in the UI would create false state and would leave collection coupled to report generation. Conversely, changing scheduling without changing report publication and web ownership would retain the same hidden monolith behind a different button.

This plan therefore treats source policy, autonomous adapters, the Effect scheduler, persistence, publication, SSE, and client-first route data as one staged migration. Each stage must remain independently testable and committable; do not land an intermediate stage that silently changes deletion, exact-revision, privacy, or normal CLI behavior.

## Out of scope

- Persistent runtime status, durable queue replay, or cross-process scheduler coordination.
- User-configurable worker count, cadence, retry policy, or arbitrary collector plugins.
- Periodic source redetection, filesystem watching, fast retry, or exponential backoff.
- WebSocket command transport or an SSE replay/event-sourcing protocol.
- Remote/LAN control, multi-machine source-state sync, or background execution outside the local server process.
- Data deletion, retention controls, reset buttons, tombstones, or “replace all” imports.
- Reclassifying Cursor SQLite and CSV as separate business sources, or Codex live quota and rollout backfill as separate business sources.
- Deployment targets other than the local long-lived Nitro Bun server.

## Confirmed product decisions

These decisions were explicitly agreed and are requirements, not implementation suggestions:

1. Source state is authoritative on the server, never client-only.
2. Enable/disable is per business source, not per harness or UI group.
3. Codex sessions and Codex usage limits are separate business sources with independent toggles and cadences.
4. Cursor SQLite and configured Cursor CSV inputs remain internal inputs of one `cursor.sessions` source.
5. Codex live app-server polling and rollout JSONL backfill remain internal substeps of one `codex.usage-limits` source.
6. RTK savings and Cursor commit attribution are autonomous enrichment/dataset sources with their own toggles.
7. Detection runs at server start and only again through the explicit `Detect sources again` command.
8. The scheduler is server-only and runs without an open browser.
9. The queue replenishes each source after its completed run. Removing a source from future scheduling does not cancel a run already taken by a worker.
10. One worker is the default. Worker count may be an internal constructor/test parameter, but is not a user setting in this plan.
11. Failed sources retry at their normal cadence. There is no fast retry or exponential backoff in V1.
12. Session and enrichment sources default to one minute. Codex usage limits defaults to five minutes.
13. Runtime source state is intentionally ephemeral. A server restart resets it to `Not run yet`, runs detection, and immediately queues all enabled and detected sources.
14. Only explicit user policy overrides persist. Availability, progress, queue state, last outcome, and next due time do not.
15. Repository-local `ai-usage.config.ts` cannot override source policy. Only the user's home configuration owns it.
16. Disabling a running source lets the current run complete and import; it prevents later runs. The UI should say `Pausing after current run` during that transition.
17. A disabled source cannot be run manually until re-enabled. Enabling an available source queues it immediately.
18. A queued or running source is not duplicated by a manual command.
19. A successful manual run resets that source's next cadence from completion.
20. A source that discovers its input disappeared becomes dormant and is not requeued until explicit detection.
21. Historical data remains visible while its source is disabled or unavailable.
22. SSE is the live server-to-client transport. Commands remain validated HTTP POST/server functions.
23. SSE sends bounded full control-plane snapshots, not a durable patch/event log and not report rows.
24. The web application becomes fully client-first for business data. SolidStart still renders the SSR shell, layout, and routes.
25. Exact-revision report acquisition remains a specialized atomic client protocol; generic query invalidation must not mix revisions between Overview, Breakdown, and Sessions.

## Source catalogue and defaults

Use stable IDs in configuration, storage, commands, logs, tests, and SSE DTOs. Labels are presentation and may change; IDs may not.

| Stable source ID | Group | Kind | Default cadence | Detection meaning | Persisted contribution |
| --- | --- | --- | --- | --- | --- |
| `claude.sessions` | Sessions | Producer | 1 minute | Claude history input exists and is readable | Normalized usage rows |
| `codex.sessions` | Sessions | Producer | 1 minute | Codex session history input exists and is readable | Normalized usage rows |
| `opencode.sessions` | Sessions | Producer | 1 minute | At least one supported OpenCode history database is available | Normalized usage rows |
| `cursor.sessions` | Sessions | Producer | 1 minute | At least one supported Cursor SQLite or configured CSV input is available | Normalized usage rows |
| `codex.usage-limits` | Provider usage | Producer | 5 minutes | At least one of live Codex app-server access or rollout history is available | Provider quota observations and source checkpoints |
| `rtk.savings` | Enrichments | Enricher | 1 minute | The supported RTK database is available | Updated normalized usage rows with RTK savings |
| `cursor.commit-attribution` | Enrichments | Dataset producer | 1 minute | The supported Cursor attribution database is available | Versioned normalized dataset items |

The UI may group related sources, but grouping must never merge policy, status, cadence, run commands, or result counts.

## Domain model and invariants

### Collection source

Add `Collection source` to the ubiquitous language in `CONTEXT.md`. A collection source is an independently detected, scheduled, policy-controlled contribution to the normalized local store. It is not synonymous with a harness: one harness can expose multiple business sources, as Codex does.

Every source owns the normalization of its output before persistence:

```text
session history -> CollectedSession -> normalized UsageRow -> usage-store upsert
RTK database + stored UsageRow -> enriched normalized UsageRow -> usage-store upsert
Cursor attribution database -> normalized dataset item -> dataset-store upsert
Codex app-server/rollout history -> ProviderQuotaObservation -> quota-store upsert
```

The scheduler must not know about Claude, Codex, Cursor, RTK, normalization, SQLite schemas, or report payloads. It schedules a small source interface and a separate publication job.

### Independent state axes

Do not compress all state into one `status` string. The browser-safe contract must expose these independent axes:

- **Policy:** `enabled` or `disabled`.
- **Availability:** `detected`, `not-detected`, `unsupported`, or `misconfigured`.
- **Lifecycle:** at least `dormant`, `scheduled`, `queued`, `running`, and `pausing`.
- **Last outcome:** `not-run`, `success`, `warning`, `failed`, or `skipped`.
- **Reason:** a stable bounded reason code plus an optional bounded human-readable message.

Derive display badges from these axes. Do not persist them. Do not call a missing input `stopped`; use `Not detected` or `Dormant`.

### Non-destructive persistence

The following are permanent invariants:

- Policy changes never delete or clear data.
- Detection changes never delete or clear data.
- An empty run never means “delete absent items.”
- A failed run keeps the last good contribution.
- Disabling RTK keeps existing RTK savings on stored rows.
- An ordinary upsert may update a fact with the same stable identity, but absence never creates an implicit tombstone.
- Any future destructive operation requires a separate explicit product decision and plan.

### Adapter seam

Start with a browser-safe pure contract and a runtime adapter along these lines; refine names during implementation without weakening the separation:

```ts
interface ScheduledSource {
  readonly id: CollectionSourceId;
  readonly cadence: Duration.Duration;
  readonly detect: Effect.Effect<SourceDetectionResult, SourceDetectionError>;
  readonly run: (
    context: SourceRunContext
  ) => Effect.Effect<SourceRunResult, SourceRunError>;
}

interface SourceRunResult {
  readonly changed: boolean;
  readonly inputCount: number;
  readonly outputCount: number;
  readonly warnings: readonly SourceWarning[];
}

interface SourceProgress {
  readonly phase: "discovering" | "reading" | "normalizing" | "importing";
  readonly completed?: number;
  readonly total?: number;
  readonly message?: string;
}
```

Progress is part of the V1 protocol but optional for each adapter. Emit coarse phase progress first where fine counts are unavailable. Progress and error DTOs must never contain prompts, raw records, secrets, private paths, Codex app-server responses, or unbounded collector messages.

## Current-state evidence and constraints

Re-read these seams before editing; line numbers are orientation only and may drift:

- `packages/local-collectors/src/collected-session.ts` already calls `normalizeUsageRow` inside `sessionToUsageRow`. Preserve and deepen that ownership rather than moving normalization into the scheduler.
- `packages/local-collectors/src/collectors/index.ts` owns the current registry, runs all adapters with `concurrency: 1`, concatenates every result, then applies RTK globally. This is the monolithic ownership to split.
- `packages/report-data/src/index.ts` currently collects all local rows, imports them as one batch, reads Cursor commit attribution live, and assembles a report. Report publication must stop collecting.
- `packages/usage-store/src/index.ts` already upserts received usage rows without deleting absent rows. Preserve that semantic and make it explicit in tests.
- Provider quota observations and history are already persisted, but `apps/web/src/provider-quota-client.ts` owns a visible-tab five-minute poller. Move scheduling to the server and remove the browser poller.
- `apps/web/src/server/report-payload.server.ts` coordinates collection and an in-memory refresh promise; `apps/web/src/dashboard.tsx` owns the one-minute refresh timer and `RefreshStatus`. Both orchestration paths are superseded.
- `apps/web/src/routes/index.tsx` and `apps/web/src/routes/skills.tsx` use business-data route loaders. These must become client-side reads after hydration.
- `apps/web/src/routes/__root.tsx` already installs a TanStack `QueryClientProvider`; use that client for finite reads and mutations instead of adding another generic cache.
- `served-report-session.ts`, `dashboard-served-report-session.ts`, and `focused-report-client.ts` encode exact-revision acquisition and atomic destination commits. Keep this as the deep report seam.
- Local trust checks live in `apps/web/src/server/local-request-trust.server.ts`; SSE and all new commands must use the same loopback/Origin/Fetch-Metadata policy.
- The production Nitro host currently runs under Node, while `usage-store` and history access depend on Bun facilities such as `bun:sqlite`. Existing report and quota flows cross Bun subprocess boundaries as a runtime workaround.
- Nitro v3 officially provides the `bun` preset, selects Bun export conditions, and runs the generated server with `bun run ./.output/server/index.mjs`; the installed Nitro package contains that same preset. This plan intentionally migrates the web host to Bun instead of preserving the Node/Bun workaround. See <https://nitro.build/deploy/runtimes/bun>.

## Target architecture

```text
home config policy overrides
           |
           v
pure source definitions ---- startup/explicit detection
           |                         |
           v                         v
Effect control plane: bounded queue + one worker + delayed re-enqueue timers
           |
           +---- SourceJob --------------------+
           |                                   v
           |                         in-process Effect adapter
           |                         detect/run/import transaction
           |                                   |
           |                                   v
           |                       usage rows / quotas / datasets
           |                                   |
           +---- dependency/enrichment jobs <--+
           |
           +---- deduped ReportPublication job
                                               |
                                               v
                                  stored-only report assembly
                                               |
                                               v
                                 immutable served report revision

SubscriptionRef<SourceControlState>
           |
           v
bounded full-snapshot SSE -> root SourceControlClient -> hover + /sources

finite HTTP reads/mutations -> TanStack Query
exact report revision reads -> servedReportSession
```

The Nitro server runs on Bun and hosts the Effect scheduler, source adapters, `bun:sqlite` stores, and stored-only report publication in one process. Adapters report bounded sanitized progress directly through the control-plane service. Preserve immutable private report artifacts and exact-revision ownership, but do not preserve subprocesses whose only purpose was bridging a Node host to Bun APIs.

Use these Effect 3 primitives unless implementation evidence proves one unsuitable:

- `Queue.bounded<ControlPlaneJob>` for execution;
- `SubscriptionRef<SourceControlState>` for atomic current state plus change subscriptions;
- `FiberMap<CollectionSourceId>` for at most one delayed re-enqueue timer per source;
- `Layer.scoped` and `ManagedRuntime` for acquisition and shutdown;
- `Effect.sleep` for completion-relative delayed enqueueing.

Do not use `Schedule.fixed`: its catch-up behavior does not match “run again one cadence after completion.” The queue cannot remove an arbitrary queued item, so every source job carries a `policyRevision`; the worker revalidates policy and availability when taking the job and consumes stale jobs as bounded skips.

## Configuration contract

Add sparse user overrides to `~/.config/ai-usage/config.json`:

```json
{
  "sourcePolicies": {
    "codex.sessions": { "enabled": false }
  }
}
```

Each hardcoded source definition supplies `defaultEnabled: true`. Effective policy is:

```ts
override?.enabled ?? definition.defaultEnabled
```

Persist only explicit overrides. Resetting a source to its default removes its sparse override. Write through the existing owner-only, locked, atomic configuration mutation path. Extend parsing so source policies are accepted only from the home configuration; encountering `sourcePolicies` in repository-local `ai-usage.config.ts` must produce a clear validation error instead of letting project code control the user's background services.

## Queue, dependency, and publication semantics

1. On startup, detect every registered source regardless of policy.
2. Queue every enabled and detected source exactly once.
3. Also queue one bootstrap report publication behind the initial work so an existing durable store becomes available after a process restart even if all source runs are semantic no-ops.
4. Re-enqueue a source one cadence after its run completes, provided it is still enabled and detected.
5. If a run reports unavailable input, mark the source dormant and do not re-enqueue it before explicit detection.
6. A manual `Run now` queues immediately when possible and replaces the pending delayed cadence. It does not duplicate queued/running work.
7. `Run all enabled` applies the same rule to every enabled and detected source.
8. Disabling increments the policy revision, cancels only that source's delayed timer, and leaves already running work alone. Stale queued work is consumed and skipped.
9. Enabling an already detected source queues it immediately.
10. Session producers that changed durable rows schedule `rtk.savings` when RTK is enabled/detected, then schedule publication after enrichment. If RTK is disabled/dormant, publish directly.
11. Changed quota or dataset sources schedule publication directly.
12. Publication is a deduped queue job, never a direct collector callback.
13. With the default single worker, initial jobs naturally coalesce into a tail publication. Still use durable generation/watermark or dirty-flag checks so an internally configured multi-worker test cannot publish stale data or lose a producer change that arrives while an enricher runs.
14. Each source import is its own transaction. One source failure must not block successful sources or destroy its last good data.
15. Publication reads the complete durable projection, reconciles it, and publishes an immutable revision. It performs no detection, collection, provider call, or raw history read.
16. Preserve plan 017's semantic generation and plan 018's same-revision/no-op guarantees: unchanged touches do not advance report generation or republish a revision.

## Persistence changes

Keep usage rows and provider quota observations in their current durable stores. Add a versioned normalized dataset-item store to `usage-store.sqlite` for data such as Cursor commit attribution that is currently queried live during report assembly.

A suitable shape is:

```text
collected_dataset_items
  source_id
  machine_id
  dataset_key
  schema_version
  item_key
  payload_json
  first_seen_at
  last_seen_at
  updated_at
```

Requirements:

- derive a deterministic stable Cursor attribution identity, such as a validated composite of commit hash and branch name or a documented stable hash;
- validate payloads strictly at both write and read boundaries;
- isolate corrupt stored items instead of losing the whole report;
- upsert observed items and never delete absent items;
- distinguish unchanged observation touches from semantic insert/update;
- advance the relevant durable generation only when the report projection changes;
- keep migrations additive and owner-only;
- add no “replace latest snapshot” API whose empty input could erase history.

RTK becomes an autonomous enricher over stored normalized rows plus its own database. Preserve its current global best-match behavior across eligible rows. It updates only newly changed enrichments transactionally and never clears existing savings because its source is disabled, unavailable, or empty. Do not mutate harness raw files or shared in-memory collector objects.

## CLI contract

The CLI shares pure definitions, policy resolution, adapters, persistence, and result contracts, but it does not start the long-lived scheduler or SSE runtime.

- A normal `report` or snapshot command runs the necessary enabled local sources once, then assembles from durable storage.
- A normal report must not start Codex app-server or perform provider communication. The specialized quota command selects `codex.usage-limits` explicitly.
- `--no-cursor` remains an ephemeral command selection/exclusion; it does not persist policy.
- A policy-disabled source is skipped, but its historical stored data remains eligible for an ordinary report.
- A specialized command targeting a disabled source reports that the source is paused instead of silently overriding policy.
- Keep one-shot execution in Bun so the CLI and server use the same adapter implementations and storage semantics.

## SSE and client contract

Create one root-owned `SourceControlClient` after hydration. It opens one `EventSource`, retains the latest bounded `SourceControlView`, and feeds both the compact header control and `/sources`.

The endpoint must:

- return `text/event-stream`;
- validate the local request explicitly before opening the stream;
- send `retry`, an initial full current snapshot, then full replacement snapshots;
- use an event ID containing a per-process instance UUID and monotonic in-process generation;
- send heartbeat comments to keep intermediaries from treating an idle healthy stream as dead;
- coalesce or bound slow-client updates rather than accumulating an unbounded queue;
- remove subscriptions and close resources on request abort and server shutdown;
- reconnect statelessly by sending the current snapshot, with no durable replay log;
- emit a small `report-published` event containing only immutable revision metadata needed to trigger acquisition;
- never stream report rows, raw collector payloads, private paths, prompts, invalid records, or secrets.

Use HTTP POST/server functions for `toggle`, `run source`, `run all`, and `detect again`. Validate IDs and bodies at the boundary, enforce local trust/CSRF protections, wait for the server-side state transition, and let SSE broadcast the authoritative result. Do not optimistically invent server lifecycle state in the client.

## UI contract

Replace the current refresh/timer control with a compact source summary and adjacent explicit `Run all` action. Example collapsed label:

```text
Sources · 4 healthy · 1 dormant
```

Its keyboard- and pointer-accessible hover/focus card must show enough truthful detail without claiming a single global countdown:

```text
Collection scheduler
Running Claude sessions · 1.2s
Queued OpenCode, RTK
Codex sessions · Last success 38s ago · due in 22s
Usage limits · Last success 3m ago · due in 2m
Cursor · Not detected
```

Do not show `Next 42s` for the whole system: independent cadences, queue delay, running duration, and dormant sources make that misleading.

Add `/sources` near Skills and Sync. It must include:

- scheduler and queue summary;
- `Run all enabled` and `Detect sources again` actions;
- groups for Sessions, Provider usage, and Enrichments;
- one row/card per stable source with its independent toggle, availability, lifecycle, last outcome, cadence, last run, due time, counts, warnings, progress, and `Run now`;
- explicit `Pausing after current run`, `Disabled`, `Not detected`, and `Not run yet` states;
- a compact pipeline/publication view that explains when stored contributions have produced a report revision;
- loading, reconnecting, stale, and command-error states that do not erase the last server snapshot;
- semantic buttons, labels, focus management, reduced-motion support, and screen-reader announcements for material state changes.

## Client-first web conversion

Keep SSR for the shell, document metadata, navigation, and route boundaries. Remove business-data route loaders from all routes, including `/` and `/skills`.

After hydration:

- use TanStack Query for finite reads such as Skills snapshots, quota history, source command mutations, and other ordinary server projections;
- use the root `SourceControlClient` for live source state and report-publication notification;
- keep `servedReportSession` as the sole exact-revision coordinator for Overview, Breakdown, and Sessions;
- have `report-published` request acquisition of the immutable revision for the current destination, without running collection;
- render route-appropriate skeleton, error, retry, and empty states while client reads settle;
- remove the Dashboard one-minute interval, pause-on-hidden refresh behavior, and `RefreshStatus`;
- remove the client provider-quota poller and its five-minute cadence;
- invalidate/refetch finite quota-history queries after a relevant publication event;
- make project-group and Sync mutations enqueue a deduped publication job rather than starting fresh collection;
- preserve deterministic client-side demo/E2E fixtures without smuggling business data back through SSR loaders.

Generic query invalidation must never independently replace the three report destinations. If the complete client-first migration cannot preserve atomic same-revision commits, stop instead of weakening plan 018.

## Implementation sequence

### Execution log

- 2026-07-16 — Step 0 baseline: 121 collector/store/report-data tests and 75 web server/exact-revision tests passed. Existing executable specifications already cover absent-row preservation, semantic no-op generation, stored-only report assembly, and atomic exact-revision destination commits.
- 2026-07-16 — Baseline drift: `apps/web/server` does not exist on the branch. Current server modules live in `apps/web/src/server`; Nitro plugin and route directories will be introduced by Step 6/7.
- 2026-07-16 — Step 1 complete: added the seven stable source definitions and browser-safe control-plane DTOs, home-only sparse policy validation/mutation, repository-policy rejection, vocabulary, and public-interface documentation. All 146 targeted tests, package-boundary checks, Ultracite checks, workspace typechecking, and `git diff --check` passed.
- 2026-07-16 — Step 2 complete: added the additive versioned normalized dataset-item store, strict read/write validation, bounded corrupt-item isolation, semantic generation, stable Cursor attribution identity, and report-data persistence/read parity helpers. Empty imports preserve prior items. All 131 collector/store/report-data tests, workspace typechecking, package-boundary checks, and `git diff --check` passed.
- 2026-07-16 — Step 3 complete: added autonomous detection/run adapters for all seven stable sources. Session producers import their own normalized rows, RTK enriches the complete eligible stored set, Cursor attribution writes normalized dataset items, and Codex usage limits owns live/backfill substeps. Progress and warnings are bounded and sanitized. All 136 collector/report/store tests, workspace typechecking, package-boundary/export checks, and `git diff --check` passed. Aggregate collection remains only as a compatibility seam until the Step 5 CLI migration.

### Step 0 — Freeze the baseline and characterize contracts

**Files to inspect/update:**

- `CONTEXT.md`
- `docs/architecture.md`
- `docs/public-package-interfaces.md`
- `packages/local-collectors/src/collectors/index.ts`
- `packages/local-collectors/src/collected-session.ts`
- `packages/report-data/src/index.ts`
- `packages/usage-store/src/index.ts`
- `apps/web/src/server/report-payload.server.ts`
- `apps/web/src/dashboard.tsx`
- `apps/web/src/provider-quota-client.ts`
- `apps/web/src/routes/{__root,index,skills}.tsx`

Actions:

1. Re-run the existing targeted collector, store, report-data, exact-revision, quota, Dashboard, Skills, and production smoke tests before changing behavior.
2. Add characterization tests where an invariant is only implicit: absent rows are not deleted, unchanged imports do not advance semantic generation, stored report assembly makes no live source calls, and exact-revision destination commits remain atomic.
3. Record any drift from the evidence above in this plan before continuing.

Verification:

```bash
bun test packages/local-collectors packages/usage-store packages/report-data
bun test apps/web/src/server apps/web/src/*served-report-session*.test.ts apps/web/src/provider-quota-client.test.ts
```

Expected: baseline tests pass and the non-deletion/exact-revision behaviors are executable specifications.

### Step 1 — Establish vocabulary, pure contracts, and home-only policy

**Primary files:**

- `CONTEXT.md`
- `packages/report-core/src/source-control.ts` (new)
- `packages/report-core/src/project-alias.ts`
- `packages/report-core/src/*.test.ts`
- `packages/report-core/package.json`
- `packages/local-collectors/src/machine-config.ts`
- `packages/local-collectors/src/machine-config.test.ts`
- `docs/public-package-interfaces.md`

Actions:

1. Define the stable source ID union, groups, pure policy types, state axes, reason codes, progress/result DTOs, and bounded browser-safe `SourceControlView` in a dependency-neutral package seam. Include hardcoded labels, groups, default-enabled policy, and default cadence so clients do not import runtime adapters merely to render control-plane state.
2. Add `sourcePolicies` to the user configuration schema with sparse overrides and strict stable-ID validation.
3. Split home/repository config parsing so only the home file may contain policy. Preserve the existing merge behavior for unrelated project aliases.
4. Add locked atomic mutation helpers to set/remove an override without rewriting unrelated user config.
5. Add the `Collection source` vocabulary and clarify its distinction from `Harness`.
6. Document the new public subpath and prove its browser-safe DTO subpath has no server-runtime import graph.

Verification:

```bash
bun test packages/report-core packages/local-collectors/src/machine-config.test.ts
bun tools/check-package-boundaries.ts
```

Expected: default resolution, sparse persistence, reset-to-default, concurrent mutation, invalid IDs, repository-policy rejection, and private-mode preservation all pass.

### Step 2 — Add non-destructive normalized dataset persistence

**Primary files:**

- `packages/usage-store/src/index.ts`
- `packages/usage-store/src/index.test.ts`
- `packages/usage-store/README.md`
- `packages/local-collectors/src/datasets.ts`
- `packages/local-collectors/src/datasets.test.ts`
- `packages/report-data/src/index.ts`
- Cursor attribution tests under `packages/local-collectors` and `packages/report-data`

Actions:

1. Add the versioned `collected_dataset_items` schema and strict APIs for semantic upsert and bounded read.
2. Define and test stable Cursor commit-attribution item identity.
3. Move Cursor attribution persistence behind normalized dataset items without deleting the legacy live read until parity is proven.
4. Test zero-item, partial, duplicate, unchanged, updated, corrupt, and concurrent imports.
5. Make generation changes semantic and transactional.

Verification:

```bash
bun test packages/usage-store packages/local-collectors packages/report-data
```

Expected: Cursor attribution round-trips through storage, empty/failed runs preserve prior items, corrupt items are isolated, and unchanged observations do not advance generation.

### Step 3 — Turn collectors and enrichers into autonomous adapters

**Primary files:**

- `packages/local-collectors/src/collectors/{claude,codex,cursor,opencode,index}.ts`
- `packages/local-collectors/src/{collected-session,rtk-enrichment,facets,datasets}.ts`
- corresponding `packages/local-collectors/src/**/*.test.ts`
- `packages/report-data/src/source-adapters.ts` (new, Bun runtime adapters)
- `packages/report-data/src/provider-quota.ts`
- `packages/report-data/package.json`

Actions:

1. Extract one adapter for every stable source ID and keep detection separate from running.
2. Make session adapters normalize and transactionally upsert their own rows instead of returning one global concatenated array to an orchestrator.
3. Make RTK read eligible stored normalized rows and transactionally upsert changed enrichment while preserving global best-match behavior.
4. Make Cursor commit attribution normalize and upsert dataset items.
5. Put live Codex app-server collection and rollout backfill behind one adapter and one toggle, while retaining substep warnings/counts.
6. Report sanitized bounded progress through `SourceRunContext`; raw rows, datasets, paths, and provider responses never enter control-plane state.
7. Remove global RTK application and global collector concatenation only after adapter parity tests pass.

Verification:

```bash
bun test packages/local-collectors packages/report-data packages/usage-store
```

Expected: each adapter can be detected/run independently in the Bun process, writes only its owned normalized contribution, produces bounded operational state, and never deletes absent data.

### Step 4 — Build the Effect control-plane application

**Primary files:**

- `packages/report-data/src/source-control.ts` (new)
- `packages/report-data/src/source-control.test.ts` (new)
- `packages/report-data/src/index.ts`
- `packages/report-data/package.json`

Actions:

1. Build a deep `SourceControl` application interface around the bounded queue, `SubscriptionRef`, `FiberMap`, scoped fibers, clock, policy store, scheduled-source registry, and publication port.
2. Implement startup detection, immediate initial queueing, bootstrap publication, completion-relative scheduling, manual commands, policy revision checks, and graceful shutdown.
3. Deduplicate queued/running sources and publication jobs.
4. Track sanitized per-source axes, timing, counts, warnings, progress, and stable reasons atomically.
5. Implement producer-to-RTK-to-publication dependencies and dirty/watermark logic robust to a test-only worker count greater than one.
6. Use `TestClock` and in-memory ports for deterministic tests; do not sleep in unit tests.
7. Prove disabling a running source does not interrupt it and that its future job is skipped.

Verification:

```bash
bun test packages/report-data/src/source-control.test.ts
bun run typecheck
```

Expected: deterministic tests cover startup, cadence, manual runs, dedupe, disable/enable races, stale jobs, unavailable transitions, failure cadence, dependency ordering, publication coalescing, multi-worker watermark behavior, and scoped shutdown.

### Step 5 — Separate one-shot CLI collection from stored-only publication

**Primary files:**

- `apps/cli/src/{main,cli,runtime,report,quota,snapshot-file}.ts`
- corresponding CLI tests
- `packages/report-data/src/index.ts`
- `packages/report-data/src/report-payload-artifact.ts`
- `packages/report-data/src/provider-quota.ts`
- report-data tests

Actions:

1. Add a Bun in-process one-shot source executor that shares adapter and policy semantics without starting timers.
2. Route normal report/snapshot collection through selected enabled local sources, excluding provider communication.
3. Route the quota command explicitly through `codex.usage-limits` and report a paused policy clearly.
4. Preserve `--no-cursor` as an ephemeral filter.
5. Split collection/import from pure stored report publication. Delete live Cursor attribution/provider reads from publication once persisted parity passes.
6. Preserve historical disabled-source data in ordinary reports.

Verification:

```bash
bun test apps/cli packages/report-data
bun run test
```

Expected: one-shot commands honor policy and selections, normal report never calls Codex app-server, disabled history remains visible, and stored publication performs no collection.

### Step 6 — Migrate Nitro to Bun and host the control plane in-process

**Primary files:**

- `apps/web/src/server/source-control.server.ts` (new)
- `apps/web/src/server/source-control.server.test.ts` (new)
- `apps/web/src/server/report-payload.server.ts`
- `apps/web/src/server/provider-quota.server.ts`
- `apps/web/server/plugins/source-control.ts` (new)
- `apps/web/vite.config.ts`
- `apps/web/package.json`
- `apps/web/start.mjs`
- `tools/check-web-production-start.ts`
- production lifecycle tests

Actions:

1. Change Nitro from `node-server` to the official `bun` preset and run the production entry through the pinned Bun runtime. Keep `start.mjs`'s forced loopback binding rather than replacing it with an unsafe direct command.
2. Extend the production smoke so it proves the generated Bun preset starts under the pinned Bun version, rejects non-loopback access, and releases the port and scheduler on `SIGTERM`.
3. Install exactly one scoped `ManagedRuntime` per Nitro process and dispose it on server close.
4. Instantiate the shared Bun source adapters and `bun:sqlite` stores directly in that runtime. Propagate cancellation, timeout, and sanitized progress through Effect rather than a child protocol.
5. Refactor stored-only report publication to execute in the Bun host while preserving immutable owner-only artifacts, revision leases, fingerprints, and atomic publication. Remove a subprocess only when tests prove it existed solely for Node/Bun compatibility.
6. Remove aggregate refresh-promise ownership and provider-specific scheduling from web server modules.
7. Enqueue publication after relevant Sync/project-group mutations rather than collecting inline.
8. Test startup/close idempotence, scoped fiber interruption, timeout, SQLite closure, publication parity, and operation without a browser.

Verification:

```bash
bun test apps/web/src/server
bun run test:web-production
bun run test:e2e-production
```

Expected: production uses Nitro's Bun preset, source work and SQLite access run directly under the scoped Effect runtime without a browser, shutdown releases all resources, and publication remains exact and stored-only.

### Step 7 — Expose trusted commands and a resilient SSE snapshot stream

**Primary files:**

- `apps/web/src/server/source-control-api.server.ts` (new)
- `apps/web/src/server/source-control-api.server.test.ts` (new)
- `apps/web/server/routes/api/source-control.get.ts` (new SSE route)
- `apps/web/src/server/local-request-trust.server.ts`
- `apps/web/src/server/report-payload.ts`

Actions:

1. Add source snapshot/read and validated command application seams.
2. Add the SSE route with local trust validation, initial snapshot, bounded replacement updates, retry, heartbeat, per-process IDs, abort cleanup, and report publication notification.
3. Add POST/server-function commands for toggle, run one, run all, and detect all.
4. Return stable bounded errors; keep raw adapter/provider/config errors server-side.
5. Test unauthorized origin/host/fetch metadata, disconnect cleanup, slow consumers, reconnect after generation reset, and command/SSE convergence.

Verification:

```bash
bun test apps/web/src/server/source-control-api.server.test.ts apps/web/src/server/local-request-trust.server.test.ts
bun run typecheck
```

Expected: the stream always begins with authoritative current state, cannot grow memory per slow client, closes cleanly, and commands become visible through the same server snapshot.

### Step 8 — Add the root client, compact control, and `/sources`

**Primary files:**

- `apps/web/src/source-control-client.ts` (new)
- `apps/web/src/source-control-client.test.ts` (new)
- `apps/web/src/source-control-context.tsx` (new)
- `apps/web/src/components/source-control-summary.tsx` (new)
- `apps/web/src/routes/sources.tsx` (new)
- `apps/web/src/routes/__root.tsx`
- navigation/layout/design-system files used by Skills and Sync
- `apps/web/src/dashboard.tsx`
- `apps/web/src/refresh-status.tsx` and tests, if currently separate

Actions:

1. Create one hydration-only root client with replacement snapshot semantics, reconnect/stale state, and test injection.
2. Build the accessible compact summary/hover card and explicit `Run all` action in the former refresh location.
3. Build `/sources` from the agreed state axes and commands.
4. Use server-confirmed command state; disable conflicting controls while a command is pending without fabricating lifecycle transitions.
5. Remove the global one-minute countdown and refresh UI after parity.
6. Add responsive, keyboard, screen-reader, reduced-motion, reconnect, warning, and long-label tests.

Verification:

```bash
bun test apps/web/src/source-control-client.test.ts apps/web/src/**/*source-control*.test.ts
bun run test:e2e
```

Expected: one SSE connection serves both surfaces, all sources remain independent, controls are accessible, and no global countdown claims false precision.

### Step 9 — Complete the client-first business-data migration

**Primary files:**

- `apps/web/src/routes/{index,skills,sync}.tsx`
- other routes with business-data loaders discovered by `rg 'loader|createAsync' apps/web/src/routes`
- `apps/web/src/dashboard.tsx`
- `apps/web/src/provider-quota-client.ts`
- `apps/web/src/served-report-session.ts`
- `apps/web/src/dashboard-served-report-session.ts`
- `apps/web/src/focused-report-client.ts`
- Skills query/controller tests
- dashboard and production E2E tests

Actions:

1. Inventory and remove every business-data route loader; retain only shell/routing SSR concerns.
2. Add finite client queries with explicit loading/error/empty states, including Skills.
3. Wire `report-published` into exact-revision acquisition for the current dashboard destination without generic per-view replacement.
4. Remove Dashboard collection timers/visibility pause state and the provider quota poller.
5. Make quota-history and other ordinary projections respond through bounded query invalidation.
6. Preserve URL navigation, focused views, exact-revision atomicity, mutations, and deterministic demo fixtures.
7. Add a production test asserting initial HTML contains the shell but no embedded business payload, then hydrates and loads successfully.

Verification:

```bash
bun test apps/web
bun run test:e2e
bun run test:e2e-production
bun run test:web-production
```

Expected: no route SSR loader fetches business data, all routes recover from client read errors, and report destinations never commit mixed revisions.

### Step 10 — Delete superseded orchestration and reconcile documentation

**Primary files:**

- obsolete refresh/provider poller/orchestrator modules discovered during the migration
- `README.md`
- `CONTEXT.md`
- `docs/architecture.md`
- `docs/public-package-interfaces.md`
- package READMEs and exports
- `tools/check-package-boundaries.ts` and tests if the public graph changes
- `plans/README.md`

Actions:

1. Delete old global collect-all, report-refresh timer, client quota poller, live dataset assembly, and unused compatibility code only after replacement coverage passes.
2. Search for stale one-minute refresh, five-minute visible-tab quota poll, live report collection, and ambiguous “source” claims.
3. Document the source catalogue, home-only policy, queue semantics, Nitro Bun runtime, in-process Effect adapters, durable contributions, stored-only publication, SSE snapshot protocol, client-first routes, and non-deletion invariant.
4. Update public exports and package-boundary expectations.
5. Mark this plan `DONE` only after all final gates pass and the old orchestration is absent.

Verification:

```bash
rg -n "REFRESH_INTERVAL_MS|RefreshStatus|providerQuotaPoller|runReportPayloadCollection|collectReportDatasets" apps packages docs README.md
bun x ultracite fix
bun run check
bun run typecheck
bun run test
bun run lint
bun run build
bun run test:e2e
bun run test:e2e-production
bun run test:web-production
git diff --check
```

Expected: searches contain only intentional historical/test wording, every repository gate passes, formatting is clean, and docs describe the implemented system rather than the removed timer model.

## Test matrix

At minimum, preserve these cases across unit, integration, and E2E coverage:

| Area | Required cases |
| --- | --- |
| Policy | default enabled, sparse disable, reset, repo rejection, concurrent writes, restart retention |
| Detection | all sources checked while disabled, partial Codex capability, missing input, misconfiguration, explicit redetection, disappearing input during run |
| Queue | initial enqueue, completion-relative cadence, dedupe, manual priority, stale policy revision, one worker, test multi-worker, shutdown |
| Toggle race | queued disable, running disable completes, enable queues immediately, disabled manual run rejected |
| Failure | normal-cadence retry, sanitized reason, last data retained, other sources continue and publish |
| Producers | per-source normalization, transactional upsert, zero rows, duplicates, unchanged generation, no cross-source delete |
| RTK | global best match, dependency ordering, rerun after producer changes, disabled preservation, concurrent dirty watermark |
| Cursor attribution | stable identity, version validation, empty preservation, corrupt item isolation, stored report parity |
| Codex usage | live only, backfill only, partial warning, quota command, no provider call from normal report |
| Publication | bootstrap after restart, dedupe, stored-only, exact revision, no-op skip, mutation-triggered publish |
| Bun runtime | official preset, pinned version, loopback binding, direct SQLite access, timeout, scoped shutdown, no row/path leakage |
| SSE | trusted request, initial snapshot, replacement, heartbeat, slow client, reconnect/new instance, cleanup, bounded payload |
| UI | summary truthfulness, independent toggles, dormant/disabled/pausing states, keyboard/focus, stale/reconnect, command errors |
| Client-first | no business payload in SSR HTML, hydration read, route loading/error, Skills parity, fixture mode, exact-revision atomicity |
| Non-deletion | disable, unavailable, empty, failure, redetection, restart, and policy reset all preserve prior contributions |

## Performance and observability requirements

- Keep queue capacity proportional to the finite source/job catalogue; never use an unbounded queue.
- Keep one delayed timer per source and one runtime per Nitro process.
- Coalesce source-state changes for SSE and cap serialized snapshot size.
- Bound progress frequency, message length, run duration, retained warnings, and shutdown grace.
- Do not copy full usage rows into control-plane state or SSE.
- Measure event-loop/request latency during the heaviest adapters and report assembly. Add a production integration watchdog that exercises representative bounded data and fails if a nominal 250 ms event-loop probe is delayed by more than one second; direct in-process execution is acceptable only while that gate passes.
- Keep reason codes stable and messages bounded so the UI can explain failures without parsing logs.
- Measure source duration, queue delay, input/output counts, changed/no-op, publication duration, and last success in server state; do not add a remote telemetry dependency.
- Preserve semantic no-op publication so a one-minute source cadence does not force a one-minute full report rebuild.

## Security and privacy review

Before completion, explicitly verify:

- home config, SQLite state, and temporary report artifacts remain owner-only;
- repository config cannot enable background collectors or provider calls;
- source runner arguments and environment do not expose secrets in process listings or logs;
- adapter progress and SSE DTOs reject raw paths, prompts, source records, access tokens, app-server responses, and unbounded error text;
- all command and SSE routes use local request trust and mutation CSRF controls;
- stable source IDs are validated before queue lookup or process spawning;
- no user-controlled value becomes an executable path/argument without a fixed allowlist;
- corrupted durable dataset items are isolated and reported without leaking their payload;
- disabling a source is not presented as deletion and never calls a delete API.

## STOP conditions

Stop implementation, preserve the worktree, and ask for a decision if any of these occurs:

1. Nitro's `bun` preset cannot build or run the current TanStack Start application under the repository's pinned Bun version, or cannot provide a reliable process close hook. This design assumes one long-lived Bun process and must not fall back silently to Node or independent serverless instances.
2. Measured in-process collector, SQLite, enrichment, or report work blocks HTTP/SSE responsiveness beyond the agreed test budget or cannot be interrupted safely. Stop and design measured worker isolation instead of reinstating a generic subprocess boundary by assumption.
3. A per-source import or dataset migration appears to require deleting records absent from the latest run.
4. A stable identity for Cursor commit attribution cannot be derived without conflating distinct facts.
5. Source policy can still be overridden by repository-local config after the parser split.
6. The SSE endpoint cannot apply local trust checks, bound slow-client memory, or reliably unsubscribe on abort.
7. Client-first report loading would weaken exact-revision atomicity or allow Overview, Breakdown, and Sessions to commit different revisions.
8. A normal report/snapshot path would invoke Codex app-server or other provider communication.
9. Progress or error reporting would require exposing raw paths, prompts, records, credentials, or provider responses to the browser.
10. Durable generation/publication logic can lose a producer change while RTK or publication is running with a worker count greater than one.
11. Existing behavior has drifted enough that the named ownership seams no longer exist; update this plan before choosing replacement files.
12. Any migration or cleanup needs a destructive command, destructive schema reset, or deletion of user data.
13. The same relevant verification failure persists after two evidence-driven fix attempts; report the failure and logs instead of broad speculative edits.

## Commit strategy

Commit each verified step separately with imperative messages matching repository style. Suggested sequence:

1. `Define collection source contracts and policy`
2. `Persist normalized dataset contributions`
3. `Make collection sources autonomous`
4. `Add the Effect source control plane`
5. `Separate one-shot collection from publication`
6. `Run Nitro and source scheduling on Bun`
7. `Stream source control state over SSE`
8. `Add the sources workspace`
9. `Move web business data to the client`
10. `Remove legacy refresh orchestration`
11. `Document the source control architecture`

Do not push the branch or open a pull request unless explicitly requested.

## Done criteria

This plan is complete only when:

- all seven business sources are independently detected, toggled, scheduled, run, and represented;
- only home-level sparse policy overrides persist across restarts;
- the server runs collection without any browser and does not persist ephemeral runtime state;
- disabling, missing inputs, empty runs, failures, and restarts never delete historical data;
- each adapter owns normalized durable output, including RTK and Cursor attribution;
- report publication reads only durable normalized stores and preserves semantic no-op/exact-revision behavior;
- Nitro production uses the official Bun preset and hosts the scoped Effect scheduler and adapters directly;
- one resilient SSE connection supplies sanitized server state to the compact control and `/sources`;
- the old global refresh timer/button and client quota poller are gone;
- every route obtains business data after hydration while SSR still provides the shell;
- normal CLI reports make no provider call and one-shot CLI commands share source policy/adapter semantics;
- all targeted, full, E2E, production, boundary, formatting, type, lint, and build gates pass;
- architecture, vocabulary, public interfaces, configuration, operations, privacy, and non-deletion behavior are documented.
