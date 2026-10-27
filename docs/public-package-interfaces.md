# Public package interfaces

Existing workspace packages expose only their current seams below.
Cross-package imports must use declared package exports, never private `src`
paths or relative workspace paths.

All entries describe current interfaces. Of the packages plans 101–107 added in
PR #53, only `mcp-adapter` and `mcp` remain. Plan 120 removed the connected
entries, and its phase B
([ADR 0084](adr/0084-retire-memory-checkout-resolution-and-replication.md))
removed `platform-core`, `authorization-contract`, `authorization`,
`identity`, `project-registry`, `replication-client`, `replication-outbox`,
`replication-protocol`, `memory-service`, `memory-sqlite`, and
`memory-search`, with the modules the retired Session distillation feature had
left behind.

## `@ai-usage/effect-runtime`

- `.`: domain-free schema-v2 wide-event model, process resource service,
  boundary runner, hop measurement, sanitization, tagged-error policy, and
  capture/no-op/test sinks.
- `./node`: Node console projection, bounded private NDJSON sinks, delivery
  diagnostics, log-directory resolution, cooperative locking, rotation, and
  retention.

This package imports no other `@ai-usage/*` package.

## `@ai-usage/report-core`

- `.`: stable pure-domain facade.
- `./analytics`: analytics summary and grouping.
- `./auth`: authentication/session provenance helpers.
- `./csv`: usage-row CSV serialization.
- `./codex-work-observation`: bounded local native request, acknowledgement,
  exact-answer and provenance contracts; never portable usage-row content.
- `./datasets`: typed report datasets.
- `./focused-report-query`: strict bounded support, Overview, and Breakdown
  contracts.
- `./harness-metadata`: harness keys, labels, and metadata.
- `./merge-bundle`: portable merge-bundle contracts.
- `./model-identity`: model-family/provider identity.
- `./portable-usage`: portable usage helpers.
- `./pricing`: pricing and cost approximation.
- `./project-alias`: legacy project-alias configuration.
- `./project-group`: project-group configuration and selector matching.
- `./provenance`: usage-row provenance.
- `./provider-quota`: provider-neutral quota observations/history.
- `./provider-status`: provider status windows and reset helpers.
- `./report-budgets`: frozen row/byte/query/import budgets.
- `./report-capture-fingerprint`: semantic capture fingerprinting.
- `./report-data`: serialized report payloads and preparation.
- `./session-detail-request`: lightweight canonical detail request parsing,
  fingerprint, and shared validation error, without loading response validation.
  These exports remain available through `./session-detail`.
- `./session-detail`: strict detail request, anchor, comparison, and local
  projection contracts.
- `./session-lineage`: parent/root session normalization.
- `./session-query`: strict Session paging/campaign/neighbor/cursor contracts, including full-campaign observed chronology on each bounded page item.
- `./campaign-map`: pure temporal hierarchy and bounded-member metrics for a canonical served campaign.
- `./session-vcs`: bounded credential-free repository/branch/commit/PR facts.
- `./skill-observation`: the persisted skill-observation fact, parser, producer
  completeness, and storage bounds.
- `./skill-observation-evidence`: the pure evidence policy for tier capability,
  observable harnesses, categorized loss, response clamps, and whether an
  invocation-absence claim is supportable.
- `./skill-observation-summary`: the pure fold from observations into the
  presented per-tier, per-harness dataset, preserving the nullable end-to-end
  producer-proof deadline supplied by its reader.
- `./snapshot`: portable usage snapshots.
- `./source-control`: canonical source identifiers, policies, status, command,
  and event contracts.
- `./types`: usage-row and provenance types.
- `./usage-row`: usage-row derivations.

`report-core` is pure: no filesystem, SQLite, Effect runtime, browser, or app
state.

## `@ai-usage/local-machine`

- `./campaign-label-config`: read-only campaign-label overrides for Web
  presentation after engine-owned mutations.
- `./claude-session-analysis`: bounded exact-session Claude reader.
- `./claude-session-facts`: pure Claude semantic facts.
- `./codex-session-analysis`: bounded exact-session Codex reader.
- `./codex-skill-observation`: pure Codex catalogue and `SKILL.md` read
  observation extractors.
