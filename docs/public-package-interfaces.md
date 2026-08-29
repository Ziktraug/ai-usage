# Public package interfaces

Workspace packages expose only the seams below. Cross-package imports must use
declared package exports, never private `src` paths or relative workspace paths.

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
- `./session-detail`: strict detail request, anchor, comparison, and local
  projection contracts.
- `./session-lineage`: parent/root session normalization.
- `./session-query`: strict Session paging/campaign/neighbor/cursor contracts.
- `./session-vcs`: bounded credential-free repository/branch/commit/PR facts.
- `./skill-observation`: the skill-observation fact, its tiers, and per-harness
  observability.
- `./skill-observation-summary`: the pure fold from observations into the
  presented per-tier, per-harness dataset.
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
- `./text`: bounded text helpers.
- `./testing/harness-home`: deterministic synthetic harness homes and mutation
  helpers for tests/E2E only.
- `./testing/memory-storage`: in-memory local-history test adapter.

This package is collector-independent and must not import local collectors,
report-data, the store, engine/runtime, or apps. Web production imports are
restricted exactly to `@ai-usage/local-machine/campaign-label-config`,
`@ai-usage/local-machine/session-detail`, and
`@ai-usage/local-machine/skills-config`.

## `@ai-usage/local-collectors`

- `.`: collection orchestration and Codex app-server/quota batch collection.
- `./codex-history`: collector-side Codex rollout/cache writer and conversion.
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
- `./served-revision-query`: strict bounded support/focused/Session query
  validation and direct revision-keyed execution through the read-only store.

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
  queries, stored report/quota/fleet reads, and typed read failures. Opens only
  an existing database read-only and query-only; never creates, migrates,
  checkpoints, changes journal mode, or writes.
- `./writer`: migrations, normalized imports, enrichment, transfer mutations,
  source checkpoints/attempts, atomic served-revision publication, recovery,
  retention, and explicit checkpointing. Production use is restricted to the
  deep `usage-engine-runtime` and `usage-merge` owners.
- `./testing`: temporary mixed read/write fixtures for tests and E2E only.

There is deliberately no root export.

## `@ai-usage/usage-engine-control`

- `.`: protocol-v1 branded command, result, status, event, and error contracts;
  strict parsers; frozen budgets; retry classification; and the path-free web
  command subset.
- `./client`: injected authenticated numeric-loopback HTTP client with bounded
  JSON, deadlines/abort mapping, and status-first SSE reconnect.
- `./completion`: bounded command completion tracking over status/events.
- `./handoff`: bounded byte staging, fsync, owner-only/no-follow inbox files,
  opaque handoff identifiers, and cleanup. The engine independently revalidates
  and consumes the file; this seam never parses/imports the document.
- `./node`: owner-only/no-follow rendezvous parsing, fixed loopback origin,
  bounded opened-file reads, and the shared engine/Web/CLI runtime-target path
  resolver.
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

Provider usage polling is the engine-owned `codex.usage-limits` source at its
five-minute cadence. Web and CLI display its stored freshness through read-only
facades; an explicit refresh sends `collect-fresh-quota` through the control
client and never starts an app-owned provider timer.

## `@ai-usage/usage-engine`

- `./main`: executable application entrypoint resolved by CLI for the bounded
  foreground `once <command-request-json>` process. It is a terminal process
  boundary, not an in-process API.

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
- `./panda.buildinfo.json`: generated Panda build metadata.
- `./styles.css`: generated stylesheet.

## Application dependency rules

- `apps/usage-engine` is the only production app that imports
  `usage-engine-runtime` or composes `usage-store/writer` transitively.
- `apps/web` may import design-system, effect-runtime, report-core/report-data,
  skills, usage-engine-control, `usage-store/reader`,
  `local-machine/campaign-label-config`, `local-machine/session-detail`, and
  `local-machine/skills-config`. It must not reach collectors or engine-runtime
  directly or transitively.
- `apps/cli` may import effect-runtime, report-core,
  `@ai-usage/report-data/portable-report`, usage-engine-control,
  `usage-store/reader`, and `@ai-usage/usage-engine/main` for a bounded
  foreground process. The executable is a terminal process boundary, not an
  in-process runtime dependency. CLI must not import collectors,
  engine-runtime, or the writer.

## Guardrails

- Biome blocks private `@ai-usage/*/src/**` and relative workspace imports.
- `tools/check-workspace-relative-paths.ts` catches non-import path bypasses.
- `tools/check-public-package-exports.ts` verifies every static workspace import
  resolves through a declared export.
- `tools/check-package-boundaries.ts` checks direct ownership plus the full
  production dependency closure of Web and CLI, including synthetic side-door
  regressions.
