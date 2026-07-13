# Plan 008: Remediate the Full Application Audit and Remove Legacy LAN Sync

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none; plans 001–007 are complete
- **Category**: security / correctness / performance / architecture / tests
- **Based on**: commit `7ff9944`, 2026-07-13
- **Status**: DONE
- **Completed**: 2026-07-13
- **Final implementation commit**: `fea9f77`
- **Execution log**: [008-comprehensive-audit-remediation-log.md](008-comprehensive-audit-remediation-log.md)
- **Suggested branch**: `fix/008-comprehensive-audit-remediation`

## Executor instructions

Read this plan completely before editing code. Execute the waves in order unless
the dependency graph explicitly allows parallel work. Keep each wave in a
separate, reviewable commit and record commands, results, deviations, and
measurements in `plans/008-comprehensive-audit-remediation-log.md`.

Before starting, compare the current commit with `7ff9944`. If any in-scope file
has changed, re-read that file and update the execution log before applying the
corresponding step. Do not blindly restore excerpts or line numbers from this
plan.

This is one program, not one oversized patch. The production-start and LAN
removal waves are urgent. Later performance refactors may be split into multiple
pull requests, but they remain covered by this plan and the plan stays TODO or
IN PROGRESS until every non-deferred finding in the coverage matrix is closed.

## Why this matters

The audit found two production blockers, a legacy unauthenticated network stack
that survived the earlier LAN-pairing deletion, several avoidable full-report
and duplicate-DOM costs, and gaps where test fakes bypass the production
adapter. The largest risk is not cosmetic: the documented production web start
currently binds beyond loopback and the root route resolves its report runner
from the bundled module location, causing `/` to fail after build.

The intended product is local-first. Multi-machine exchange remains supported
through explicit files. This plan therefore removes the old HTTP snapshot
server, remotes, discovery, polling, and stored-sync configuration while
preserving:

- `snapshot --out <file>`;
- `merge <files...>` and local-history merge;
- `projects list --paths <files...>`;
- `setup <files...>` and `setup --local` (the command always opens its web UI);
- the file-only web `/sync` import/export workspace;
- the self-contained static HTML report opened through `file://`.

## Target outcome

When this plan is complete:

1. The supported production web command serves `/` and `/skills` successfully
   and listens only on `127.0.0.1`.
2. The `setup` UI also listens only on loopback.
3. Local web requests reject untrusted Host/Origin values, including DNS
   rebinding attempts; setup mutations accept only bounded validated JSON.
4. No active LAN snapshot server, remote, peer discovery, polling workflow,
   package, CLI flag, manifest dependency, or current documentation remains.
5. Snapshot files are read through one bounded, no-follow adapter and parsed
   against a strict shared serialized-row contract.
6. Opening `/skills` no longer builds a complete report, and real Skills server
   mutations are tested with temporary storage rather than the real HOME.
7. Closed advanced analysis does not mount its charts, and Sessions mounts only
   the surface needed by the current viewport.
8. SQLite merge imports avoid a lookup and statement preparation per row while
   preserving transaction and counter semantics.
9. Time-range interaction is driven by a pure, characterized state machine.
10. Served report refresh no longer depends on a 64 MiB buffered stdout payload
   and moves to revisioned, task-specific queries; static HTML keeps the full
   compatibility payload.
11. Package-boundary checks and current documentation make the removed network
    architecture difficult to reintroduce accidentally.

## Findings coverage matrix

| ID | Finding | Priority | Resolution | Wave |
| --- | --- | --- | --- | --- |
| F01 | Production web start binds to all interfaces without authentication | P0 | Hard-bind the supported Node/Nitro start to loopback and add a production smoke test | 1 |
| F02 | Built production `/` resolves the report runner from `.output` and returns 500 | P0 | Discover and validate the workspace root independently of `import.meta.url` | 1 |
| F03 | The `setup` UI uses `Bun.serve` without a hostname and exposes a write endpoint | P0 | Bind setup to loopback and test the listener | 1 |
| F04 | Legacy CLI snapshot HTTP server, remotes, polling, discovery, and `@ai-usage/sync` remain | P1 | Delete the entire LAN stack while retaining file workflows | 2 |
| F05 | Snapshot parsing is shallow and local file reads are unbounded | P1 | Shared strict validation plus bounded no-follow file I/O | 3 |
| F06 | Remote snapshot filename collisions can overwrite stored peers | P1 | Resolved by deleting remote storage and `sync-storage`; no replacement naming scheme | 2 |
| F07 | Closed Advanced analysis still builds Session shape and Punchcard | P1 | Mount expensive chart DOM and memos only while the disclosure is open | 5 |
| F08 | `/skills` project discovery constructs a complete report and the route loader is sequential | P1 | Add a local project/source summary query and load independent route data in parallel | 4 |
| F09 | Skills E2E replaces the server adapter, leaving production mutations weakly tested | P1 | Inject production dependencies and test the real adapter against temporary storage | 4 |
| F10 | SQLite merge import performs a `SELECT` and prepares writes for each row | P2 | Batch lookups and reuse prepared statements inside one transaction | 6 |
| F11 | Served report refresh buffers one full payload with a fixed 64 MiB ceiling | P1 | File handoff first, then revisioned server queries/slices; retain full static payload | 8 |
| F12 | Sessions mounts desktop virtualization and 50 mobile cards simultaneously | P2 | Render one viewport-specific surface, with an explicit print mode | 5 |
| F13 | `time-range-control.tsx` combines rendering with four mutable drag protocols | P2 | Characterize behavior and extract a pure interaction state machine | 7 |
| F14 | Boundaries and docs still describe the removed LAN architecture and omit current package surfaces | P2 | Add forbidden-package checks and reconcile all current architecture/domain docs | 9 |
| F15 | Loopback HTTP still trusts hostile Host/Origin values and setup accepts an unbounded mutation body | P0 | Add shared local-request trust checks and bounded validated setup mutations | 1 |

The initial audit also proposed product directions—versioned pricing provenance,
quota history, a yearly “Wrapped” view, and a friendlier manual transfer inbox.
They are recorded under **Explicitly deferred product direction**. They are not
defects and must not be mixed into this remediation program.

## Current-state evidence

The following evidence is from commit `7ff9944`. Treat symbols and behavior as
the source of truth if line numbers drift.

### Production runtime

- `apps/web/package.json` starts `node .output/server/index.mjs` without a host.
  Nitro defaults to a non-loopback listener.
- `apps/web/src/server/report-payload.server.ts` derives `rootDir` by walking a
  fixed four parents from `import.meta.url`. In the built Nitro chunk this
  points under `apps/`, so the runner path becomes
  `apps/packages/report-data/src/report-payload-runner.ts`.
- The same module buffers child stdout through `execFile` with
  `maxBuffer: 64 * 1024 * 1024`.
- `apps/cli/src/setup.ts:runSetupServer` calls `Bun.serve({ port, fetch })`
  without `hostname`; its `PUT /api/aliases` route mutates config.
- Loopback binding alone does not stop DNS rebinding. The manual merge endpoint
  already validates Host/Origin, but the app as a whole and setup's
  `/api/sources`/`PUT /api/aliases` do not share that protection.

