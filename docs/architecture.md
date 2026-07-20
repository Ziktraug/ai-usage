# Architecture

`ai-usage` reports session usage from local history only. The served Codex quota-history feature is the narrow exception: it invokes the installed Codex CLI's supported local app-server interface, leaving provider communication and authentication inside Codex. `ai-usage` does not read credentials or call private provider HTTP endpoints. The main architecture rule is that collection, normalization, reporting, and output adapters stay behind separate package seams.

## Data Flow

1. Seven autonomous adapters detect their own local inputs and persist normalized contributions through `@ai-usage/usage-store`.
2. The scoped `@ai-usage/report-data/source-control` Effect service applies home-only policy, bounded queueing, dependency ordering, cadence, timeout, progress, and publication rules.
3. A separate stored-only publication job acknowledges monotonic request/data generations only after it assembles and commits one immutable semantic report revision.
4. `@ai-usage/report-core` supplies pure normalization, analytics, portable
   schema-v3 formats, bounded session VCS contracts, strictly decoded
   source-control snapshots/events/command responses, and request-fingerprinted
   report-query contracts.
5. `@ai-usage/usage-merge` performs explicit merge-bundle export/import; successful mutations request publication without invoking collectors.
6. The CLI uses timer-free report-data one-shot application ports and complete compatibility payloads. The served app loads exact-revision focused projections after hydration and receives operational snapshots plus explicit publication events through one SSE connection.

Codex quota history is owned by the `codex.usage-limits` source: app-server collection and rollout backfill emit provider-neutral observation batches that are imported transactionally. One Effect-native single flight owns query, collection, import/checkpoint, attempt recording, and final projection in the scheduler fiber. Joiners await its Deferred without owning cancellation; owner interruption aborts the provider child and prevents any later durable phase from starting. A synchronous SQLite transaction that has begun remains atomic, and timeout cannot become observable until it returns. The web app reads stored history through a dedicated bounded query only when the drawer is open. History is not part of `UsageReportPayload`, report revisions, snapshots, or merge bundles.

## Package Ownership

### `@ai-usage/report-core`

Owns pure domain data and deterministic calculations:

- usage row, provenance, and bounded credential-free session VCS types;
- row derivations such as active dates, token totals, line deltas, and cost approximation helpers;
- pricing, analytics, project aliases, strict report-query requests and results, report payload serialization, and usage snapshot parsing/creation.

`@ai-usage/report-core` must not read local history, the filesystem, SQLite, browser globals, or app runtime state.

### `@ai-usage/local-collectors`

Owns local history adapters:

- Claude, Codex, OpenCode, Cursor, Cursor CSV reconciliation, and RTK enrichment;
- machine identity and user-local config reading;
- local history warnings and errors;
- the collected session seam before rows become normalized usage rows;
- the Codex app-server batch adapter and bounded incremental rollout quota backfill, both producing normalized provider-quota observations.

OpenCode's report collector and bounded detail reader keep their SQL queries
separate, but decode messages and derive tokens, model attribution, costs,
activity intervals, parent kinds, turns, and tools through one shared internal
session-facts module. The report projection and local detail therefore do not
maintain competing semantic implementations.

Claude follows the same semantic-ownership rule. One pure session-facts parser
owns direct-prompt classification, assistant deduplication, models, token
buckets, tools, lineage, recorded turn durations, branch spans, and recorded
pull requests. The report collector and bounded exact-session detail reader
consume that parser instead of maintaining parallel interpretations. Session
span remains separate from recorded turn activity, and effort is unavailable.

History files are read through explicit byte/file/depth budgets, no-follow regular-file checks, strict UTF-8 decoding, and WAL-aware SQLite snapshots. Usage-bearing values are validated as finite, non-negative runtime data before aggregation. Private ai-usage state is owner-only; harness-owned files are never chmodded.

This is the package allowed to know where harnesses store local history. It should not render CLI/UI output.

### `@ai-usage/report-data`

Owns application-facing report orchestration:

- local report row collection requests;
- project alias application;
- partial local history warnings;
- focused stored-row and stored-only known-project-source request seams;
- compatibility `UsageReportPayload` creation for CLI consumers;
- usage snapshot and merge assembly.
- one pure final report assembler shared by local, stored, merged, and fresh paths.
- autonomous source adapters, source checkpoint composition, the pure source-control state machine, the bounded Effect scheduler, stored-only publication, provider-neutral latest-status projection, and bounded history queries.

