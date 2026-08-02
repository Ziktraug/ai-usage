# Plan 066: Split the usage engine from the web and CLI runtimes

> **Status: DONE.** Implemented and verified on 2026-07-31. Every command in
> this plan passed, the five-minute isolated I/O trace met all eight acceptance
> fields, and the retired-symbol/sole-writer searches found no forbidden
> production path.

> **Executor instructions**: This is an intentional big-bang architecture
> replacement, not a compatibility migration. Read the whole plan before
> changing code. Complete and verify each wave before moving to the next one,
> but do not ship a state where both the old web/CLI writers and the new engine
> can run. If a STOP condition occurs, stop and report instead of adding a
> second data API, dual writes, or another temporary revision format. When done,
> update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat f4f9650..HEAD -- package.json turbo.json apps/cli apps/web/package.json apps/web/start.mjs apps/web/vite.config.ts apps/web/server/plugins/source-control.ts apps/web/server/routes/api/source-control.get.ts apps/web/server/routes/api/source-control.post.ts apps/web/src/server packages/report-data packages/usage-store tools/check-package-boundaries.ts tools/run-web-demo.ts docs/architecture.md docs/public-package-interfaces.md docs/adr`
> Re-read every changed ownership, publication, SQLite, process-lifecycle, or
> package-boundary seam named below. A semantic mismatch with the locked
> decisions is a STOP; update this plan before implementation rather than
> guessing.

## Status

- **Priority**: P0
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: plans 022-024, 043-044
- **Category**: architecture, correctness, performance
- **Planned at**: commit `f4f9650`, 2026-07-29
- **Working branch**: `plan/usage-engine-runtime-split`

## Why this matters

The served app currently makes one hot-reloadable web process responsible for
four unrelated lifetimes: HTTP/SSR, source scheduling, SQLite writes, and
immutable report-revision files. The CLI separately repeats collection and
write workflows. That ownership is both expensive and unsafe:

- A measured dev server wrote 104 MB from the Vite process in one 10-second
  sample while the block device reported 122 MB. Other samples observed
  239-394 MB written in 10 seconds.
- That Vite process was approximately 2.1 GiB RSS and retained 120 descriptors
  for deleted `.output` files after a build ran concurrently. The current web
  build script explicitly executes `rm -rf dist .output` while development also
  uses Nitro output there.
- `/tmp` contained 433 orphan
  `ai-usage-session-query-lease-*` directories totaling 10,527,956,992 bytes
  (about 9.8 GiB). A recent lease was about 45 MB.
- `createValidatedSessionQuerySnapshotDirectory` in
  `apps/web/src/server/report-revision.server.ts` creates a private temporary
  directory, copies the Session SQLite artifact in 64 KiB chunks, syncs it, and
  relies on registry disposal for cleanup. HMR, crashes, and killed processes
  outlive that cleanup.
- `apps/web/server/plugins/source-control.ts` starts the Effect scheduler in
  Nitro, and `apps/cli/src/main.ts` still invokes one-shot collection paths
  directly. There is no enforceable single-writer boundary.

Separating processes alone would only move these bugs. The replacement must
also remove per-revision database copies, isolate build outputs from dev
outputs, and make one process the only durable-data writer.

## Decisions locked

| Concern | Decision |
| --- | --- |
| Runtime boundary | Add a lightweight Bun `apps/usage-engine` process. It owns collection, enrichment, source scheduling, publication, usage-related config mutations, store migrations, checkpoints, retention, and every SQLite write. |
| Data plane | Web and CLI query the durable SQLite database directly. There is no report/session/quota data API in the engine. |
| Reader safety | Reader connections open existing files read-only, set `PRAGMA query_only = ON`, use a finite busy timeout, validate schema compatibility, and keep transactions bounded and short. |
| Served revisions | Replace immutable JSON/SQLite artifact directories with append-only, revision-keyed served projection tables in the durable database. The engine inserts a complete revision and advances the current pointer in one transaction. |
| Exact-revision semantics | Every report manifest and focused query names one opaque revision. A query either reads that complete revision or returns the existing typed unavailable/expired result. It never falls through to current data. The current complete revision remains readable after its TTL while it is still current so engine downtime does not erase the last compatible publication; once superseded, its expiry is enforced normally. |
| Control plane | Use a minimal authenticated loopback HTTP control plane: bounded JSON commands/status plus bounded SSE events. It carries no report rows, pages, details, quota history, or other read-model payloads. |
| Discovery and trust | The engine binds only numeric `127.0.0.1` on an ephemeral or explicitly configured port. It atomically publishes an owner-only rendezvous file containing protocol version, instance identity, port, and a random bearer token. |
| Writer exclusion | A separate owner-only engine lock at `<canonical-database-path>.engine.lock` permits one durable writer for that SQLite store. The canonical identity is the real existing database path, or the real parent plus basename before first creation; the independently configurable state/rendezvous directory never scopes writer exclusion. Lock metadata binds the database identity and publishing state directory so stale recovery can revalidate PID/process identity and rendezvous ownership; it never blindly deletes a live lock. |
| CLI without daemon | Read-only CLI commands can read the last published revision without an engine. Commands requiring fresh collection or mutation connect to the daemon or start the same engine runtime in bounded foreground one-shot mode, acquire the writer lock, complete, and exit. CLI code never writes SQLite directly. |
| Web without engine | Web may serve the last compatible published revision read-only and show control status as unavailable. The standard dev/production supervisor starts both processes, but data reads do not depend on engine uptime. |
| Demo | Demo remains synthetic and isolated. It starts neither a real engine nor a durable reader, sends no control request, and cannot inspect local histories/config/database. |
| Rollout | One cutover, with no dual write, legacy fallback, compatibility source scheduler, or long-lived feature flag. Intermediate commits must not be released. |
| Build/dev outputs | Nitro/Vite development and production builds use different output directories. A build must not delete or rewrite the active dev directory, and concurrent production builds fail fast behind a narrow lock. |
| Observability | Source, enrichment, publication, migration, retention, and engine-command wide events use surface `engine`. Web keeps HTTP/SSR/read-query events; CLI keeps command/render events. Do not emit duplicate source-completion events in clients. |

The control plane is an API, but only for commands and process state. This is
deliberately different from routing application reads through an engine API:

```text
collectors ──> usage engine ──write──> usage-store.sqlite (WAL)
                    ▲                         │
                    │ control only            ├──read-only──> web
                    └──── web / CLI            └──read-only──> CLI
