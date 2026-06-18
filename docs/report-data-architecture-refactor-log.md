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

- Pending.