### LAN residue

- `apps/cli/src/cli.ts` still defines `ServeArgs`, `SyncArgs`, `serve`, `sync`,
  `merge --remote`, and token options.
- `apps/cli/src/main.ts` imports `fetchRemoteSnapshot` and `readSnapshotFile`
  from `@ai-usage/sync/transport`.
- `apps/cli/src/serve.ts` and `apps/cli/src/sync.ts` are active adapters.
- `packages/sync/` still contains server, transport, workflow, state, errors,
  and discovery modules.
- `packages/local-collectors/src/sync-storage.ts` persists remotes and fetched
  snapshots, and `AiUsageConfig` still exposes `sync.remotes`.
- `README.md`, `CONTEXT.md`, `docs/architecture.md`, and
  `docs/public-package-interfaces.md` still describe the network workflow.
- The web `/sync` route is already file-only and uses
  `@ai-usage/usage-merge`; it is not part of the deletion.

### Performance and test seams

- `apps/web/src/overview.tsx` renders `SessionShape` and `Punchcard` inside a
  closed `<details>`; CSS visibility does not avoid their calculations or DOM.
- `apps/web/src/routes/skills.tsx` awaits known paths before the Skills
  snapshot. `readKnownSkillProjectPathsForServer` calls
  `runReportPayloadCollection()` even though it needs only local project groups
  and sources.
- `apps/web/src/server/skills.ts` can replace the whole adapter for E2E, so that
  suite does not exercise filesystem/config wiring in `skills.server.ts`.
- `packages/usage-store/src/index.ts:importMergeRows` executes
  `SELECT ... WHERE row_key = ?` inside the row loop.
- `apps/web/src/session-table.tsx` mounts both the desktop table and mobile
  summaries; `packages/design-system/src/components/table.ts` only hides one.
- `apps/web/src/time-range-control.tsx` is roughly 1,575 lines and owns visual
  zoom, selection, wheel, keyboard, and four pointer-drag records. Its unit test
  primarily covers helper labels/positions.

## Scope

### In scope

- `.github/workflows/pr-checks.yml`
- root `package.json`, `bun.lock`, `README.md`, and `CONTEXT.md`
- `apps/cli/package.json`, `apps/cli/README.md`, and relevant `apps/cli/src/**`
- `apps/web/package.json`, `apps/web/README.md`, relevant `apps/web/src/**`, and
  relevant `apps/web/e2e/**`
- all of `packages/sync/**` for deletion
- relevant files in `packages/local-collectors`, `packages/report-core`,
  `packages/report-data`, `packages/usage-store`, and `packages/usage-merge`
- `tools/check-package-boundaries.ts` and new focused tool/smoke tests
- current architecture, interface, future-work, audit-status, and package docs
- `plans/README.md` and the execution log for this plan

### Out of scope

- Renaming the file-only `/sync` route. Its name may be reconsidered in a
  separate product decision.
- Automatic deletion of existing snapshot files, cached remote snapshots,
  tokens, environment variables, or user config fields.
- Adding a replacement LAN, cloud, account, or credential protocol.
- Repricing historical rows, storing quota history, or implementing Wrapped.
- Rewriting historical completed plans to pretend LAN never existed.
- Changing pricing math, report aggregation semantics, URL codecs, column
  schemas, or merge deduplication as incidental refactors.

## Dependency graph and delivery order

```text
Wave 0 characterization
  ├─> Wave 1 production runtime
  ├─> Wave 2 LAN deletion ─> Wave 3 snapshot hardening ─> Wave 9 docs/guards
  ├─> Wave 4 Skills seams/query ────────────────────────> Wave 9 docs/guards
  ├─> Wave 5 UI mount costs
  ├─> Wave 6 SQLite batching
  └─> Wave 7 time-range state ─> Wave 8 report transport/queries ─> Wave 9
```

Waves 1, 4, 5, 6, and 7 may be implemented in parallel after Wave 0. Wave 3
must follow the local snapshot-reader move in Wave 2. Package guards and final
docs must follow actual deletion/API stabilization, not anticipate it.

## Wave 0 — Baseline, characterization, and measurements

### Goal

Freeze the behavior that must survive and capture enough baseline data to prove
that later performance work is a real improvement.

### Steps

1. Confirm the working tree and toolchain:

   ```sh
   git status --short
   git rev-parse --short HEAD
   bun --version
   ```

   STOP if unrelated user changes overlap an in-scope file; preserve and
   reconcile them before continuing.

2. Run the current full baseline and record counts/durations in the execution
   log:

   ```sh
   bun x ultracite check
   bun run lint
   bun run typecheck
   bun run test
   bun run build
   bun run test:e2e
   bun run test:html-export
   ```

3. In `apps/cli/src/cli.test.ts`, characterize the file workflows that must
   survive: `snapshot --out`, `merge <file>`, `projects list --paths <file>`,
   and `setup <file>`. Add a negative assertion for the currently unsupported
   `setup --web` spelling so the final docs do not preserve that stale syntax.

4. Retain the browser assertion in `apps/web/e2e/dashboard.spec.ts` that `/sync`
   exposes file import/export without pairing or peer controls.

5. Before refactoring `TimeRangeControl`, add focused browser coverage for:

   - report-range preset, text input, keyboard handle, pointer selection drag,
     and URL commit;
   - visual-view keyboard, wheel, pan, resize handles, pointer cancellation,
     and the invariant that visual zoom never changes the URL/report filter;
   - range clamping after domain/granularity changes.

6. With a deterministic large fixture, record:

   - production report payload bytes and refresh time;
   - `/skills` first-load duration and whether datasets/payload serialization
     run;
   - merge-import duration for 1,000 and 50,000 rows;
   - Session DOM node counts at 361 px and 1024 px;
   - Advanced analysis DOM node count while closed.

   Make this reproducible rather than collecting numbers by hand. Create
   `tools/measure-audit-baseline.ts` with a fixed synthetic-row generator, a
   temporary HOME/database, 1,000-row and 50,000-row cases, and machine-readable
   JSON output. Add a focused Playwright performance fixture that reports the
   two viewport/Advanced DOM counts from deterministic report data. The exact
   baseline commands are:

   ```sh
   bun tools/measure-audit-baseline.ts
   bun run --cwd apps/web test:e2e -- e2e/audit-performance.spec.ts
   ```

   Copy the JSON results printed to stdout into the execution log; keep only
   the reusable synthetic generator/tests in source.

   Freeze the generator seed, harness/provider/project/campaign distribution,
   filters/sorts/selectors, one warm-up plus at least five measured repetitions,
   and median calculation in the tool. Before implementing performance waves,
   record hardware-independent acceptance budgets for SQL/query count, maximum
   page rows, runner artifact bytes, served bootstrap bytes, and Overview/page
   refresh bytes. Treat wall-clock deltas as informational unless a tolerance
   is written into the log now; do not choose a passing threshold afterward.

### Verification

All existing checks pass. New tests describe current supported behavior and
fail only when the intended later change deliberately alters DOM presence or
deleted LAN commands.

### STOP conditions

- A baseline failure is unrelated to this plan and cannot be isolated.
- The preserved file workflow depends on a network call.
- A performance fixture contains real user history or credentials.

