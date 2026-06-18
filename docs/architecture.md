# Architecture

`ai-usage` reports usage from local history only. Provider APIs are not called. The main architecture rule is that collection, normalization, reporting, and output adapters stay behind separate package seams.

## Data Flow

1. Harness local history is read by `@ai-usage/local-collectors`.
2. Collector adapters emit collected sessions or collected usage rows with local provenance.
3. `@ai-usage/core` normalizes usage rows, computes derived row values, analytics, report payloads, and usage snapshots.
4. `@ai-usage/reporting` orchestrates local history collection, project aliases, warnings, usage snapshots, and report payload creation.
5. `apps/cli` and `apps/report` render the shared data through their own output adapters.

## Package Ownership

### `@ai-usage/core`

Owns pure domain data and deterministic calculations:

- usage row and provenance types;
- row derivations such as active dates, token totals, line deltas, and cost approximation helpers;
- pricing, analytics, project aliases, report payload serialization, and usage snapshot parsing/creation;
- static report HTML inlining primitives.

`@ai-usage/core` must not read local history, the filesystem, SQLite, browser globals, or app runtime state.

### `@ai-usage/local-collectors`

Owns local history adapters:

- Claude, Codex, OpenCode, Cursor, Cursor CSV reconciliation, and RTK enrichment;
- machine identity and user-local config reading;
- local history warnings and errors;
- the collected session seam before rows become normalized usage rows.

This is the package allowed to know where harnesses store local history. It should not render CLI/UI output.

### `@ai-usage/reporting`

Owns application-facing report orchestration:

- local report row collection requests;
- project alias application;
- partial local history warnings;
- compatibility `UsageReportPayload` creation;
- usage snapshot and merge assembly.

Apps should prefer this package over reaching into collectors directly. The known exception is the CLI quota path, which reads the newest Codex quota snapshot through the public `@ai-usage/local-collectors/codex-history` export.

### `apps/cli`

Owns terminal and file output adapters:

- CLI argument parsing;
- terminal table, CSV, JSON, payload JSON, HTML export rendering;
- machine/setup/project-source commands;
- serve and quota commands.

The CLI calls `@ai-usage/reporting` for report data. It should not be called by the report app.

### `apps/report`

Owns web runtime and UI:

- TanStack Start server functions and Bun subprocess boundary for local collection under Nitro;
- report payload runtime/bootstrap/refresh;
- dashboard, overview, table schema, and UI model modules;
- browser CSV/HTML export adapters.

Client-visible modules must not import `*.server.*`. Shared calculations should live in small model modules such as `dashboard-model.ts`, `overview-model.ts`, and `session-table-schema.ts`.

### `@ai-usage/design-system`

Owns reusable Panda/Solid primitives and report-specific style slots:

- root export for generic primitives;
- `./report` export for report UI classes/slots;
- `./preset`, `./css`, `./styles.css`, and `./panda.buildinfo.json` for Panda consumers.

See `docs/generated-tooling-ownership.md` for generated Panda/TanStack/Nitro ownership.

## Adapter Rules

- Local history adapters live in `@ai-usage/local-collectors`.
- Report orchestration lives in `@ai-usage/reporting`.
- CLI renderers live in `apps/cli`.
- Web server functions and browser output adapters live in `apps/report`.
- Design-system exports are consumed through package exports, never through relative package paths.

## Guardrails

- Cross-package imports must use package exports documented in `docs/public-package-interfaces.md`.
- Relative workspace paths such as `../../packages/...` and `../apps/...` are forbidden.
- Private package paths such as `@ai-usage/core/src/...` are forbidden.
- `bun run lint` runs Biome restricted-import rules, `tools/check-workspace-relative-paths.ts`, and `tools/check-public-package-exports.ts`.
