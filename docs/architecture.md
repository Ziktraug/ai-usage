# Architecture

`ai-usage` reports usage from local history only. Provider APIs are not called. The main architecture rule is that collection, normalization, reporting, and output adapters stay behind separate package seams.

## Data Flow

1. Harness local history is read by `@ai-usage/local-collectors`.
2. Collector adapters emit collected sessions or collected usage rows with local provenance.
3. `@ai-usage/report-core` normalizes usage rows, computes derived row values, analytics, report payloads, and usage snapshots.
4. `@ai-usage/report-data` orchestrates local history collection, project aliases, warnings, usage snapshots, and report payload creation.
5. `@ai-usage/sync` owns snapshot transport and sync workflow modules that can be used by both app adapters.
6. `@ai-usage/usage-store` persists normalized local rows and rows imported from merge bundle files.
7. `@ai-usage/usage-merge` orchestrates explicit merge bundle export and file import over the store.
8. `apps/cli` and `apps/web` render the shared data through their own output adapters.

## Package Ownership

### `@ai-usage/report-core`

Owns pure domain data and deterministic calculations:

- usage row and provenance types;
- row derivations such as active dates, token totals, line deltas, and cost approximation helpers;
- pricing, analytics, project aliases, report payload serialization, and usage snapshot parsing/creation;
- static report HTML inlining primitives.

`@ai-usage/report-core` must not read local history, the filesystem, SQLite, browser globals, or app runtime state.

### `@ai-usage/local-collectors`

Owns local history adapters:

- Claude, Codex, OpenCode, Cursor, Cursor CSV reconciliation, and RTK enrichment;
- machine identity and user-local config reading;
- local history warnings and errors;
- the collected session seam before rows become normalized usage rows.

This is the package allowed to know where harnesses store local history. It should not render CLI/UI output.

### `@ai-usage/report-data`

Owns application-facing report orchestration:

- local report row collection requests;
- project alias application;
- partial local history warnings;
- compatibility `UsageReportPayload` creation;
- usage snapshot and merge assembly.

Apps should prefer this package over reaching into collectors directly. The known exception is the CLI quota path, which reads the newest Codex quota snapshot through the public `@ai-usage/local-collectors/codex-history` export.

### `@ai-usage/sync`

Owns application-facing sync modules:

- snapshot file and HTTP transport;
- snapshot endpoint health checks;
- sync workflow and UI-consumable sync state;
- LAN snapshot server protocol, Bun and Node server adapters, and discovery.

Apps should use this package for sync behavior instead of owning transport, auth, parsing, or remote status logic.

### `@ai-usage/usage-store`

Owns durable usage facts and merge bundle persistence:

- SQLite schema and migrations;
- normalized local row import;
- validated merge bundle import and export;
- active report-row queries with corrupt-row isolation.

The store does not collect local history, choose files, render import progress, or orchestrate app workflows.

### `@ai-usage/usage-merge`

Owns application-facing file transfer workflows:

- exporting this machine's usage as a portable merge bundle with a suggested filename;
- parsing and importing a merge bundle copied from another machine;
- translating store failures into typed, JSON-safe operation results.

Merge actions are explicit and file-based. This package does not discover peers, open a LAN listener, exchange credentials, or render UI.

### `@ai-usage/skills`

Owns the native skill-management control plane exposed through `/skills`:

- skill-management config types and runtime validation;
- JSON-only source repository state parsing and persistence;
- source skill scans, `SKILL.md` validation, token diagnostics, and scanner limits;
- agent-runtime target scans, projection planning/apply, and mutation safety checks;
- workflow functions that compose config, source state, source scans, target observations, and diagnostics.

User-local skill configuration lives under `~/.config/ai-usage/config.json` through the existing ai-usage config path. Portable source repository state lives in the configured source repository as JSON data, not executable TypeScript.

Skill inventory is local-machine scoped. This package must not use synced or manually imported rows, snapshots from other machines, or remote machine ids to decide which repositories to scan. Repository discovery can use explicit config and locally observed project paths, but broad root scans must be opt-in and no personal directory convention such as `~/Projects` may become a default.

### `apps/cli`

Owns terminal and file output adapters:

- CLI argument parsing;
- terminal table, CSV, JSON, payload JSON, HTML export rendering;
- machine/setup/project-source commands;
- serve and quota commands.

The CLI calls `@ai-usage/report-data` for report data. It should not be called by the report app.

### `apps/web`

Owns web runtime and UI:

- TanStack Start server functions and Bun subprocess boundary for local collection under Nitro;
- report payload runtime/bootstrap/refresh;
- file-based merge bundle import/export on `/sync`, including bounded local upload handling;
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
- Report orchestration lives in `@ai-usage/report-data`.
- Sync transport and workflow modules live in `@ai-usage/sync`.
- Durable normalized usage rows and merge bundle persistence live in `@ai-usage/usage-store`.
- Manual merge bundle file import/export workflows live in `@ai-usage/usage-merge`.
- Skill management domain, scanning, diagnostics, workflows, and projection safety live in `@ai-usage/skills`.
- CLI renderers live in `apps/cli`.
- Web server functions, browser output adapters, and the `/skills` UI route live in `apps/web`.
- Design-system exports are consumed through package exports, never through relative package paths.

## Guardrails

- Cross-package imports must use package exports documented in `docs/public-package-interfaces.md`.
- Relative workspace paths such as `../../packages/...` and `../apps/...` are forbidden.
- Private package paths such as `@ai-usage/report-core/src/...` are forbidden.
- Package graph boundaries for file-based merge are enforced by scoped Biome restricted-import rules and `tools/check-package-boundaries.ts`.
- The package graph policy follows the ownership READMEs in each app/package directory.
- `bun run lint` runs Biome restricted-import rules, `tools/check-workspace-relative-paths.ts`, `tools/check-public-package-exports.ts`, and `tools/check-package-boundaries.ts`.