## Wave 1 — Fix production start, root discovery, and loopback listeners

### Goal

Make the documented built application usable and local-only before touching
larger architecture.

### Files

- Create `apps/web/start.mjs`.
- Create `apps/web/src/server/report-runtime-paths.server.ts`.
- Create `apps/web/src/server/report-runtime-paths.server.test.ts`.
- Modify `apps/web/package.json`.
- Modify `apps/web/vite.config.ts` and add a focused dev-middleware test.
- Modify `apps/web/src/server/report-payload.server.ts`.
- Create `apps/web/src/server/local-request-trust.server.ts` and tests, then
  reuse it from `manual-merge-upload.server.ts`.
- Modify `apps/cli/src/setup.ts` and its focused tests.
- Create `tools/check-web-production-start.ts`.
- Modify root `package.json` and `.github/workflows/pr-checks.yml`.

### Steps

1. Add `resolveReportRuntimePaths({ cwd, configuredRoot })` in
   `report-runtime-paths.server.ts`.

   - Resolve and validate an explicit `AI_USAGE_ROOT_DIR` first when present.
   - Otherwise walk upward from `process.cwd()` until both the root workspace
     manifest and `packages/report-data/src/report-payload-runner.ts` exist.
   - Require the runner to be a regular file.
   - Return the root, runner, and root `.env` paths.
   - Throw a descriptive path-only error; never print environment values.
   - Never derive the root by counting parents from bundled `import.meta.url`.

2. Replace `rootDir`, `reportingPayloadRunner`, and `rootEnvPath` in
   `report-payload.server.ts` with this helper. Keep the Node-to-Bun subprocess
   boundary: do not import `bun:sqlite` into Nitro and do not change Nitro to a
   Bun runtime as a shortcut.

3. Make `apps/web/start.mjs` set Nitro's host to `127.0.0.1` before dynamically
   importing `.output/server/index.mjs`. Point `apps/web/package.json:start` at
   the wrapper. Do not offer an unauthenticated non-loopback override. The smoke
   test must launch with hostile inherited `HOST=0.0.0.0` and
   `NITRO_HOST=0.0.0.0` values and prove the wrapper still forces loopback.

4. Extract the trusted-local-request logic from
   `manual-merge-upload.server.ts` into `local-request-trust.server.ts`. Wire it
   as a global TanStack Start/Nitro request middleware so every HTML, loader,
   and server-function request rejects missing/non-loopback Host values and
   cross-site/mismatched Origin or `Sec-Fetch-Site` values before app code. Keep
   loopback hostnames with arbitrary ports (`localhost`, `127.0.0.1`, `[::1]`)
   valid. Add hostile `Host`, `Origin`, forwarded-protocol, and fetch-site tests,
   including a DNS-rebinding hostname that resolves to loopback.

   The Vite `manualSyncImportDevPlugin` currently intercepts `POST /sync`,
   accumulates its own unbounded body, and calls the import adapter directly.
   Replace that bypass with a Node-request-to-Fetch-Request adapter that invokes
   the same trusted, content-type/schema/byte-bounded upload handler as
   production and forwards its status/headers/body. Add a dev-middleware test
   for hostile Host/Origin and chunked overflow; global Nitro middleware alone
   does not protect a Vite plugin that runs first.

5. Add `hostname: '127.0.0.1'` to `runSetupServer`'s `Bun.serve` options.
   Extract a named constant or server-options helper so a unit test can assert
   the bind without starting an unbounded `Effect.never` process. Also add
   `tools/check-setup-loopback.ts`: start `setup --local --port <free>` with a
   temporary HOME, require its loopback page/API to respond, require the same
   port through a non-loopback IPv4 address to fail, and terminate/clean up in
   `finally`. Wire it as root `test:setup-loopback` and run it in CI after build.

   Apply the same trusted Host checks to every setup response, including
   `/api/sources`. For `PUT /api/aliases`, additionally require same-origin
   fetch metadata/Origin, `Content-Type: application/json`, a named byte limit,
   a bounded streaming body reader, and the existing alias schema plus explicit
   array/match-count limits. Return 4xx for hostile/oversized/invalid input
   without writing config. Refactor server creation to return a closable handle
   so focused tests exercise the actual listener instead of only an options
   object.

6. Unit-test runtime-path discovery from repository root, `apps/web`, relative
   and absolute configured roots, invalid roots, and a missing runner. Include
   a fixture path resembling `.output/server/_ssr` to prove it is irrelevant.

7. Add `tools/check-web-production-start.ts` and root script
   `test:web-production`:

   - use a temporary HOME and free port;
   - start `bun run --cwd apps/web start` after `bun run build`;
   - wait with a bounded deadline;
   - require `GET /` and `GET /skills` to return 200 and contain their expected
     application markers rather than a framework/error shell;
   - require `/skills` to contain no known project-loader error banner and the
     captured bounded logs to contain no runner/path resolution failure;
   - send hostile Host/Origin/fetch-site requests to a read route and a server
     mutation and require rejection before application work;
   - require a connection through a detected non-loopback IPv4 address to fail;
   - verify the child stays alive through both requests;
   - always terminate the child and remove temp data in `finally`;
   - cap captured logs and never dump environment/config contents.

8. Run both listener smoke tests after build in
   `.github/workflows/pr-checks.yml`.

### Verification

```sh
bun test apps/web/src/server/report-runtime-paths.server.test.ts
bun test apps/web/src/server/local-request-trust.server.test.ts apps/web/src/server/manual-merge-upload.server.test.ts
bun test apps/cli/src/setup.test.ts
bun run build
bun run test:web-production
bun run test:setup-loopback
```

Expected: `/` and `/skills` are 200, the process is reachable through
`127.0.0.1`, and a non-loopback connection fails.

### STOP conditions

- Root discovery requires a machine-specific absolute path.
- The fix imports `bun:sqlite` into the Node server.
- Either web server still needs a non-loopback listener. That requires a
  separate authenticated deployment design before exposure.
- The smoke test needs internet access or an external interface.
- A hostile Host/Origin reaches an app loader, server function, setup source
  response, or setup mutation.

## Wave 2 — Delete the complete legacy LAN sync stack

### Goal

Remove active networking, remote state, and package residue while keeping all
explicit file exchange paths.

### Files

- Create `apps/cli/src/snapshot-file.ts` and its test.
- Modify `apps/cli/src/cli.ts`, `cli.test.ts`, `main.ts`, and `setup.ts`.
- Delete `apps/cli/src/serve.ts` and `apps/cli/src/sync.ts`.
- Modify `apps/cli/package.json`.
- Delete `packages/sync/**`.
- Delete `packages/local-collectors/src/sync-storage.ts` and its test.
- Modify `packages/local-collectors/package.json` and `src/index.ts`.
- Modify `packages/report-core/src/project-alias.ts`.
- Modify `packages/local-collectors/src/machine-config.ts` and tests.
- Regenerate `bun.lock` through Bun; do not hand-edit lockfile records.

### Steps

