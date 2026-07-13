# Architecture

`ai-usage` reports usage from local history only. Provider APIs are not called. The main architecture rule is that collection, normalization, reporting, and output adapters stay behind separate package seams.

## Data Flow

1. Harness local history is read by `@ai-usage/local-collectors`.
2. Collector adapters emit collected sessions or collected usage rows with local provenance.
3. `@ai-usage/report-core` normalizes usage rows and defines deterministic analytics, portable formats, and shared report-query contracts.
4. `@ai-usage/report-data` orchestrates local collection, focused project-source reads, compatibility payloads, and usage snapshots.
5. `@ai-usage/usage-store` persists normalized local rows and rows explicitly imported from merge bundle files, then returns validated stored report rows.
6. `@ai-usage/usage-merge` orchestrates explicit merge bundle export and file import over the store.
7. `apps/cli` and `apps/web` render the shared data through their own output adapters. Static HTML and CLI export retain the complete compatibility payload; the served web app uses request-fingerprinted, exact-revision focused queries.

## Package Ownership

### `@ai-usage/report-core`

Owns pure domain data and deterministic calculations:

- usage row and provenance types;
- row derivations such as active dates, token totals, line deltas, and cost approximation helpers;
- pricing, analytics, project aliases, strict report-query requests and results, report payload serialization, and usage snapshot parsing/creation;
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
- focused local-row and known-project-source request seams;
- compatibility `UsageReportPayload` creation for CLI and static export;
- usage snapshot and merge assembly.

Apps should prefer this package over reaching into collectors directly. The known exception is the CLI quota path, which reads the newest Codex quota snapshot through the public `@ai-usage/local-collectors/codex-history` export.

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

The package root is an explicit stable facade. Internally, contracts/config,
filesystem safety, source state, source and project scans, Markdown IO,
projections, and application workflows are separate modules. Internal modules
depend on those narrow seams rather than importing the package facade.

User-local skill configuration lives under `~/.config/ai-usage/config.json` through the existing ai-usage config path. Portable source repository state lives in the configured source repository as JSON data, not executable TypeScript.

Skill inventory is local-machine scoped. This package must not use manually imported rows, snapshots from other machines, or non-local machine ids to decide which repositories to scan. Repository discovery uses explicit config and one focused query of locally observed project paths; it does not create a complete report payload. Broad root scans must be opt-in and no personal directory convention such as `~/Projects` may become a default.

### `apps/cli`

Owns terminal and file output adapters:

- CLI argument parsing;
- terminal table, CSV, JSON, payload JSON, HTML export rendering;
- machine/setup/project-source commands;
- bounded portable snapshot files and the quota command.

The CLI calls `@ai-usage/report-data` for report data. It should not be called by the report app.

### `apps/web`

Owns web runtime and UI:

- TanStack Start server functions and Bun subprocess boundary for local collection under Nitro;
- immutable report revision manifests, read-only SQLite materializations, and exact-revision focused-result adapters;
- exact-revision Overview, Breakdown, support, Session page, campaign-child, neighbor, CSV, and HTML queries through bounded Bun artifact runners;
- shared focused/Session request validation, projection, cursor, budget, and fingerprint contracts;
- a complete compatibility payload only for CLI/static-file export and an explicit served HTML download;
- file-based merge bundle import/export on `/sync`, including bounded local upload handling;
- dashboard, overview, table schema, and UI model modules;
- static-local and served exact-revision export adapters.

Client-visible modules must not import `*.server.*`. Shared calculations should live in small model modules such as `dashboard-model.ts`, `overview-model.ts`, and `session-table-schema.ts`.

The served root receives only a bounded support bootstrap. Filter options,
provider representative rows, provider-status records, and warnings are
admitted under the shared 512 KiB budget; the result carries exact omission
counts and the UI identifies the summary as truncated when anything is left
out. This bootstrap is not a semantic substitute for destination queries:
Overview, complete Breakdown groups, paged Sessions/campaign/neighbor reads,
and complete CSV/HTML exports execute separately against the named revision.
Omitted support metadata remains identified rather than being presented as
complete.

Each completed Bun capture is atomically published as owner-only immutable manifest, rows, and support artifacts. Served reads name the exact revision and canonical request fingerprint. The Node registry bounds retention by age and count, keeps referenced revisions alive through leases, and returns typed unavailable/expired results instead of silently reading a newer revision. Project-group mutations and successful manual imports invalidate only the latest pointer; retained revisions do not change.

Production and setup listeners bind only to numeric loopback. The application does not expose a LAN transport, peer discovery, or credential exchange protocol. Moving usage between machines requires a portable snapshot or merge bundle copied out of band.

### `@ai-usage/design-system`

Owns reusable Panda/Solid primitives and report-specific style slots:

- root export for generic primitives;
- `./report` export for report UI classes/slots;
- `./preset`, `./css`, `./styles.css`, and `./panda.buildinfo.json` for Panda consumers.

See `docs/generated-tooling-ownership.md` for generated Panda/TanStack/Nitro ownership.

## Adapter Rules

- Local history adapters live in `@ai-usage/local-collectors`.
- Report orchestration lives in `@ai-usage/report-data`.
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
- Package graph boundaries for file-based merge and the independent skills control plane are enforced by `tools/check-package-boundaries.ts`; Biome separately blocks private and relative workspace imports.
- The package graph policy follows the ownership READMEs in each app/package directory.
- `bun run lint` runs Biome restricted-import rules, `tools/check-workspace-relative-paths.ts`, `tools/check-public-package-exports.ts`, and `tools/check-package-boundaries.ts`.