Apps use this package for application workflows. CLI quota collection plus its newest durable read is one report-data operation; the CLI does not reach into `usage-store` or raw quota collectors.

### `@ai-usage/usage-store`

Owns durable usage facts and merge bundle persistence:

- SQLite schema and migrations;
- normalized producer-owned base-row import;
- versioned, row-keyed source-owned enrichment contributions, initially `rtk.savings`, composed only at report-query boundaries;
- validated merge bundle import and export;
- active report-row queries with corrupt-row isolation.
- local-observed versus portable-opaque source authority and semantic generation changes only when the active report projection changes.
- canonical preparation of every local/peer/preview/confirm merge row: portable embedded RTK fields are split into a hash-recomputed base row plus a validated `rtk.savings` contribution in the same import transaction, without rewriting historical rows or changing the wire format.
- normalized append-only provider-quota observations/windows, duplicate coalescing, coverage heartbeats, source-event idempotency, and atomic source checkpoints.

The store does not collect local history, choose files, render import progress, or orchestrate app workflows.

### `@ai-usage/usage-merge`

Owns application-facing file transfer workflows:

- exporting this machine's usage as a portable merge bundle with a suggested filename;
- parsing and importing a merge bundle copied from another machine;
- exact row/byte preflight and a preview/confirm token bound to the current store generation;
- translating store failures into typed, JSON-safe operation results.

Merge actions are explicit and file-based. This package does not discover peers, open a LAN listener, exchange credentials, or render UI.

### `@ai-usage/skills`

Owns the native skill-management control plane exposed through `/skills`:

- skill-management config types and runtime validation;
- JSON-only source repository state parsing and persistence;
- source skill scans, `SKILL.md` validation, token diagnostics, and scanner limits;
- agent-runtime target scans, projection planning/apply, and mutation safety checks;
- a deep application facade that composes config, source state, source scans, target observations, and diagnostics.

Projection actions capture the non-symlink target's canonical/device/inode identity and revalidate it under a cross-process lock. Target creation walks and validates each component instead of recursively creating an unobserved tree. Portable Node APIs narrow common races but do not claim universal protection from a hostile same-UID actor inside every syscall window.

The package root is an explicit stable facade. Internally, contracts/config,
filesystem safety, source state, source and project scans, Markdown IO,
projections, and application workflows are separate modules. Internal modules
depend on those narrow seams rather than importing the package facade.

User-local skill configuration lives under `~/.config/ai-usage/config.json` through the existing ai-usage config path. Portable source repository state lives in the configured source repository as JSON data, not executable TypeScript.

Skill inventory is local-machine scoped. This package must not use manually imported rows, snapshots from other machines, or non-local machine ids to decide which repositories to scan. Repository discovery uses explicit config and one focused query of locally observed project paths; it does not create a complete report payload. Broad root scans must be opt-in and no personal directory convention such as `~/Projects` may become a default.

### `apps/cli`

Owns terminal and file output adapters:

- CLI argument parsing;
- terminal table, CSV, JSON, and payload JSON rendering;
- machine/setup/project-source commands;
- bounded portable snapshot files and the quota command.

The CLI calls `@ai-usage/report-data` for report data. It should not be called by the report app.

### `apps/web`

Owns web runtime and UI:

- the official Nitro Bun preset and one scoped in-process source-control runtime;
- direct source adapters and SQLite access, with no generic collection subprocess;
- trusted-local source commands and a sanitized bounded SSE replacement stream;
- immutable report revision manifests, read-only SQLite materializations, and exact-revision focused-result adapters;
- exact-revision Overview, Breakdown, support, Session page, campaign-child, neighbor, and `session-detail-anchor` queries through bounded Bun artifact runners;
- one server exact-revision lifecycle and bounded Bun artifact runners for focused query kinds;
- shared focused/Session request validation, projection, cursor, budget, and fingerprint contracts;
- file-based merge bundle import/export on `/sync`, including bounded local upload handling;
- client-first Report and Skills data reads with shell-only SSR;
- dashboard, `/sources`, overview, table schema, and UI model modules;
- bounded local Claude/Codex/OpenCode detail adapters in one unified drawer;
- an explicit session-VCS resolver separated from collection and publication.

Client-visible modules must not import `*.server.*`. Shared calculations should live in small model modules such as `dashboard-model.ts`, `overview-model.ts`, and `session-table-schema.ts`. TanStack Query owns ordinary finite Skills, project-source, and quota-history reads/mutations. Skills mutations carry discriminated domain requests through one validated browser-safe result contract rather than arbitrary closures. It intentionally does not own exact report revisions.