1. First move local snapshot reading out of the package being deleted.

   - Add `readUsageSnapshotFile` in `apps/cli/src/snapshot-file.ts`.
   - Initially preserve the behavior of `packages/sync/src/transport.ts` so the
     move and deletion are reviewable separately; Wave 3 hardens it.
   - Use this helper in `apps/cli/src/main.ts` for file merge/project inputs and
     in `apps/cli/src/setup.ts` instead of its direct `readFileSync` parser.
   - Move the valid-file test from `transport.test.ts` to
     `snapshot-file.test.ts`.

2. Remove the network CLI grammar and dispatch.

   - Delete `ServeArgs`, `SyncArgs`, `Serve`/`Sync` command variants,
     `parseServeArgs`, `parseSyncArgs`, and LAN help text.
   - Delete `MergeArgs.remote` and `.token`; reject `merge --remote` and
     `merge --token` as unknown arguments.
   - Remove imports/dispatch for `fetchRemoteSnapshot`, `runServe`, and
     `runSyncCommand`.
   - Delete `serve.ts` and `sync.ts`.
   - Replace positive LAN parser tests with negative tests for `serve`, `sync`,
     `merge --remote`, and `merge --token`.

3. Remove `@ai-usage/sync` from `apps/cli/package.json`, then delete the entire
   `packages/sync/` directory.

4. Delete synced-remote persistence:

   - delete `sync-storage.ts` and its tests;
   - remove the `./sync-storage` manifest subpath and barrel export;
   - delete `SyncRemoteConfig` and `AiUsageConfig.sync`;
   - remove specialized `sync` validation and merge behavior from
     `machine-config.ts`.

5. Preserve user data safely. An old top-level `sync` key becomes an unknown,
   inert field under the existing permissive config behavior. Reads must not
   activate it or fail solely because it remains. Ordinary config updates must
   preserve that unknown object and all unrelated known fields. Add a test that
   reads a legacy `sync` object, performs an unrelated alias/Skills update, and
   proves the object remains deeply equal while no runtime code consumes it.
   Do not proactively rewrite/delete old config, credential files, environment
   variables, or stored snapshots.

6. Regenerate `bun.lock` with the normal Bun install/update path and verify no
   workspace reference to `@ai-usage/sync` remains.

### Verification

```sh
bun test apps/cli/src/cli.test.ts apps/cli/src/snapshot-file.test.ts
bun test packages/local-collectors/src/machine-config.test.ts
test ! -d packages/sync
! rg -n '"@ai-usage/sync"|from .@ai-usage/sync|import\(.@ai-usage/sync' apps packages package.json bun.lock
bun run lint
bun run typecheck
bun run test
```

Also run an end-to-end CLI round trip: create a current snapshot, merge it from
a file, and list its project paths. For setup, spawn `setup <file> --port
<free>`, wait with a deadline, GET the page/API and assert file-derived project
content, then terminate the `Effect.never` process and remove temporary HOME
data in `finally`; never run it as a foreground command that hangs verification.

### STOP conditions

- Any runtime consumer outside `packages/sync` still needs remote/network
  behavior.
- `snapshot`, file merge, project listing, setup-by-file, or web `/sync`
  regresses.
- The implementation deletes user data or token material automatically.
- Removed network behavior is merely renamed or moved to another package.

## Wave 3 — Make snapshot files bounded and semantically strict

### Goal

Treat snapshot files as untrusted input without weakening current round-trip or
merge compatibility.

### Files

- Create `packages/report-core/src/serialized-usage-validation.ts`.
- Modify `packages/report-core/src/merge-bundle.ts` and tests.
- Modify `packages/report-core/src/snapshot.ts` and tests.
- Modify `apps/cli/src/snapshot-file.ts` and tests.
- Modify focused CLI setup/merge integration tests.

### Steps

1. Extract the private serialized-row validators already present in
   `merge-bundle.ts` into an internal shared module. Cover finite non-negative
   metrics, strict ISO timestamps, optional fields, warnings, and derived
   invariants such as `activeDate`, `freshTokens`, `lineDelta`, `sessionLabel`,
   and `tokenTotal`. Keep the existing merge-bundle contract unchanged.

2. Make `parseUsageSnapshot` validate:

   - only documented top-level keys and the supported `schemaVersion`;
   - non-empty `snapshotId`, machine ID, and harness key;
   - `source.appVersion` as null or a non-empty string, matching current CLI
     snapshots that emit null when no version is available;
   - strict `generatedAt` and row timestamps;
   - machine label and source platform/hostname shapes;
   - every serialized row and warning through shared validators;
   - `sourceSessionId` as string or null;
   - row source machine ID/label equal to the snapshot's outer machine;
   - known dataset schemas strictly while retaining valid future dataset keys;
   - facets as JSON-safe object data.

3. Add a named `MAX_USAGE_SNAPSHOT_ROWS`; reject oversized snapshots
   atomically and never truncate. Choose and document the value from supported
   history sizes rather than copying a magic number. If 50,000 is chosen, align
   the rationale with the manual merge boundary.

4. Harden `apps/cli/src/snapshot-file.ts`:

   - add `MAX_USAGE_SNAPSHOT_BYTES` with a documented rationale;
   - open with no-follow semantics, `fstat` the opened handle, require a regular
     file, check size before reading, and close in `finally`;
   - read from that same handle in bounded chunks, stopping at
     `MAX_USAGE_SNAPSHOT_BYTES + 1`; do not call an unbounded `readFile` after
     `fstat`, because another process can grow the file between those calls;
   - reject directory, symlink, growth beyond the bound, invalid JSON, and an
     invalid semantic snapshot;
   - return a path-contextual CLI error without file contents.

5. Add tests for current round-trip, malformed/negative/non-finite fields,
   invalid timestamps and derived values, forged row machine provenance,
   unknown top-level keys, row/byte limits, known/future datasets, symlinks,
   directories, cleanup, deduplication, and two-file merge warnings. Include a
   controlled test that grows the already-open file after `fstat`; the bounded
   loop must stop at `MAX_USAGE_SNAPSHOT_BYTES + 1` and reject it.

### Verification

```sh
bun test packages/report-core/src/snapshot.test.ts packages/report-core/src/merge-bundle.test.ts
bun test apps/cli/src/snapshot-file.test.ts apps/cli/src/setup.test.ts
bun run typecheck
bun run test
```

### STOP conditions

- `createUsageSnapshot` output from the current version fails its own strict
  parser.
- A proposed limit rejects an officially supported real history. Design a
  versioned/streamed format instead of silently increasing memory use.
- Invalid rows are skipped or truncated instead of rejecting the import.
- The extraction changes merge-bundle semantics or logs snapshot contents.

## Wave 4 — Deepen the Skills server seam and avoid full-report discovery

### Goal

Make `/skills` load only the local project/source information it needs, and
exercise the exact production adapter in tests.

### Files

- Modify `packages/report-data/src/index.ts` and reporting tests.
- Modify `apps/web/src/server/skills-contracts.ts`.
- Modify `apps/web/src/server/skills.server.ts` and its tests.
- Modify `apps/web/src/server/skills.ts`.
- Modify `apps/web/src/routes/skills.tsx`.

### Steps

1. In `@ai-usage/report-data`, add a focused contract:

   - `KnownLocalProjectSourcesRequest`;
   - `KnownLocalProjectSourcesResult` containing project groups/sources and only
     relevant warnings;
   - `createKnownLocalProjectSources` as the Effect constructor;
   - `runKnownLocalProjectSources` as the Promise adapter.

