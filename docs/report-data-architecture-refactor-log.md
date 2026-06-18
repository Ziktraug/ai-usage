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

- Pending.
