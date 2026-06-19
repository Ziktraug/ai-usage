# Report Data Architecture Refactor Plan

## Problem Statement

The report app is drifting toward two overlapping data paths:

- A dev-only Vite middleware executes the CLI with `--payload-json` and serves one global report payload.
- A TanStack Start server function already collects local history directly, but it still returns the same global payload shape.

This creates architectural pressure in the wrong direction. The CLI is an adapter for terminal output, not the source of truth for report data. The web app should depend on shared reporting capabilities, not on a CLI process. The global payload also forces every harness, facet, row, and analytics calculation to be generated together, which prevents progressive loading, partial failures, fine-grained caching, and independent performance tuning.

## Target Architecture

Use a shared reporting layer as the only application-facing report data boundary.

```txt
packages/local-collectors
  -> reads local history per harness

packages/report-core
  -> normalizes usage rows, filters, analytics, payload serialization

packages/report-data
  -> orchestrates report queries with Effect
  -> exposes coarse compatibility payload and fine-grained query functions

apps/cli
  -> parses CLI args
  -> calls packages/report-data
  -> renders table/csv/json/html/payload

apps/web
  -> serverFns call packages/report-data
  -> UI consumes serverFns through TanStack Query-compatible resources
```

The CLI can keep a one-shot command UX. That one-shot behavior should be a facade over shared query/orchestration functions, not an implementation that the web app shells out to.

## Current State Observed

- `apps/web/vite.config.ts` has a dev payload middleware that executes `apps/cli/src/main.ts --payload-json`.
- `apps/web/src/server/report-payload.server.ts` already uses `Effect`, `collectSelectedHarnessRows`, `collectHarnessFacets`, `prepareUsageReport`, and `createUsageReportPayload` directly.
- `packages/local-collectors/src/collectors/index.ts` already has `HARNESS_ADAPTERS`, `selectedHarnessAdapters`, and parallel `Effect.all(..., { concurrency: 'unbounded' })` collection.
- `apps/cli/src/main.ts` duplicates report collection orchestration for normal reports, snapshots, merge local rows, projects list, and payload/html facets.
- `packages/report-core/src/report-data.ts` owns filtering, sorting, row serialization, analytics, and the current global payload shape.

## Refactor Strategy

Do this as incremental, always-working commits. Preserve the current global payload until fine-grained server functions exist and the UI has moved to them. Do not rewrite the dashboard first.

The first milestone removes `web -> cli`. Later milestones split the global payload into queryable slices.

## Commit Plan

### Commit 1: Add shared report request types

Create shared report query/request types near the existing reporting domain. Include the current filter fields: harness selection, cursor inclusion, project filter, date filter, min tokens, limit, sort, keep-source behavior, and cursor CSV config passthrough.

Acceptance criteria:

- Existing CLI args can be mapped into the shared request type without losing behavior.
- Existing report app defaults can be expressed as the shared request type.
- No runtime behavior changes.

Suggested checks:

- `bun run check`
- Existing CLI parser tests still pass.

### Commit 2: Extract shared row collection orchestration

Move the repeated local report collection flow into a shared reporting API. It should read merged config, collect selected harness rows, apply project aliases, and provide local history storage through Effect at the application boundary.

The API should expose an Effect-level function for composition and a Promise-level runner for adapters that do not want to expose Effect.

Acceptance criteria:

- CLI and report app can call the same row collection function.
- Project aliases are applied exactly once.
- Cursor CSV reconciliation config still flows from machine config.
- No UI changes.

Suggested checks:

- Add or update a test that proves aliases are applied by the shared path.
- `bun run check`
- `bun test packages/local-collectors/src/db-collectors.test.ts`

### Commit 3: Extract shared global payload generation

Add a compatibility function that returns the current `UsageReportPayload`. It should call the shared row collection function, collect facets when required, prepare the report, and serialize the payload.

Acceptance criteria:

- The returned payload matches the current shape.
- `generatedAt`, `filters`, `rows`, `tableRows`, `omittedRows`, `analytics`, and `facets` remain compatible.
- This function becomes the only place that composes collected rows into the global report payload.

Suggested checks:

- Add a unit test with fixture rows around `createUsageReportPayload` or the new compatibility function.
- `bun run check`
- `bun test apps/cli/src/report.test.ts`

### Commit 4: Move CLI report commands onto shared reporting

Update the CLI path for table, CSV, JSON, HTML, and `--payload-json` to call the shared compatibility function or the shared row collection function as appropriate.

Keep terminal rendering in `apps/cli`; only move data generation out.

Acceptance criteria:

- CLI still supports all current output formats.
- `--payload-json` still writes the same global payload shape.
- HTML export still embeds the same payload shape.
- CLI rendering modules do not import local collectors directly unless they only render provided data.

Suggested checks:

- `bun test apps/cli/src/cli.test.ts apps/cli/src/report.test.ts`
- Smoke command: `bun cli --payload-json` and validate JSON parses.

### Commit 5: Move report app server function onto shared reporting

Replace report-app-specific collection code with the shared compatibility payload function.

Acceptance criteria:

- `getReportPayload` still returns a JSON-serializable payload.
- The report app server function does not duplicate config read, collector orchestration, alias application, or facet collection.
- The report app does not import CLI modules.

Suggested checks:

- `bun run --cwd apps/web check`
- Start Vite and confirm the dashboard loads.

### Commit 6: Remove dev middleware CLI execution from Vite config

Remove the Vite middleware that shells out to `bun apps/cli/src/main.ts --payload-json`. In dev, the report app should fetch through its server function path instead.

Acceptance criteria:

- `apps/web/vite.config.ts` no longer imports `node:child_process` for report payload data.
- `apps/web/vite.config.ts` no longer references `apps/cli/src/main.ts`.
- Dev refresh still works through the server function.
- The only remaining Vite plugins are framework/build plumbing and unavoidable Vite workarounds.

Suggested checks:

- `bun run --cwd apps/web check`
- `bun dev`
- Confirm there is no `react/jsx-dev-runtime` dependency scan failure.

### Commit 7: Introduce harness-level collection results

Extend the collector orchestration so each harness can return a result envelope instead of only a flat row array. The envelope should include harness key, status, rows, duration, optional error, and optional warnings.

Keep the current flat collection API as a compatibility wrapper over the new harness-level API.

Acceptance criteria:

- Existing CLI and payload behavior remains unchanged.
- New harness-level API can represent partial failure without losing successful harness rows.
- Cursor CSV reconciliation remains attached to the cursor harness path.
- Effects still run in parallel where safe.

Suggested checks:

- Add tests for one failing harness plus one successful harness.
- `bun test packages/local-collectors/src/db-collectors.test.ts`
- `bun run check`

### Commit 8: Add fine-grained reporting query functions

Add shared functions for queryable report slices:

- harness status summary
- usage rows for a request
- analytics for a request
- facets/quota snapshots
- project/source summaries

These functions should share collection/caching boundaries where possible but remain callable independently.

Acceptance criteria:

- Each function has a clear input and output type.
- Each function can be called without building the whole global payload unless it explicitly needs all rows.
- The old compatibility payload can be implemented by composing these functions.

Suggested checks:

- Add unit tests for filters and analytics parity between the global payload and fine-grained functions.
- `bun test packages/report-core/src/analytics.test.ts`
- `bun run check`

### Commit 9: Add fine-grained server functions

Expose the new reporting query functions through TanStack Start server functions. Keep the current `getReportPayload` server function during migration.

Acceptance criteria:

- Server functions are serializable at the boundary.
- Server functions do not leak Effect services or collector internals to the client.
- Errors are represented as typed, UI-consumable states where partial failure is expected.

Suggested checks:

- `bun run --cwd apps/web check`
- Add a small server function serialization test if the repo has a suitable seam.

### Commit 10: Move report UI data loading to fine-grained queries

Change the report app from one global payload signal to independently loaded slices. Use the existing TanStack/Solid data patterns in the app. If TanStack Query is introduced or already present, use query keys that include request filters and harness scope.

Acceptance criteria:

- The dashboard can render progressively as data arrives.
- One harness failure does not prevent successful harness data from rendering.
- Refresh invalidates the relevant query keys, not the entire app by default.
- Export actions can still request or compose a full payload when needed.

Suggested checks:

- `bun run --cwd apps/web check`
- Browser smoke test for initial load, refresh, filter changes, and export.

### Commit 11: Retire global payload from interactive web flow

Keep `UsageReportPayload` for CLI `--payload-json` and static HTML export, but stop using it as the primary interactive web data model.

Acceptance criteria:

- Interactive report app uses fine-grained server functions.
- Static HTML export still works without a server.
- Demo payload fallback remains only where static/offline rendering needs it.

Suggested checks:

- `bun run --cwd apps/web check`
- `bun test apps/web/src/report-data.test.ts`
- Generate HTML and open it locally if the repo has an existing command for that flow.

### Commit 12: Cleanup and documentation

Remove obsolete compatibility paths that are no longer needed by CLI, report app, or static export. Document the new data architecture in the domain language.

Acceptance criteria:

- No `apps/web -> apps/cli` dependency remains.
- No duplicate collector orchestration remains in app adapters.
- Documentation explains which layer owns local history collection, report orchestration, rendering, and server functions.

Suggested checks:

- `bun run check`
- `bun test`
- Search for `payload-json`, `apps/cli/src/main.ts`, and `collectSelectedHarnessRows` to verify imports are only in intended layers.

## Decisions

- The CLI remains a terminal adapter and may keep one-shot user commands.
- The report app must not execute the CLI or depend on CLI source files.
- The global `UsageReportPayload` remains as a compatibility/export format until the web app has moved to fine-grained server functions.
- Local history remains the only report input; provider APIs are still out of scope.
- Effect owns collector orchestration, parallelism, dependency provisioning, and partial failure modeling.
- TanStack Start server functions own the web boundary and must return JSON-serializable data.
- TanStack Query-style caching should be keyed by request filters and harness scope, not by one global payload.

## Testing Decisions

- Preserve behavior first: the initial extraction commits should compare old and new payload shapes using fixture rows rather than live local history.
- Collector tests should stay close to `packages/local-collectors` and cover partial harness failure once result envelopes exist.
- Report-data tests should assert analytics/filtering/export shape parity between the compatibility payload and fine-grained functions.
- CLI tests should assert output format contracts, not collector implementation details.
- Report app tests should focus on server function serialization, refresh behavior, and progressive data states where test seams exist.

## Out Of Scope

- Changing the normalized Usage row schema unless a fine-grained API requires an additive field.
- Replacing TanStack Start or Nitro.
- Calling provider APIs.
- Rewriting the dashboard visual design.
- Removing static HTML export.
- Persisting a new database/cache layer before the server function query boundaries exist.

## First Pick Recommendation

Start with commits 1 through 6 as a single focused milestone: remove `web -> cli` while preserving the global payload behavior. That milestone is small enough to pick in one implementation session and leaves the product behavior unchanged.

Do not start commits 7 through 12 until the compatibility milestone is merged or otherwise stable. Those commits change the data-loading model and should be reviewed as an architecture migration, not a cleanup.