2. Query stored rows with `originMachineIds: [machine.id]`, apply the existing
   project-group projection, and never use imported machine rows to discover
   repositories. When the **local-machine query** is empty—even if the database
   contains imported rows—allow at most one explicit local collection, then
   query only local rows; do not build `UsageReportPayload`, analytics, or
   datasets as an intermediate.

3. Replace `readKnownSkillProjectPathsForServer`'s dynamic import of
   `runReportPayloadCollection` with the focused query. Preserve canonical
   worktree handling, excluded cache/data prefixes, config-owned paths, project
   root checks, group IDs, labels, and session counts.

4. In the route loader, fetch independent values in parallel:

   ```ts
   const [knownProjectPaths, skills] = await Promise.all([
     getKnownSkillProjectPaths(),
     getSkillManagementSnapshot(),
   ]);
   ```

5. Share the `SkillsServerAdapter` contract and introduce
   `createSkillsServerAdapter(dependencies)`. Production wrappers and tests must
   call the same factory. Inject storage/project-source dependencies instead of
   hard-coding `LocalHistoryStorageLive` in mutation paths. Audit and replace
   nested live-layer use inside both `runWithStorage` and `loadMergedConfig`, so
   every read/write in a factory-created adapter uses the injected storage.
   The dependency object must also own config reading/config cwd and workflow
   functions; no factory-created operation may fall back to a module-level Live
   layer. Assert injected-call counters and paths in tests rather than relying
   only on a source grep.

6. With a temporary HOME/source/target, test through the real adapter:

   - snapshot read and client redaction of Markdown bodies;
   - config write and preservation of unrelated config;
   - Markdown read/write and revision conflict;
   - enable/disable, preview, reconcile, and target creation;
   - refusal of unknown/unsafe targets;
   - exclusion of imported machine project paths.

   Keep the existing fake adapter only for deterministic browser scenarios.

### Verification

```sh
bun test packages/report-data/src/reporting.test.ts apps/web/src/server/skills.server.test.ts
! rg -n 'runReportPayloadCollection|UsageReportPayload' apps/web/src/server/skills.server.ts
bun run typecheck
bun run test
bun run test:e2e
```

### STOP conditions

- Injection weakens filesystem safety in `@ai-usage/skills`.
- Tests read or mutate real HOME data.
- The tested factory differs from production wiring.
- Imported machine rows affect repository discovery.
- First-use collection requires duplicating private collectors; extract a
  shared report-data primitive first.

## Wave 5 — Remove avoidable dashboard DOM and calculation work

### Goal

Pay for advanced analysis and Sessions presentation only when the user can see
them, without breaking SSR, printing, URLs, or static reports.

### Part A: lazy-mount Advanced analysis

Files: `apps/web/src/overview.tsx` and `apps/web/e2e/dashboard.spec.ts`.

1. Add `advancedAnalysisOpen` synchronized from the native `<details>` `toggle`
   event.
2. Keep the data-aware summary mounted, but mount `SessionShape` and
   `Punchcard` only while open. Unmount them on close so later filters do not
   rerun their sorts/memos.
3. Do not introduce a dynamic import; this is a compute/DOM fix and the static
   root bundle must remain self-contained.
4. Assert DOM absence while closed, presence after opening, absence after
   closing, successful reopening, and keyboard-native disclosure/table access.

### Part B: mount one responsive Sessions surface

Files: create `apps/web/src/session-surface-mode.ts` and its test; modify
`apps/web/src/session-table.tsx`, related schema tests, and dashboard E2E.

1. Create an injectable controller exposing
   `pending | mobile | desktop | print` from
   `matchMedia('(min-width: 48rem)')`, matching Panda's `md` breakpoint.
2. During hydration-pending state, render a lightweight stable placeholder—not
   both surfaces and not a desktop-then-mobile flash.
3. Create `virtualRows`/`ResizeObserver` only in desktop mode and `mobileRows`
   only in mobile mode.
4. Listen to `beforeprint`/`afterprint`: `print` renders the complete semantic
   row model with virtualization and spacer rows disabled, then restores
   viewport mode. Merely forcing desktop is insufficient because desktop
   normally renders only `virtualRows()`. Clean up every listener.
5. Preserve selected session, expanded campaign, sort, and column URL state
   across viewport changes.
6. At 361 px assert only mobile cards exist; at 1024 px assert only the table
   exists; resize without losing state or causing hydration warnings. In print
   mode, assert deterministic first, middle, and final result rows are all in
   the DOM and no virtual spacer remains.

### Verification

```sh
bun test apps/web/src/overview-model.test.ts apps/web/src/session-surface-mode.test.ts apps/web/src/session-table-schema.test.ts
bun run --cwd apps/web test:e2e -- e2e/dashboard.spec.ts
bun x ultracite check
bun run typecheck
```

Record before/after closed-Advanced and both-viewport DOM node counts in the
execution log.

### STOP conditions

- The fix requires a server request or dynamic import in static HTML.
- The native disclosure loses summary context or keyboard behavior.
- First hydration still constructs both Sessions surfaces.
- Print mode omits non-virtualized result rows or leaves virtual spacers.
- A viewport change resets URL-backed state.

## Wave 6 — Batch SQLite merge imports without changing semantics

### Goal

Remove O(rows) point-lookups and repeated preparation while keeping one atomic
transaction and identical results.

### Files

- `packages/usage-store/src/index.ts`
- `packages/usage-store/src/index.test.ts`
- focused compatibility tests in `packages/usage-merge/src/index.test.ts`

### Steps

1. Add a safe internal `IMPORT_LOOKUP_BATCH_SIZE` below SQLite's parameter
   limit, and a chunking helper. Extend the internal existing-row shape with
   `row_key`.
2. Prepare insert, update, and unchanged-touch statements once per import.
3. Inside the existing single `BEGIN IMMEDIATE` transaction, load each batch's
   states using `WHERE row_key IN (...)` into a `Map`.
4. Process rows in original input order and update the map after each row so
   duplicate keys in one batch retain the current sequential semantics.
5. Keep one final `COMMIT`, full `ROLLBACK` on any failure, WAL/busy-timeout
   behavior, and exact `inserted`, `unchanged`, `updated`, `deleted`, and
   `superseded` counters.
6. Test more than two batches; mixed insert/update/unchanged/tombstone across
   boundaries; duplicate row keys; concurrent-writer wait; and rollback after a
   late failure.

### Verification

```sh
bun test packages/usage-store/src/index.test.ts packages/usage-merge/src/index.test.ts
! rg -n "SELECT .*row_key = \?" packages/usage-store/src/index.ts
bun run typecheck
bun run test
```

Compare the 1,000/50,000-row timings with Wave 0 and record them. The result and
counters must match before accepting any speedup.

### STOP conditions

- Batching requires a commit per chunk.
- Duplicate-key semantics or counters differ.
- The optimization disables WAL, busy timeout, bundle validation, or rollback.

## Wave 7 — Extract the Time Range interaction state machine

### Goal