```

## Current state

- `apps/web/server/plugins/source-control.ts:7-134` creates and starts source
  control during Nitro plugin startup, owns signal/HMR disposal, and publishes
  stored report revisions from the web process.
- `apps/web/src/server/web-process-runtime.server.ts:5-89` exposes Effect
  execution and source-control capabilities through a process-global registry.
  `apps/web/src/server/source-control.server.ts:89-132` backs those ports with a
  `ManagedRuntime`.
- `packages/report-data/src/source-control.ts:60-105` defines the policy,
  publication, and source-control services; its bounded queue, timers, source
  state, cancellation, and publication semantics are the correct domain core.
  Their host is wrong, not those invariants.
- `packages/report-data/src/source-adapters.ts:33-40,216-269` imports and enriches
  rows by calling write-capable `@ai-usage/usage-store` functions directly.
- `packages/usage-store/src/index.ts:714-858` owns schema creation and migration.
  Every ordinary open currently prepares the file, enables WAL, runs migrations,
  and may checkpoint with `TRUNCATE` at `:1033-1047`; there is no read-only
  application facade.
- `apps/web/src/server/report-payload.server.ts:52-65,140-201` keeps a
  process-global file revision registry and publishes captures from web memory.
  `apps/web/src/server/revision-query-runner.server.ts:137-165` leases a copied
  Session SQLite artifact and starts a bounded Bun subprocess for each exact
  query.
- `apps/cli/src/main.ts:88-211` runs one-shot quota/session collection, Cursor
  import, merge/report assembly, and machine-config writes in the CLI process.
- `apps/web/package.json` removes `dist .output` during build.
  `apps/web/vite.config.ts` does not separate dev/build Nitro output, and the
  watcher ignores only generated design-system files.
- `tools/check-package-boundaries.ts:39-120` currently forbids the CLI from
  importing usage-store and describes report-data as its durable-data gateway.
  It does not express a sole-writer or engine dependency direction.

Preserve these already-accepted guarantees while changing their owner:

- seven source IDs, bounded queue depth, default one worker, independent source
  cadence/policies, lossless deduplicated publication demand, progress bounds,
  cancellation, and non-destructive disable/failure behavior from plans 022-024;
- semantic store generations and unchanged-capture publication skipping from
  plan 017;
- browser-side exact-revision retry, same-revision no-op, and supersession
  behavior from plan 018; expiry applies to superseded revisions, while the
  current complete revision remains readable until replacement;
- the one exact-revision execute/parse/validate lifecycle from plan 044, with
  its transport changed from copied artifact subprocesses to direct read-only
  SQLite;
- demo privacy, loopback-only listeners, private local state, transfer bounds,
  and wide-event allowlists from plans 011-015, 028, and 036-037.

## Target package and process ownership

Create these two units:

- `apps/usage-engine`: Bun composition root, writer lock, lifecycle, signals,
  control server, scheduled/foreground modes, startup recovery, and readiness.
- `packages/usage-engine-control`: transport-neutral command/status/event
  contracts plus the loopback client, rendezvous validation, authentication,
  request budgets, timeout/error mapping, and in-memory test adapter. It must
  not import collectors, report-data, usage-store, web, or CLI.

Move write-side orchestration from report-data into a deep
`packages/usage-engine-runtime` package: source-control runtime/state and source
adapters; provider-quota refresh and write-side history runner; RTK and known-
project enrichment writers; stored report publication; merge preview/
confirmation/import; and usage-related config mutations.

Keep pure report assembly and read workflows in `packages/report-data`. Split
usage-store into explicit package subpaths:

- `@ai-usage/usage-store/reader`: compatible-schema inspection and bounded
  read-only queries only;
- `@ai-usage/usage-store/writer`: migrations, imports, enrichment, publication,
  retention, checkpoints, and merge writes; imported only by
  `usage-engine-runtime`;
- `@ai-usage/usage-store/testing`: temporary-store helpers used by tests, never
  production application code.

Do not keep the current root export as a mixed reader/writer facade. Update
package-boundary tooling so web and CLI may import only `/reader`,
`usage-engine-runtime` may import `/writer`, and no other production package may
import `/writer`.

## Durable served-revision contract

Extend the existing store in one forward migration. Exact table/column names
may follow the repository's SQL naming conventions, but the migration must
provide these normalized concepts:

- schema/protocol metadata with one monotonically increasing store schema
  version;
- `served_report_revisions`: opaque revision, source generations, capture
  fingerprint, creation/expiry timestamps, completeness marker, and bounded
  counts/bytes;
- a singleton current-revision pointer;
- revision-keyed serialized report rows plus source authority;
- revision-keyed support/facet/machine-freshness payload;
- revision-keyed Session/focused-query columns and indexes sufficient for every
  current query kind: sessions, overview, breakdown, support,
  session-detail-anchor, neighbors, and campaign-children.

Publication uses one `BEGIN IMMEDIATE` transaction:

1. Re-read semantic generations and assemble the capture.
2. If its private fingerprint matches the current complete revision, renew
   metadata only when required and report `changed: false`.
3. Insert all new revision metadata and projection rows with the revision not
   yet visible as current.
4. Validate counts, byte budgets, foreign keys, and the query catalog.
5. Mark the revision complete and update the singleton current pointer.
6. Commit, then emit the publication event. Rollback leaves the previous pointer
   authoritative.

Readers first resolve/validate the requested revision and then execute the
bounded query in one short read transaction. Retention deletes only non-current
expired revisions and incomplete abandoned staging rows. SQLite snapshot
isolation protects a read already in progress; no filesystem lease, copied DB,
refcount, or IPC lease is introduced.

## Control-plane contract

Version the following narrow surface in `usage-engine-control`:

- `GET /v1/status`: bounded engine identity/readiness, protocol/store schema,
  source-control snapshot, current publication revision, last successful
  publication, and degraded reason.
- `POST /v1/commands`: discriminated commands for `detect-all`,
  `run-all-enabled`, `run-source`, `publish`, `set-source-enabled`, usage-related
  config mutations, fresh quota collection, machine mutation, and bounded
  merge/import workflows. Return command admission/identity, not report data.
- `GET /v1/events`: replay-safe bounded SSE snapshots/events for status, source
  progress, and publication changes. Preserve current queue, message,
  warning-code, duration, and event-size budgets.

Every request requires the rendezvous bearer token, exact protocol version,
loopback peer, method, content type, body limit, runtime parser, timeout, and
abort propagation. SSE reconnect obtains a fresh status snapshot before
incremental events. Never accept arbitrary filesystem paths from web requests.
For bounded web uploads, the web writes an owner-only no-follow staging file
under a dedicated inbox and sends an opaque server-generated handoff ID; the
engine revalidates ownership, regular-file identity, size, and inbox containment
before consuming it. CLI commands may name explicit operator-supplied files,
but the engine performs the same canonical/no-follow/budget validation.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Engine tests | `bun test apps/usage-engine packages/usage-engine-runtime packages/usage-engine-control` | all pass |
| Store tests | `bun test packages/usage-store` | reader, writer, migration, publication, retention, and concurrency cases pass |
| Report tests | `bun test packages/report-data` | all read/assembly/query cases pass |
| Web server tests | `bun test apps/web/src/server apps/web/server` | all pass with no real engine or home |
| CLI tests | `bun test apps/cli` | daemon, foreground, unavailable, and output cases pass |
| Tool tests | `bun test tools` | supervisor, boundaries, build lock, demo, and production smoke pass |
| Check | `bun run check` | Ultracite exits 0 |
| Boundaries | `bun run lint` | exit 0 |
| Types | `bun run typecheck` | all tasks pass |
| Full tests | `bun run test` | all pass |
| Build | `bun run build` | all packages and isolated web output pass |
| Web browser | `bun run test:e2e` | all pass |
| Production browser | `bun run test:e2e-production` | all pass |
| Demo privacy | `bun run test:e2e-demo` | all pass without engine/database access |
| Production lifecycle | `bun run test:web-production` | supervisor owns and stops engine + web descendants |
| Setup loopback | `bun run test:setup-loopback` | passes |
| Diff hygiene | `git diff --check` | no output, exit 0 |

Do not run tests against the maintainer's real home, config, histories, database,
logs, or `/tmp` leases. Every test/process command must receive an isolated
temporary home and explicit database/rendezvous paths.

## Scope

**In scope**:

- New `apps/usage-engine`, `packages/usage-engine-runtime`, and
  `packages/usage-engine-control` workspaces with focused tests.
- Explicit usage-store reader/writer/testing exports and a forward migration for
  revision-keyed served projections.
- Moving all collection, enrichment, publication, merge/store, source-policy,
  and machine/config write workflows behind the engine.
- Direct read-only SQLite report, session, focused, fleet, and quota queries
  from web/CLI.
- Minimal authenticated loopback control/status/SSE communication.
- Foreground CLI engine execution and standard dev/production supervision.
- Removing the web-owned ManagedRuntime, Nitro source-control plugin, file
  revision registry, Session query snapshots, leases, artifact query
  subprocesses, and their obsolete tests/tools.
- Isolating web dev/build outputs, adding a production build lock, preventing
  generated/runtime paths from triggering HMR, and regression-testing
  concurrent dev/build behavior.
- Safe startup scavenging of only ai-usage-owned legacy temporary revision/lease
  directories whose names match the exact six-character `mkdtemp` suffix
  format, after strict identity, ownership, symlink, age, and liveness checks.
- Package-boundary enforcement, architecture/public-interface documentation,
  and ADR updates that supersede only the old process/file placement.

**Out of scope**:

- Remote access, LAN listeners, cloud sync, multi-user service mode, browser
  access to SQLite, or a general plugin/collector protocol.
- A REST/GraphQL/tRPC data API for report rows, sessions, focused queries,
  quotas, or exports.
- Rewriting scheduler semantics, increasing worker concurrency, changing source
  cadence, deleting data for disabled/failed sources, or report calculations.
- Splitting the SQLite database per process, per revision, or per reader.
- Electron/Tauri packaging, OS service installation, background autostart, or
  Windows named-pipe support. Numeric loopback HTTP is the portable local seam.
- Migrating or preserving ephemeral old revision artifacts. Durable usage rows
  migrate; transient revision files are scavenged safely.
- Unrelated Skills UI/filesystem ownership. Skills remain web-owned and demo
  isolated.
- Pushing, opening a PR, deploying, or deleting the maintainer's existing
  `/tmp/ai-usage-*` data during implementation.

## Git workflow

- Implement on a separate worktree/branch derived from current `main`; this plan
  was authored in `/tmp/ai-usage-plan-usage-engine-runtime-split` on
  `plan/usage-engine-runtime-split`.
- Use reviewable wave commits even though the merged result is a big-bang
  cutover. Suggested subjects: `Add the usage engine control contract`,
  `Publish served revisions in SQLite`, `Move collection into the usage engine`,
  `Read usage data directly from SQLite`, and
  `Cut over web and CLI process ownership`.
- Never merge/release an intermediate commit with two possible writers.
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 0: Freeze evidence and stop dev/build output collisions

1. Add `docs/performance/usage-engine-io-baseline.md` with the date, exact
   commands, durations, process tree, per-process write bytes, block-device
   bytes, RSS/CPU, deleted-descriptor count, and temporary lease count/bytes.
   Record cold idle, warm idle, one collection/publication, one Sessions query,
   HMR, build without dev, and build while dev is running. Use a synthetic
   temporary home; never enumerate row content or private paths.
2. Convert `apps/web/vite.config.ts` to a command-aware config. Give Nitro dev
   and production build different explicit output directories (for example
   `.output-dev` and `.output-build`), update `apps/web/start.mjs` to load only
   the production directory, and update `turbo.json` outputs. Change build
   cleanup to remove only production build outputs.
3. Add a narrow cross-process production-build lock under the web build
   directory. It must fail fast with an actionable PID/path message, validate
   stale ownership before recovery, release in `finally`, and never target dev.
   Add active dev/build/generated runtime directories to Vite's ignored paths.
4. Add a tool regression that starts isolated dev, waits for readiness, records
   the dev PID/output inode set, runs a production build, proves the endpoint
   remains healthy and no dev output was deleted, then confirms a second
   concurrent build is rejected. Always terminate descendants.
5. Re-run the baseline. The concurrent build must produce zero deleted dev
   output descriptors and no rebuild/HMR loop. This wave fixes the independent
   `.output` bug; do not claim the engine split fixed it.

**Verify**: `bun test tools
apps/web/src/server/report-runtime-paths.server.test.ts && bun run build` passes,
then the isolated concurrent dev/build regression passes three times.

### Step 1: Establish contracts and enforce dependency direction

1. Add target workspace manifests, TypeScript configs, and specific exports.
   Define pure branded protocol version, instance, command, command result,
   status, event, and error parsers in `usage-engine-control`. Reuse source-
   control parsers; do not duplicate source IDs or limits.
2. Implement injected `UsageEngineControlClient` and in-memory test adapter
   first. Add loopback validation, private rendezvous parsing, token redaction,
   byte budgets, timeouts, aborts, retry classification, and SSE reconnect.
3. Change package-boundary tooling and tests to encode the target graph:
   control imports no runtime/data/app package; engine-runtime may import
   collectors, report-data, `/writer`, and control contracts but no app;
   usage-store imports neither engine nor apps; report-data may import only
   `/reader`; web/CLI may import control and `/reader` but never `/writer`,
   engine-runtime, adapters, or one-shot writers; only `apps/usage-engine`
   composes engine-runtime.
4. Add compile-time/public-export tests and provisionally update
   `docs/public-package-interfaces.md`. No mixed usage-store root export remains.

**Verify**: parser tests cover unknown fields, limits, version mismatch,
redaction, loopback rejection, timeout, abort, and reconnect;
`bun run lint && bun run typecheck` passes.

### Step 2: Split SQLite readers from writers and publish durable revisions

1. Refactor `packages/usage-store/src/index.ts` internally without changing
   behavior, then expose reader/writer/testing modules. Only the writer calls
   `preparePrivateStoreFile`, migrates, changes journal mode, checkpoints, or
   opens read-write. Reader opens with `create: false`, read-only, `query_only`,
   foreign keys, and finite busy timeout; it never creates/migrates.
2. Give readers typed `store-missing`, `schema-too-old`, `schema-too-new`,
   `revision-unavailable`, `revision-expired`, `busy`, and `corrupt` results.
   Test byte-for-byte that a read-only open/query leaves database, WAL, SHM,
   modification time, and schema unchanged without an external writer.
3. Add the durable served-revision schema above. Keep migration atomic and
   idempotent against a populated store. Add indexes only from
   `EXPLAIN QUERY PLAN` evidence for every current query kind.
4. Move Session/focused materialization SQL out of the web artifact assumptions
   into store writer publication. Adapt auditable query SQL to require
   `revision = ?` and run directly through reader.
5. Add APIs to insert/validate/commit a complete revision and atomically advance
   current. Retention preserves current, tolerates readers, bounds retained
   rows/bytes/revisions, and deletes abandoned incomplete revisions.
6. Add migration fixtures, rollback injection at every publication phase,
   concurrent WAL readers, expiry, unchanged renewal, corrupt-row isolation,
   cursor bounds, and a fixture at or above 5,000 sessions.

**Verify**: `bun test packages/usage-store packages/report-data/src/*query*`
passes. A fault before commit leaves the previous revision current; a reader of
revision A never observes B.

### Step 3: Build the sole-writer usage engine

1. Move source-control state/runtime, source adapters, provider quota refresh,
   known-project/RTK enrichment, and publication composition into engine-runtime.
   Preserve transition tests and invariants while renaming web surfaces.
2. Add one scoped `UsageEngineRuntime` with `start`, `status`,
   `execute(command)`, `changes`, and `dispose`. Startup acquires the lock,
   migrates, validates config, publishes a compatible initial revision, then
   begins detection/cadence.
3. Implement app modes `serve` (persistent scheduler/control), `once <command>`
   (same runtime/lock, no duplicate collector), and `check` (paths, lock,
   rendezvous, store compatibility without collection).
4. Implement atomic private lock/rendezvous files. Key the writer lock to the
   canonical durable database path, not the state/rendezvous directory, so two
   engines targeting one database always contend even when their state
   directories differ. Cover same-database/different-state and ordinary
   two-engine rejection, stale PID reuse, crash between files, token rotation,
   permission failure, non-loopback config, signals, forced cleanup, and
   idempotent disposal.
5. Route source policy, project group, machine, Cursor import, manual merge, and
   other usage-store/config mutations through engine commands. Preserve stale
   confirmation, file bounds, atomic config writes, and publication.
6. Recover incomplete revisions and legacy temp artifacts. Scavenge only exact
   legacy `mkdtemp` names with their six-character generated suffix, owned by
   current UID, below expected temp root, beyond the grace period, with no
   symlink/special file or live validated owner. A longer or otherwise free-form
   suffix is suspicious and must be preserved. Log counts and bytes only.
7. Compose engine wide events with surface `engine`, without tokens, raw paths,
   row content, or duplicate source events.

**Verify**: engine tests prove one writer, unchanged scheduler semantics,
bounded control payloads, recovery, publication atomicity, signals, and no
collection after disposal.

### Step 4: Make web a read-only app/control client

1. Replace `WebProcessRuntime` with injected `UsageReadModel` and
   `UsageEngineControlClient`. Server functions read current/exact revisions
   directly; source-control routes proxy only commands/status/events.
2. Preserve SSR bootstrap in one read transaction and browser revision retry.
   Engine unavailability must not invalidate a readable compatible revision.
3. Replace revision-query subprocess execution with direct revision-keyed
   reader while keeping one parse/execute/result-validation lifecycle and web
   read wide event. Spawn no Bun child per query.
4. Move usage mutations to control commands. For uploads, use the private
   bounded inbox handoff and delete on success, rejection, timeout, shutdown,
   and recovery. Skills remain web-owned.
5. Delete the Nitro source-control plugin, ManagedRuntime/global registries,
   file revision registry, materializer, artifact/lease helpers, artifact query
   subprocess, and obsolete HMR workaround after import tests prove no side door.
6. Keep browser source-control contracts where useful, backed by the client.
   Show disconnected/version mismatch explicitly; disable mutations while
   stored report reading continues.
7. Live uses production adapters, E2E uses in-memory adapters, and demo cannot
   load production reader/control modules.

**Verify**: web tests pass with engine available, engine stopped after publish,
no store, protocol mismatch, an expired superseded revision, and a current
revision beyond its TTL. Static checks find no writer, engine-runtime, source
adapter, temp revision lease, or artifact runner in web.

### Step 5: Make CLI a reader plus bounded engine client

1. Classify commands: pure help/render and compatible published reads require no
   engine; fresh report/snapshot/quota, policy/machine mutation, Cursor import,
   and merge/store mutation require engine; explicit portable output remains a
   CLI file write after reading.
2. Replace one-shot collection, quota writers, machine config writes, and writer
   report workflows with one injected engine client/foreground launcher. Do not
   preserve old collection as fallback.
3. With a valid daemon, submit and await bounded status/events, then read its
   committed revision. Without one, launch engine foreground with explicit
   paths, await exact command completion, read, and ensure exit. An incompatible
   live daemon fails rather than being raced.
4. Preserve stdout formats, warning order, exit codes, cancellation, color, and
   large-output drain. Engine diagnostics never corrupt structured stdout.
5. Delete report-data one-shot write exports after callers migrate; retain pure
   assembly/rendering and portable parsing.

**Verify**: CLI tests cover daemon/foreground parity, concurrency, Ctrl-C,
stale rendezvous, mismatch, engine failure, stored read with engine down, empty
store, quota, import/merge, and byte-identical supported output fixtures.

### Step 6: Supervise dev, production, tests, and demo explicitly

1. Root `dev` runs persistent engine and web Turbo tasks with attributable logs
   and independent outputs. Engine changes restart only engine; UI/HMR changes
   do not restart it or trigger collection/publication/migration/checkpoint.
2. Add a small Bun production supervisor: start engine, await authenticated
   readiness, start web, forward signals, report first failure, reap both. Keep
   listeners numeric loopback. Update start/smoke/contributor commands.
3. Keep an explicitly named web-only diagnostic start that reads an existing
   store but never silently spawns engine. Ordinary start uses supervisor.
4. E2E gets one isolated synthetic store/engine fixture per worker/suite. Demo
   starts web alone with synthetic payload and rejects production functions.
5. Test engine/web startup failure, either child crash, signals, forced timeout,
   port collision, and zero orphan descendants/rendezvous/build locks.
6. Measure warm idle for five minutes and repeat Step 0. Acceptance: no repeated
   warm-idle write growth; no Session lease creation; no per-query Bun process;
   no deleted dev output during build; writes only to attributable durable
   paths during collection; web HMR causes no collection/publication/store write.
   Record measured values.

**Verify**: lifecycle tests and all E2E modes pass; the five-minute trace meets
each acceptance item and is attached to the baseline document.

### Step 7: Cut over, remove compatibility code, and document ownership

1. Search for retired symbols/paths: `WebProcessRuntime`,
   `createWebProcessRuntime`, `runOneShotLocalSources`,
   `reportRevisionRegistry`, `withReportRevisionQueryLeaseForServer`,
   `ai-usage-session-query-lease-`, artifact runners, web scheduler plugin, and
   mixed usage-store imports. Production matches are forbidden.
2. Remove orphan dependencies, exports, scripts, tests, and output assumptions.
   Regenerate lockfile only for workspace manifests; no dependency upgrades.
3. Update `README.md`, `CONTRIBUTING.md`, architecture/public-interface docs and
   package READMEs with commands, failure modes, direct-read/control distinction,
   SQLite backup expectations, and sole-writer rules.
4. Add an ADR for the split. Amend/supersede only host/artifact clauses in ADRs
   0001, 0002, 0007, and web ownership in 0008. Preserve bounded workers,
   exact-revision consistency, SSR, privacy, and observability. Record why there
   is no data API or dual write.
5. Run the complete clean isolated gate; inspect status, diff, boundaries,
   exports, and measured evidence. Mark `DONE` only after all criteria pass.

**Verify**: every command above passes. Repository search proves exactly one
SQLite writer composition root and no legacy web/CLI write path.

## Test plan

- **Contracts/security**: parsing, budgets, auth, redaction, loopback, private
  rendezvous/inbox, version mismatch, timeout, abort, SSE reconnect.
- **Storage**: migration, reader immutability, WAL concurrency, rollback,
  revision isolation/retention/corruption/bounds/query plans/schema mismatch.
- **Engine**: lock, source transitions/cadence/cancellation, publication dedupe,
  config/merge mutations, foreground parity, recovery, signals, event privacy.
- **Web**: SSR, direct queries, disconnected engine, controls, handoff,
  revision retry, demo import boundary.
- **CLI**: daemon/foreground, output parity, cancellation, errors, concurrency,
  fresh/stored reads, import/merge.
- **Lifecycle/performance**: HMR independence, build isolation, supervision,
  cleanup, cold/warm idle, collection, query, disk, descriptors, and RSS.

## Done criteria

- [x] `apps/usage-engine` is the only production composition root that can open
      usage SQLite read-write or run migrations/checkpoints.
- [x] Web and CLI import only usage-store reader and never collectors, writer,
      or engine-runtime.
- [x] Report/session/focused/quota reads use read-only SQLite; control has no
      data-query endpoint.
- [x] Revision publication/current pointer commit atomically and exact reads are
      isolated from later publication.
- [x] File revision registries, copied Session databases, temp leases, and
      per-query artifact subprocesses are deleted.
- [x] Web HMR cannot collect, publish, migrate, or checkpoint.
- [x] Dev/build outputs are isolated and build cannot delete active dev files.
- [x] CLI fresh/mutating behavior has no legacy one-shot writer fallback.
- [x] Web reads a compatible last publication with engine down and disables
      mutations clearly.
- [x] Demo loads neither production engine/control nor durable reader.
- [x] Existing source, revision, privacy, transfer, and event guarantees remain
      covered.
- [x] Warm-idle write loop, orphan lease growth, deleted dev descriptors, and
      per-query Bun process are absent in measured evidence.
- [x] Check, lint, types, tests, build, E2E/smoke, and diff hygiene all pass.
- [x] Docs/ADRs describe final code and the index row is `DONE`.

## STOP conditions

Stop and report instead of widening or weakening the design if:

- direct readers require a write-capable open, migration, checkpoint, temp copy,
  or filesystem lease;
- a current query cannot be revision-keyed/bounded without changing its result;
- bounded reads indefinitely block engine publication/checkpointing;
- a mutation requires web/CLI to write SQLite/config concurrently with engine;
- two engines can pass lock validation or stale lock recovery is unsafe;
- Nitro cannot isolate outputs with supported typed configuration;
- demo/E2E needs real store, config, histories, rendezvous, or token;
- control starts returning report/session/focused/quota/file data;
- mismatch silently falls back to an old writer/runtime;
- implementation needs LAN, OS service install, DB copies, dual writes, or a
  compatibility scheduler;
- an accepted non-destructive source, revision, confirmation, privacy, loopback,
  or output guarantee cannot be preserved.

## Maintenance notes

The durable database is the data plane; engine HTTP is only the operational
plane. Keep that distinction enforceable. A remote UI, multi-user daemon, or
non-Bun reader needs a new architecture decision and likely a real data service.

Append-only served projections trade bounded durable space for copy-free exact
reads. Measure retention, indexes, WAL behavior, and byte budgets periodically;
do not reintroduce copied SQLite snapshots.

The big-bang choice removes transition complexity but increases review risk.
Keep wave commits reviewable, run the sole-writer search after each ownership
move, and never release until old web/CLI writers are gone.