- `./errors`: local-history error/warning contracts.
- `./history-budgets`: shared local-history budgets.
- `./internal/codex-history`: shared Codex parser/projection core for the
  collector and exact reader; application code must not use this subpath.
- `./local-git`: bounded local Git metadata helpers.
- `./local-history`: injected hardened local-history storage.
- `./machine-config`: shared machine/config read and serialized transaction
  primitives.
- `./metric-validation`: finite/non-negative usage metric validation.
- `./opencode-schema`: shared OpenCode schema contracts.
- `./opencode-session-analysis`: bounded exact-session OpenCode reader.
- `./opencode-session-facts`: pure OpenCode semantic facts.
- `./platform-paths`: supported local input locations.
- `./private-storage`: owner-only/no-follow file primitives.
- `./session-detail`: harness-dispatched exact local analysis.
- `./session-label`: safe session labels.
- `./skills-config`: field-scoped Skills config store; reads/writes only the
  `skills` field while preserving unrelated config.
- `./source-policy-config`: read-only current-machine source-policy overrides
  for server-side composition.
- `./text`: bounded text helpers.
- `./test-fixtures/skill-observation-transcripts`: deterministic synthetic
  Claude, Codex, and OpenCode observation transcripts for cross-package tests.
- `./testing/codex-review-app-server`: executable fake Codex protocol for isolated
  collector and browser tests; resolve its path without importing it into a production runtime.
- `./testing/harness-home`: deterministic synthetic harness homes and mutation
  helpers for tests/E2E only.
- `./testing/memory-storage`: in-memory local-history test adapter.

This package is collector-independent and must not import local collectors,
report-data, the store, engine/runtime, or apps. Web production imports are
restricted exactly to `@ai-usage/local-machine/campaign-label-config`,
`@ai-usage/local-machine/session-detail`,
`@ai-usage/local-machine/skills-config`, and
`@ai-usage/local-machine/source-policy-config`.

## `@ai-usage/local-collectors`

- `.`: collection orchestration and Codex app-server/quota batch collection.
- `./codex-history`: collector-side Codex rollout/cache writer and conversion.
- `./codex-app-server-client`: bounded native stdio transport and account identity
  qualification shared by quota observation and owned Codex review.
- `./codex-review-launcher`: one fixed-patch review with explicit account, capacity,
  model and policy qualification; owned interruption and partial-result evidence.
- `./collectors`: per-harness normalized collectors.
- `./datasets`: collected report datasets.
- `./facets`: Cursor commit-attribution collection.
- `./rtk-enrichment`: RTK enrichment collection.

Only `usage-engine-runtime` may compose these production seams. Exact local
detail, machine config, scheduling, report assembly, and usage-store access do
not belong here.

## `@ai-usage/report-data`

- `.`: stored-only report payload/publication capture, explicit-config project
  projection, and pure report assembly.
- `./portable-report`: pure snapshot merge and project-source assembly.
- `./provider-quota-history`: bounded provider-quota history projection through
  the read-only store.
- `./skill-observation-read`: the one bounded read of durable skill
  observations, folded and clamped to the caller's response caps.
- `./served-revision-query`: strict bounded support/focused/Session query
  validation and direct revision-keyed execution through the read-only store.
- `./work-context-read`: the bounded Work context for one checkout or project
  label (ADR 0058), a projection of the Work attention read through the
  read-only store, shared by `ai-usage work context` and the `work.context`
  MCP tool; typed, path-free failures.
- `./delegation-read`: delegation job views and lists for one store (ADR 0077),
  read-only, projected with `report-core/delegation-job`; used by the MCP
  delegation tools; a missing store is a typed failure, never an empty list.

There are no collection, scheduler, source-adapter, one-shot writer, artifact,
lease, or subprocess exports. Production `report-data` code may import only
`@ai-usage/usage-store/reader` from usage-store; tests may use `./testing`, and
`./writer` is always forbidden.

## `@ai-usage/usage-store`