Separate domain transitions from DOM/Solid plumbing while preserving every
interaction and URL behavior established in Wave 0.

### Files

- Create `apps/web/src/time-range-control-state.ts` and its test.
- Modify `apps/web/src/time-range-control.tsx` and its test.
- Preserve `apps/web/src/date-range-controller.ts` and `date-range.ts` APIs.
- Extend `apps/web/e2e/time-range.spec.ts`.

### Target model

Define `TimeRangeControlState` with options, selected report-range indexes,
visual range, disclosure state, hover, and one discriminated interaction:

- `idle`;
- `selection-pan`;
- `selection-handle`;
- `view-pan`;
- `view-handle`.

Define `TimeRangeControlEvent` for option/domain changes, pointer
start/move/end/cancel, keyboard movement, reset, zoom, and pan. A pure
`transitionTimeRangeControl(state, event, context)` returns the next state plus
commands such as `setSelectionIndexes`, `commitReportRange`, and `clearHover`.
It must not receive DOM objects, access Solid signals, or mutate URL state.
Its context models two axes explicitly: report selection uses the day-domain
`selectionMaxIndex`, while chart view uses `visualBucketMaxIndex`. These values
diverge at week/month granularity and must never share one generic `maxIndex`.

### Steps

1. Port the Wave 0 characterization to pure tests, including:

   - `0 <= from <= to <= maxIndex` for selection and visual ranges;
   - report selection commits; visual view never commits;
   - presets/input/keyboard commit immediately; pointer drag commits at end;
   - foreign pointer IDs are ignored;
   - domain change clamps indexes and cancels invalid drags;
   - granularity change remaps the report selection by its dates, resets/remaps
     visual buckets explicitly, and never reinterprets day indexes as buckets;
   - `pointercancel` and loss-of-capture semantics are explicit.

2. Extract normalization, key-to-index, zoom, pan, and pointer-delta math.
3. Replace the four mutable drag records with the discriminated interaction,
   one path at a time while tests remain green.
4. Keep rectangles, pointer capture, `preventDefault`, ARIA, Solid signals, and
   `onDateRangeCommit` inside the JSX adapter.
5. Split presentational subcomponents only after the state extraction if that
   materially reduces the 1,575-line component. Define components at module
   scope and keep their props explicit.
6. Preserve copy, URL codec, `buildTimelineData`, report math, and native
   keyboard behavior.

### Verification

```sh
bun test apps/web/src/time-range-control-state.test.ts apps/web/src/time-range-control.test.ts apps/web/src/date-range-controller.test.ts
bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts
bun x ultracite check
bun run typecheck
bun run test
```

### STOP conditions

- The reducer needs DOM/Solid objects.
- Report range and visual view cannot be proven independent.
- URL codecs, analytics, or timeline aggregation need to change.
- Pointer-up, pointer-cancel, and capture-loss behavior becomes ambiguous.

## Wave 8 — Remove monolithic report-refresh transport and queries

### Goal

First eliminate the hard stdout failure, then make served refresh revisioned and
task-specific. Preserve `UsageReportPayload` and a self-contained full payload
for CLI/static HTML compatibility.

### Files

- `packages/report-data/src/report-payload-runner.ts`
- `packages/report-data/src/index.ts` and focused reporting tests
- Create `packages/report-core/src/session-query.ts` and
  `session-query.test.ts`, then add a public subpath export for its JSON-safe
  query/projection contracts in `packages/report-core/package.json`.
- Extend `packages/usage-store/src/index.ts` and tests for immutable revision
  materialization and bounded page/cursor queries.
- `apps/web/src/server/report-payload.server.ts` and tests
- `apps/web/src/server/report-payload.ts`
- `apps/web/src/web-report-payload.ts` and tests
- `apps/web/src/report-runtime.ts` and tests
- Create `apps/web/src/report-payload-store.ts` and tests
- `apps/web/src/dashboard.tsx`, `dashboard-model.ts`, `dashboard-search.ts`,
  `dashboard-sort.ts`, `dashboard-export.ts`, and their tests/route consumers
- static-export guards in `apps/web/src/routes/index.tsx`, `vite.config.ts`,
  `apps/web/src/css-bundle.test.ts`, `apps/cli/src/html.integration.test.ts`, and
  create `apps/web/e2e/static-html.spec.ts`

### Phase 8A: remove the 64 MiB stdout ceiling without changing report APIs

1. Let the Bun runner accept a server-created output path.
2. Create a private temporary directory/file with restrictive permissions.
   Pass only that path to the child; never derive it from a request.
3. Replace buffered `execFile(... maxBuffer ...)` with `spawn`. Drain stdout and
   stderr, retain only a bounded stderr tail, and write the payload to the file.
4. Freeze a named `MAX_REPORT_RUNNER_ARTIFACT_BYTES` in Wave 0 from the largest
   supported synthetic payload plus explicit headroom. Enforce it in the runner
   before/while writing, terminate/reject on overflow, then `stat` and read from
   the same handle with a `MAX + 1` bounded loop before `JSON.parse`. A file
   handoff removes the accidental 64 MiB child-stdout failure; it must not create
   unlimited disk or heap use.
5. Clean the artifact in `finally` on success, child error, overflow, parse
   error, and cancellation.
6. Test a synthetic valid payload larger than 64 MiB but below the supported
   artifact ceiling, plus ceiling overflow, child error, permission, and every
   cleanup path. Keep stdout/stderr tails bounded.

### Phase 8B: establish revisioned compatibility slices

1. Add opaque `ReportRevision` plus initial contracts:

   - `WebReportRowsSlice { revision, rows }`;
   - `WebReportSupportSlice { revision, payloadWithoutRows }`;
   - `splitWebReportPayload` and `mergeWebReportSlices`.

2. Keep the existing full `WebReportPayload`, `toWebReportPayload`,
   `toExportReportPayload`, root SSR/bootstrap loader, and
   `window.__AI_USAGE_REPORT__` for static HTML.
3. Implement a real immutable revision protocol; a shared string attached to
   separate live reads is not sufficient.

   - After a stored/fresh refresh finishes, one Bun-side job reads the normalized
     rows and non-row context once and materializes an owner-only revision
     directory. It contains a queryable SQLite snapshot/materialized query
     tables plus a validated context manifest; later queries read these files,
     never the live usage store or live config.
   - Publish the revision only after files are complete, fsynced/closed, and
     validated. If the store/config changes during capture, detect it through a
     store generation/config fingerprint and retry rather than publishing a
     mixed snapshot.
   - The Node registry keeps the current revision and any referenced prior
     revision, with explicit reference count, TTL, maximum retained count, and
     owner-only cleanup. Collection, project/config mutations, and manual merge
     imports invalidate `latest` and schedule a new revision; they do not mutate
     an already-published revision.
   - A manifest endpoint returns the current revision. Every data request names
     that exact revision. Missing/expired revisions return a typed
     `RevisionExpired` result; the client discards partial results and restarts
     from a new manifest.
   - Every response also carries a canonical request fingerprint derived from
     validated filter/sort/page inputs. The store rejects out-of-order results
     with the wrong fingerprint even when their revision matches.

   If a consistent SQLite snapshot/materialization cannot be guaranteed with
   the available runtime, STOP and compute/cache all required slices in one Bun
   revision job; do not issue independent live queries and call them atomic.

