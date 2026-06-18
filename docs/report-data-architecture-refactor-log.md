# Report Data Architecture Refactor Log

## Goal

Move report data generation out of app adapters and into a shared reporting layer. Preserve existing behavior first, then split the global payload into finer server function/query boundaries.

## Working Rules

- Implement one small slice at a time.
- Run the narrowest meaningful checks before each commit.
- Document decisions, surprises, and follow-ups in this file before each commit.
- Keep app adapters thin: CLI renders terminal/static outputs; report app owns web server functions and UI.
- Do not remove the global payload until the interactive web flow has migrated to fine-grained queries.

## Slices

### Slice 0: Planning Baseline

Status: completed

Changes:

- Added the implementation plan for the report data architecture refactor.
- Added this tracking log.

Decisions:

- First implementation milestone is compatibility-only: remove `apps/report -> apps/cli` while keeping the current global payload contract.
- Later milestones can introduce harness-level result envelopes and fine-grained server functions.

Difficulties:

- None yet.

Checks:

- Not run; documentation-only slice.

Commit:

- `dc2d7a5 docs(report): plan data architecture refactor`

### Slice 1: Shared Reporting Package Baseline

Status: completed

Changes:

- Added `@ai-usage/reporting` as a workspace package.
- Added shared request types for local report row collection and compatibility payload generation.
- Added `collectLocalReportRows`, `createLocalReportPayload`, and `runLocalReportPayload`.
- Kept app adapters unchanged in this slice.

Decisions:

- The new package depends on `@ai-usage/core`, `@ai-usage/local-collectors`, and `effect` because it is the orchestration layer between pure report logic and local history IO.
- The first public API keeps the current global payload as a compatibility contract.
- `LocalHistoryStorageLive` is provided only by the Promise-level runner; the Effect-level function stays composable.

Difficulties:

- `HarnessKey` is exported by `@ai-usage/core/harness-metadata`, not `@ai-usage/core/types`.

Checks:

- `bun run --cwd packages/reporting check`

Commit:

- `68ff987 refactor(report): add shared reporting package`

### Slice 2: Move Main CLI Report Path To Shared Reporting

Status: completed

Changes:

- Added `@ai-usage/reporting` as a CLI dependency.
- Updated the main CLI report path to call `collectLocalReportRows` for table/csv/json output.
- Updated the main CLI `html` and `payload` output path to call `createLocalReportPayload`.
- Added `renderUsagePayloadForCli` so CLI rendering remains inside the CLI app.

Decisions:

- Snapshot, merge, project discovery, setup, serve, and quota commands stay unchanged in this slice because they are not the main report payload path.
- The CLI composes shared reporting Effects with `yield*`; it does not run nested Effect runtimes.
- HTML export rendering stays in the CLI because it is an output adapter concern.

Difficulties:

- The first implementation attempted nested `Effect.runPromise`; that would bypass the CLI-provided services. It was corrected to direct Effect composition.

Checks:

- `bun run --cwd apps/cli check`
- `bun test apps/cli/src/cli.test.ts apps/cli/src/report.test.ts`

Commit:

- `61d59e3 refactor(cli): use shared reporting path`

### Slice 3: Move Report Server Payload To Shared Reporting

Status: completed

Changes:

- Added `@ai-usage/reporting` as a report app dependency.
- Replaced report-app-specific local history collection, alias application, facet collection, and payload generation with `createLocalReportPayload`.
- Kept the existing `collectReportPayload` and `runReportPayloadCollection` exports so the server function boundary remains stable.

Decisions:

- The report app still requests the compatibility global payload for now.
- The report app owns only its default request shape; shared reporting owns how that request is fulfilled.

Difficulties:

- None in this slice.

Checks:

- `bun run --cwd apps/report check`

Commit:

- `676c2c1 refactor(report): use shared reporting payload`

### Slice 4: Remove Report Dev CLI Middleware

Status: completed

Changes:

- Removed the Vite dev middleware that executed `bun apps/cli/src/main.ts --payload-json`.
- Changed `fetchReportPayload` to call the TanStack Start server function instead of fetching `/__ai_usage_report_payload`.
- Kept the Vite Solid dependency-scan workaround because it addresses the Vite 8/Rolldown JSX scan issue independently of report data architecture.

Decisions:

- The dev refresh path now goes through the same report server function as the app server boundary.
- The `force` option remains accepted by `fetchReportPayload` for caller compatibility, but it is currently ignored because the server function does a fresh collection per call.

Difficulties:

- None in this slice.

Checks:

- `bun run --cwd apps/report check`
- `bun --cwd apps/report vite --host 127.0.0.1 --port 4317 --strictPort --clearScreen false` stopped by timeout after successful startup.
- Searched `apps/report` for `__ai_usage_report_payload`, `payload-json`, `apps/cli/src/main`, `execFile`, and `child_process`; no matches.

Commit:

- `29bd1b0 refactor(report): refresh payload via server function`

### Slice 5: Milestone Verification And Test Stabilization

Status: completed

Changes:

- Added a reporting package test so the workspace `test` task has a real test file for `@ai-usage/reporting`.
- Changed `fetchReportPayload` to import the server function lazily so `report-data` can still be imported by server-side tests and static/demo payload paths.

Decisions:

- The dynamic import is intentionally limited to the client refresh path. A top-level server function import loaded TanStack client-only code during server-side tests.
- The reporting package test uses a temporary empty home directory to validate the shared local history boundary without reading developer local history.

Difficulties:

- First `bun run test` failed because `@ai-usage/reporting` had no tests.
- After adding the package test, `apps/report` tests failed because a top-level server function import triggered Solid/TanStack client-only code on the server side.

Checks:

- `bun run --cwd packages/reporting test`
- `bun run --cwd packages/reporting check`
- `bun run --cwd apps/report test`
- `bun run test`
- `bun run check`

Commit:

- `0b34d4b test(reporting): cover shared payload boundary`

### Slice 6: Restore Repo-Relative Config For Report Server

Status: completed

Changes:

- Added `readMergedAiUsageConfigFrom(cwd)` so callers can choose which repo config directory to use.
- Added `configCwd` to shared reporting requests.
- Made the report server payload pass the repository root as `configCwd`.
- Resolved relative Cursor CSV paths against `configCwd` before collection.
- Added a reporting test that proves repo config is loaded from an explicit cwd.

Decisions:

- The CLI keeps using its invocation cwd by default.
- The report server must pass repo root explicitly because Vite/TanStack runs with `process.cwd()` inside `apps/report`.
- Relative paths from repo config should be interpreted relative to the repo config cwd, matching the old dev middleware behavior that launched the CLI from repo root.

Difficulties:

- Initial fix only loaded `ai-usage.config.ts` from repo root. Data was still missing because the Cursor CSV path inside config was relative and still resolved from `apps/report`.

Checks:

- Compared old/root payload count and report-server payload count: both `2288` rows.
- `bun run --cwd packages/reporting test`
- `bun run --cwd packages/reporting check`
- `bun run --cwd apps/report check`
- `bun run --cwd packages/local-collectors check`

Commit:

- `304924a fix(report): resolve repo config from report server`

### Slice 7: Load Real Payload In The Web Runtime

Status: completed

Changes:

- Changed the route loader to load the real report payload instead of always returning the demo payload when no static export payload exists.
- Split loader execution: server-side loaders call the report server runner directly; client-side reloads call the TanStack Start server function.
- Added `packages/reporting/src/report-payload-runner.ts` so the report server can collect local history in a Bun subprocess through the shared reporting package.
- Changed `local-history` to import `bun:sqlite` lazily from `openDatabase` rather than at module load time.

Decisions:

- Vite/Nitro's module runner cannot load `bun:sqlite`, even through the server function path, so local SQLite collection must run in a Bun subprocess for the current web runtime.
- The subprocess runs the shared reporting package, not the CLI. This preserves the architectural boundary that the report app does not depend on CLI commands.
- The global payload remains one-shot for this compatibility milestone; finer server functions remain a later slice.

Difficulties:

- First loader fix still returned a 500 because SSR called `createServerFn` from server-side code.
- Direct server-side collection then failed because the module runner rejected the `bun:` URL scheme used by `bun:sqlite`.

Checks:

- `bun run --cwd apps/report check`
- `bun run --cwd packages/reporting check`
- `bun -e '...'` against `runReportPayloadCollection`: `2288` rows.
- Vite HTTP fetch on `/`: `200`, no demo date, no error, payload present.
- `bun run check`
- `bun run test`

Commit:

- Pending.