- `./performance-testing`: benchmark-only, server-only Session query counters
  and resets, active only under `AI_USAGE_PERF=1`. Production Web consumption
  is restricted to `apps/web/src/hooks.server.ts`; it must never enter a client
  chunk or become a general report API.
- `./reader`: compatible-schema inspection, current/exact served-revision
  queries, stored report/quota/fleet reads, time-anchored skill-observation
  proof expiry, and typed read failures. Opens only an existing database
  read-only and query-only; never creates, migrates, checkpoints, changes
  journal mode, or writes.
- `./writer`: migrations, normalized imports, enrichment, transfer mutations,
  source checkpoints/attempts, atomic served-revision publication, recovery,
  retention, and explicit checkpointing. Production use is restricted to the
  deep `usage-engine-runtime` and `usage-merge` owners.
- `./testing`: temporary mixed read/write fixtures for tests and E2E only.

There is deliberately no root export.

## `@ai-usage/mcp-adapter`

- `.`: exact tool names, schemas, annotations, the `work.context` tool, the
  delegation tools behind their ports, and MCP server construction.
- `./registration`: identity-checked/idempotent JSON and Codex stdio
  registration helpers and the registered server name.
- `./stdio`: stdio transport connection only.
- `./testing`: in-memory transport helpers for protocol tests.

Only this package imports the MCP SDK. It may consume Skills projection locking,
but no SQLite adapter, engine client or report-core module. Each tool is
registered only when the composition passes its port; the adapter owns the
schemas, the one-scope rule of `work.context`, the response bound and sanitized
errors, never the store ([Local MCP server](mcp.md)).

## `@ai-usage/usage-engine-control`

- `.`: protocol-v4 branded command, result, status, event, and error contracts;
  strict parsers; frozen budgets; retry classification; and the path-free web
  command subset.
- `./client`: injected authenticated numeric-loopback HTTP client with bounded
  JSON, deadlines/abort mapping, and status-first SSE reconnect.
- `./completion`: bounded command completion tracking over status/events.
- `./delegation-operations`: the engine side of the delegation operations shared
  by MCP and CLI: rendezvous lookup and target check without starting an engine,
  and the qualify/start/cancel/evaluate commands mapped to closed, path-free
  result codes.
- `./handoff`: bounded byte staging, fsync, owner-only/no-follow inbox files,
  opaque handoff identifiers, and cleanup. The engine independently revalidates
  and consumes the file; this seam never parses/imports the document.
- `./node`: owner-only/no-follow rendezvous parsing, fixed loopback origin,
  bounded opened-file reads, and the shared engine/Web/CLI runtime-target path
  resolver. Clients load a rendezvous only at the current protocol version;
  `loadStaleUsageEngineRendezvousOwner`, for the engine's stale-lock recovery
  only, returns the owner of a rendezvous of any protocol version and nothing
  a client could connect with.
- `./testing`: parser-backed in-memory client for tests/fixtures only.

The protocol surface carries commands, status, and bounded events only. It must
never expose report rows, focused/Session results, quota history, SQLite bytes,
staged file contents, or arbitrary operator paths to web clients.

## `@ai-usage/usage-merge`

- `.`: manual merge parsing, raw-byte digest binding, preview, confirmation,
  bounded warning projection, and usage-store error mapping.

This package may import report-core, `usage-store/writer`, and Effect only.
Engine-runtime adapts it to inbox/operator files and control commands; it does
not duplicate merge semantics. No other production package may depend on or
import this writer-capable service.

## `@ai-usage/usage-engine-runtime`

- `.`: scoped `UsageEngineRuntime` lifecycle and injected factory contract.
- `./live`: production collection, configuration, store-writer, publication,
  and transfer composition.
- `./recovery`: bounded scavenging of verified legacy filesystem artifacts.
  SQLite incomplete-revision cleanup belongs to the live writer's
  retention/recovery path.
- `./source-adapters`: the seven engine-owned durable source adapters.
- `./source-control`: bounded scheduler/state-machine runtime.