4. Slice endpoints require an exact revision and request fingerprint; never
   combine implicit `latest` reads.
5. Add `createReportPayloadStore` with atomic `applySlices`, stale/mixed revision
   rejection, and a compatibility payload only for export/unmigrated consumers.
6. On refresh failure or revision mismatch, retain the last known-good complete
   view and show the existing refresh error state.

### Phase 8C: replace served full-refresh producers with task-specific queries

The compatibility split alone does not reduce total collection or transfer.
Finish the finding by adding fine-grained `@ai-usage/report-data` contracts for:

- overview aggregates/timeline and report metadata;
- provider/harness/dataset/warning support data;
- project-group and breakdown aggregates;
- filtered/sorted/paged Session presentation items plus session/item counts;
- campaign children and previous/next session navigation;
- dedicated complete-result CSV and HTML-export data.

Requirements:

1. Move the JSON-safe report query, filter, campaign projection, and 25-column
   Session sort semantics from web-only modules into a pure allowed package
   (prefer `@ai-usage/report-core`). The web URL codec maps to that request; it
   is not imported by report-data. Reuse report-core analytics/pricing and prove
   fixture parity before switching consumers.
2. Define strict request validation: bounded `pageSize`, opaque cursor,
   allowlisted filter/sort fields, canonical fingerprint, and stable row-identity
   tie-breaker. Execute paging against the immutable revision database with
   `LIMIT pageSize + 1`; do not deserialize all rows in Node and call an array
   slice “storage paging”. For computed sort/group keys, materialize the needed
   columns during revision creation.
3. Define Sessions presentation semantics before implementation:

   - a page contains top-level standalone items or campaign summaries;
   - return both top-level `itemCount` and underlying `sessionCount`;
   - campaign expansion uses an exact-revision, bounded child cursor and exposes
     accessible Load more when a campaign exceeds one child page;
   - drawer previous/next uses an exact-revision neighbor query over the full
     validated filtered/sorted sequence, not only the loaded page;
   - selection survives page changes and an expired revision fails explicitly;
   - CSV uses a dedicated bounded streaming/full-result export path with the
     same filters/sort; HTML download requests a complete compatibility export
     artifact. Neither export silently contains only the visible page.

4. Define the Node-to-Bun request/result protocol for every query. Production
   Nitro spawns Bun against the immutable revision directory; it never imports
   `bun:sqlite`. Validate request JSON before spawn, bound stdout/stderr and
   result artifact sizes, and propagate typed query/revision errors.
5. In served mode, request the active destination's data and page Sessions
   rather than transferring every serialized row on every refresh.
6. In static mode, continue deriving all views from the embedded full payload;
   it must perform no server function, fetch, or dynamic import.
7. Every query result carries the revision and request fingerprint. Apply a
   refresh atomically and
   reject mixed/current-stale combinations.
8. Phase 8C only adds producers and parity fixtures. Retain the previous full
   endpoint throughout this phase; do not remove it before consumer migration.

### Phase 8D: migrate the dashboard store and enforce budgets

1. Make dashboard consumers read focused store signals, not a monolithic payload
   signal. Use Solid `batch` for atomic revision updates.
2. Keep compatibility reconstruction private to static export/download and
   explicitly unmigrated consumers; add a test that served refresh does not
   reconstruct full rows merely to feed a focused panel.
3. Apply the Wave 0 frozen, hardware-independent budgets for served bootstrap
   bytes, Overview/one-page refresh bytes, maximum result rows, artifact bytes,
   and query counts. Report repeated median wall times as informational unless
   Wave 0 fixed a tolerance before implementation.
4. Keep the existing root-entry/static-export budget. Do not introduce route
   code splitting that cannot be inlined for `file://`.
5. Only after every Overview, Breakdown, Sessions, campaign, drawer-navigation,
   provider, dataset, warning, project-group, CSV, HTML, and fallback consumer
   passes parity may the served full-refresh endpoint be removed. Static/full
   export contracts remain.
6. Add root `test:html-file` around `static-html.spec.ts`. Generate a report from
   deterministic temp data, open its absolute `file://` URL in Chromium, assert
   hydration plus representative filter/session-drawer interactions, and fail
   on any network request, dynamic chunk request, console error, or page error.
   The existing text-only HTML integration remains as a faster complementary
   contract test.

### Verification

```sh
bun test apps/web/src/server/report-payload.server.test.ts apps/web/src/web-report-payload.test.ts apps/web/src/report-runtime.test.ts apps/web/src/report-payload-store.test.ts
bun test packages/report-core/src/session-query.test.ts packages/report-data/src/reporting.test.ts packages/usage-store/src/index.test.ts
! rg -n 'maxBuffer:\s*64\s*\*\s*1024\s*\*\s*1024' apps/web/src/server/report-payload.server.ts
bun run build
bun run test:web-production
bun run test:setup-loopback
bun run test:e2e
bun run test:html-export
bun run test:html-file
bun run typecheck
bun run test
```

### STOP conditions

- Two pieces of one refresh can come from different revisions.
- A query reads live rows/config after its immutable revision is published, or
  an out-of-order response can pass without the matching request fingerprint.
- The file handoff is world-readable, user-controlled, or survives failures.
- The change replaces bounded stdout with unbounded in-memory buffering.
- Paging loses campaign children, drawer neighbors, or full CSV/HTML exports.
- Static HTML needs a server, fetch, or dynamic asset after export.
- The migration deletes `UsageReportPayload`, which remains a CLI/export
  compatibility contract.
- Fine-grained queries change pricing, totals, filters, sort order, URL
  semantics, or project identity without an explicit separate decision.

## Wave 9 — Lock boundaries, reconcile docs, and close the program

### Goal

Make current architecture truthful and prevent deleted packages/network roles
from returning unnoticed.

### Part A: executable package guards

Files: `tools/check-package-boundaries.ts`, create
`tools/check-package-boundaries.test.ts`, and root test wiring if needed.

1. Extract importable `collectViolations(root)` and guard CLI execution with
   `import.meta.main`.
2. Add retired-package rules for `@ai-usage/sync` and
   `@ai-usage/lan-pairing`. Scan workspace manifests and source imports,
   including subpaths.
3. Add an explicit web boundary forbidding CLI/network adapter packages.
4. Test a retired manifest dependency, root/subpath source imports, a forbidden
   web import, and the valid current graph. Keep Turbo package tests; do not
   replace them with only the tool test.
5. Tool tests are outside Turbo workspaces, so wiring is mandatory: add
   `test:packages: "turbo run test"`, `test:tools: "bun test tools"`, and make
   root `test` run both. Also invoke `test:tools` explicitly in CI so a future
   script refactor cannot silently drop negative boundary fixtures.

### Part B: current documentation

Update after the code/API shape is final:

- `README.md`: document only file snapshots, file merge, and file-only `/sync`;
  remove `serve`, remotes, tokens, polling, `--no-synced`, and LAN claims;
  reconcile the project-layout list with every surviving workspace package;
  document the real `setup [files...] [--local] [--port]` grammar, not the
  currently stale `setup --web` spelling.