The browser-side served report session owns revision acquisition, canonical destination fingerprints, supersession, one expiry retry, atomic commit, and same-revision no-op detection. Server publication uses a canonical semantic capture fingerprint that excludes only observation time; unchanged forced captures retain the last good immutable revision and skip Session rematerialization.

After hydration, the served root requests a bounded support bootstrap. Filter options,
provider representative rows, provider-status records, and warnings are
admitted under the shared 512 KiB budget; the result carries exact omission
counts and the UI identifies the summary as truncated when anything is left
out. This bootstrap is not a semantic substitute for destination queries:
Overview, complete Breakdown groups, and paged Sessions/campaign/neighbor reads
execute separately against the named revision.
Omitted support metadata remains identified rather than being presented as
complete.

Collection does not depend on browser visibility. Completion-relative source cadences live in the Bun process, and successful semantic publication changes flow to the browser as a bounded `report-published` SSE event alongside replacement snapshots. Reconnect begins from a strictly decoded current snapshot, so no replay log is needed. The browser reacquires only its current atomic destination; finite query invalidation remains separate from exact-revision ownership.

Each publication is atomically stored as owner-only immutable manifest, rows, support, and Session SQLite artifacts. Source authority travels beside rows only inside the private staging directory, is bound to each hashed row identity while SQLite is materialized, and is removed before publication. It is neither a public payload field nor a published sidecar. Served reads name the exact revision and canonical request fingerprint. The registry bounds retention by age and count, keeps referenced revisions alive through leases, and returns typed unavailable/expired results instead of silently reading a newer revision. Project-group mutations and successful manual imports request a new stored-only publication; retained revisions do not change.

For on-demand Session Analysis, the browser supplies only the served revision
and row identity. The server resolves non-sensitive machine, harness, source
session, private source authority, and projection facts with the
`session-detail-anchor` query under the same exact-revision lease and budgets.
Only a `local-observed` anchor may be validated against the local machine and
then dereferenced into current local detail; a portable row remains opaque even
when its machine and session identifiers happen to match. The same private
authority gate applies before provider resolution. The browser supplies only
revision and row identity, never machine, source session, repository, remote,
branch, or path authority. Paths and prompt bodies are neither anchor fields
nor comparison inputs.

Session VCS facts live on `UsageRowSource.vcs`, pass strict per-field and total
budgets, and contain no credentials or filesystem paths. Portable snapshots and
merge bundles write schema version 3 and preserve those display facts while
changing source authority to `portable-opaque`; v1/v2 readers migrate with VCS
absent. VCS affects semantic content hashes but not `sessionRowIdentity`.

Provider resolution is neither a collector nor a publication step. After an
explicit user action, the server re-resolves the exact revision anchor and may
invoke `gh` with a fixed argument vector, no shell, timeout, output cap, strict
GitHub URL validation, and sanitized typed failures. Provider stderr and
resolved URLs are never persisted or included in portable formats.

## Source control invariants

- Stable sources are `claude.sessions`, `codex.sessions`, `opencode.sessions`, `cursor.sessions`, `codex.usage-limits`, `rtk.savings`, and `cursor.commit-attribution`.
- Sparse `sourcePolicies` overrides are read only from the user-home config. Repository config cannot authorize background work or provider communication.
- Policy, availability, lifecycle, last outcome, and progress are independent axes. Disabled does not mean unavailable, and failed does not mean disabled.
- The queue is finite, one worker is the default, RTK waits for session producers, and publication has one runtime owner. Pure transitions in `source-control-state.ts` own admission, detection, policy, source completion, RTK, and publication generations; the Effect runtime only applies them atomically and interprets their decisions. Queue deduplication is separate from monotonic request/data demand, so a request arriving during publication produces a successor attempt.
- Every picked source owns an `AbortController`. Timeout and runtime shutdown reach the provider/child-process boundary and cancellation is checked before every durable phase; disabling after pick does not abort the run.
- Runtime state is ephemeral. Normalized contributions, policy, source checkpoints, and semantic store generation are durable.
- Disable, missing/unreadable input, unsupported platform, empty output, failure, redetection, and restart preserve prior contributions. There is no source delete command.
- SSE snapshots and publication events contain stable IDs, bounded messages/counts, process instance plus generation, and no paths, prompts, records, credentials, or provider responses. Browser code requires the exact seven-source catalogue, canonical labels/cadences, consistent lifecycle/generation axes, and explicit operational bounds before constructing a replacement snapshot.

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