This is the sole deep write-side service. It may import collectors,
`report-data`, control contracts, `usage-merge`, and `usage-store/writer`, but
no app. Only `apps/usage-engine` may compose its live implementation.

Provider usage polling is the engine-owned provider-usage group
(`codex.usage-limits`, `claude.usage-limits`, `opencode.usage-limits`) at a
five-minute cadence. Web and CLI display its stored freshness through read-only
facades; an explicit refresh sends `collect-fresh-quota` through the control
client and never starts an app-owned provider timer.

## `@ai-usage/usage-engine`

- `./main`: executable application entrypoint resolved by CLI for the bounded
  foreground `once <command-request-json>` process. It is a terminal process
  boundary, not an in-process API.

## `@ai-usage/mcp`

Executable-only local stdio composition. It imports the MCP adapter,
runtime-path contracts, and, for `work.context`,
`@ai-usage/report-data/work-context-read` with the `usage-store/reader` store
path (read-only `query_only`; it never starts or contacts an engine). The
delegation tools read jobs through `@ai-usage/report-data/delegation-read` and
send commands through `@ai-usage/usage-engine-control/delegation-operations` to
a running engine; it never starts one. It exports no in-process domain or
storage API.

## `@ai-usage/web-contract`

- `.`: the composed browser oRPC contract.
- `./session`: native Session page, detail, VCS, neighbors, campaign children and
  lookup contracts.
- `./report`, `./skills`, `./sync`, `./control`, `./delegation`, `./work`,
  `./work-attempts`, `./work-routing`, `./work-threads`, `./errors`, and
  `./schema-conventions`: the remaining pure browser contracts and shared
  validation/error schemas.

There is no Memory, Projects, replication or Session-distillation export or
router branch (ADR 0084). Browser imports remain contract-first.

## `@ai-usage/skills`

- `.`: Skills domain facade, scanning, validation, projection, and diagnostics.
- `./application`: application facade and narrow adapter ports.
- `./config`: browser-safe Skills config/mutation validation.
- `./shared`: browser-safe skill/target/token contracts.

## `@ai-usage/design-system`

- `.`: framework-neutral Panda preset entry.
- `./svelte`: tested Svelte components and helpers.
- `./preset`: Panda preset.
- `./report`: report-specific styles/primitives.
- `./css`: generated Panda CSS runtime.
- `./styles.css`: generated stylesheet.
- `./panda/*`: the `panda lib` design-system manifest (`lib.json`, its preset,
  and extracted build info) that `apps/web` loads through Panda's
  `designSystem` option.
- `./css/*`, `./patterns`, `./patterns/*`, `./tokens`, `./helpers`, `./types`:
  generated Panda subpaths that `panda lib` writes into `package.json` on every
  design-system build; they are not hand-edited.

## Application dependency rules

- `apps/usage-engine` is the only production app that imports
  `usage-engine-runtime` or composes `usage-store/writer` transitively. It
  opens no store other than the usage store.
- `apps/web` may import design-system, effect-runtime,
  report-core/report-data,
  skills, usage-engine-control, web-contract, `usage-store/reader`,
  `local-machine/campaign-label-config`, `local-machine/session-detail`, and
  `local-machine/skills-config`. Browser code imports only the oRPC contract.
  Web must not reach a storage writer, collectors, or engine-runtime directly
  or transitively.
- `apps/cli` may import effect-runtime, report-core,
  `@ai-usage/report-data/portable-report`,
  `@ai-usage/report-data/work-context-read`, usage-engine-control,
  `usage-store/reader`, and `@ai-usage/usage-engine/main` for a bounded
  foreground process. The executable is a terminal process boundary, not an
  in-process runtime dependency. CLI must not import collectors,
  engine-runtime, or the usage writer.

## Guardrails

- Biome blocks private `@ai-usage/*/src/**` and relative workspace imports.
- `tools/check-workspace-relative-paths.ts` catches non-import path bypasses.
- `tools/check-public-package-exports.ts` verifies every static workspace import
  resolves through a declared export.
- `tools/check-package-boundaries.ts` checks direct ownership plus the full
  production dependency closure of Web and CLI, including synthetic side-door
  regressions.