- `CONTEXT.md`: remove Synced usage snapshot, Snapshot remote, Snapshot peer,
  and Sync state; add/align Merge bundle, manual transfer, Project source,
  Project group, Skill source repository, Runtime, Projection, and Unmanaged
  runtime entry. Skills is not a report “collected dataset”.
- `docs/architecture.md`: remove `@ai-usage/sync` and network adapter rules;
  document local-only listeners, file transfer, task-specific report queries,
  and local-machine-only Skills project discovery.
- `docs/public-package-interfaces.md`: reconcile every remaining manifest
  export, including currently omitted model-identity/dataset surfaces; remove
  sync and sync-storage exports.
- `docs/future-work.md`: remove stale Sync UI/remotes work; retain a manual
  transfer improvement as product direction and document the delivered report
  query/static compatibility split.
- `apps/cli/README.md`, `apps/web/README.md`, and
  `packages/local-collectors/README.md`: align allowed dependencies and current
  responsibilities, including Skills and no-network boundaries.
- `packages/report-core/README.md`: remove the “while legacy sync exists”
  qualifier and document shared query contracts; update
  `packages/report-data/README.md` and `packages/usage-store/README.md` for
  revision creation, query adapters, and paging responsibilities.
- `docs/skills-management.md` and `docs/skills-management-spec.md`: align the
  project/source query and verification command if those docs describe it.
- `docs/app-audit-2026-07-10.md`: add a dated status note linking this plan; do
  not rewrite historical findings.
- `plans/README.md`: mark plan 008 DONE only after every completion criterion
  below passes.

### Final verification

```sh
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run test:tools
bun run build
bun run test:web-production
bun run test:setup-loopback
bun run test:e2e
bun run test:html-export
bun run test:html-file
```

Run residue checks over current code/docs while excluding historical audit and
plan records:

```sh
test ! -d packages/sync
! rg -n '@ai-usage/sync|@ai-usage/lan-pairing' apps packages package.json bun.lock tools
! rg -ni 'sync add|sync pull|sync watch|sync list|merge --remote|serve --host|--token-env|--no-synced|setup --web|Snapshot remote|Snapshot peer|Synced usage snapshot|snapshot server|served snapshot URL|remote rename|polling' README.md CONTEXT.md docs/architecture.md docs/future-work.md docs/public-package-interfaces.md docs/skills-management.md docs/skills-management-spec.md apps/cli/README.md apps/web/README.md packages/local-collectors/README.md packages/report-core/README.md packages/report-data/README.md packages/usage-store/README.md
```

The literal route name `/sync`, merge-bundle terms, and portable usage snapshots
are expected and must not be removed by a broad text replacement.

### STOP conditions

- Guards are added before deletion and therefore encode a knowingly invalid
  graph.
- Current docs are changed to hide historical facts in audit/plan artifacts.
- A broad rename damages the supported `/sync` file route or snapshot format.
- Full verification is flaky or failing without a documented root cause and a
  separate owner.

## Commit strategy

Use narrow commits that correspond to verifiable outcomes. Suggested sequence:

1. `test: characterize audit remediation invariants`
2. `fix(web): make production runtime local and path-stable`
3. `refactor(cli): remove legacy LAN snapshot sync`
4. `fix(snapshot): bound and validate snapshot files`
5. `refactor(skills): query local project sources directly`
6. `test(skills): exercise the production server adapter`
7. `perf(web): lazy-mount dashboard analysis surfaces`
8. `perf(store): batch merge import lookups`
9. `refactor(web): extract time-range interaction state`
10. `fix(web): remove buffered report runner payload ceiling`
11. `perf(web): refresh reports through revisioned queries`
12. `chore: enforce boundaries and reconcile documentation`

Do not mix generated Panda output or unrelated formatting into these commits.
Run `bun x ultracite fix` only on intentional code changes and inspect its diff
before committing.

## Completion criteria

Plan 008 is DONE only when all of the following are true:

- [x] The supported production command binds only to loopback.
- [x] Production `/` and `/skills` return 200 in CI after a real build.
- [x] The `setup` UI binds only to loopback.
- [x] Host/Origin/fetch-site guards reject DNS rebinding and cross-site reads or
      mutations; setup bodies are content-type/schema/size bounded.
- [x] `packages/sync`, CLI network commands/options, sync-storage, and active
      sync config types are absent.
- [x] File snapshot, merge, project-list, setup, and web `/sync` workflows pass.
- [x] Current snapshot output round-trips through strict validation.
- [x] Oversized, symlinked, malformed, or forged snapshot files fail atomically.
- [x] `/skills` does not build a complete report for known project paths.
- [x] Real Skills server mutations pass against isolated temporary storage.
- [x] Closed Advanced analysis has no chart DOM.
- [x] Only one Sessions surface is mounted for the current viewport; print is a
      usable table.
- [x] Multi-batch SQLite imports preserve rows/counters/rollback, meet the
      frozen query-count budget, and have no wall-time regression beyond any
      tolerance fixed in Wave 0.
- [x] Time-range pure transitions cover pointer, keyboard, cancel, zoom, domain,
      and URL-commit invariants.
- [x] No 64 MiB child-stdout ceiling or equivalent unbounded disk/memory
      buffering remains; the replacement artifact ceiling is explicit/tested.
- [x] Served refresh uses immutable retained revisions, exact-revision requests,
      request fingerprints, focused queries, and bounded Sessions cursors.
- [x] Campaign expansion, drawer neighbors, and full CSV/HTML exports preserve
      full-result semantics across Sessions pages.
- [x] Browser automation opens static HTML under `file://`, exercises it, and
      observes no network/dynamic assets or runtime errors.
- [x] Retired-package and web-boundary fixtures fail as designed.
- [x] Current docs and package interfaces match the implemented graph.
- [x] Ultracite, lint, typecheck, unit/integration tests, build, production
      and setup listener smokes, tool fixtures, Playwright, HTML-export
      integration, and `file://` browser smoke all pass.
- [x] The execution log records baseline/final measurements and any justified
      deviations from this plan.

## Explicitly deferred product direction

These audit ideas are valuable but require their own product/data decisions and
are not completion blockers for plan 008:

1. **Versioned pricing provenance**: store which pricing table/version produced
   a historical cost and define reprice behavior before exposing comparisons.
2. **Quota history**: persist quota snapshots over time before building forecast
   or exhaustion views; current newest-snapshot display is not a history model.
3. **Yearly Wrapped**: define stable annual semantics and privacy/export rules
   after report query contracts settle.
4. **Manual transfer inbox**: improve the file-only `/sync` experience with
   clearer preview/history/reconciliation, without restoring listeners,
   remotes, discovery, polling, or credentials.

## Maintenance notes

- If a STOP condition is hit, mark plan 008 BLOCKED in `plans/README.md` with a
  one-line reason and capture evidence in the execution log. Do not improvise a
  product or security decision.
- If a later wave is deliberately deferred into another plan, update the
  findings matrix with the new plan number and leave 008 IN PROGRESS until the
  dependency is accepted; do not silently mark the finding done.
- When implementation finishes, stamp the final commit/date, change Status to
  DONE, link the execution log, and update `plans/README.md`.
