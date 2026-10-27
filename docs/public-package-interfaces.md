# Public package interfaces

Existing workspace packages expose only their current seams below.
Cross-package imports must use declared package exports, never private `src`
paths or relative workspace paths.

Entries introduced by plans 101–107 (`platform-core`,
`authorization-contract`, `authorization`, `identity`, `project-registry`,
`replication-*`, `memory-*`, `mcp-adapter`, and `mcp`, plus the extensions
described for existing packages and apps) are exports present on `main` since
PR #53. Plan 120 removed the connected entries; `identity` and `replication-*`
remain only for the dormant replication client until its phase B.
All entries describe current interfaces. Retained modules from the retired
Session distillation feature are explicitly marked below; their presence is not
a published generation or summary-library capability. The complete remaining
lot is in the [retirement notice](session-distillation.md#residual-deletion-lot).

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

## `@ai-usage/platform-core`

- `./identity`: branded canonical UUID IDs, canonical instants, identity value
  validation, and Space/Person/Device/Repository/Project/Checkout domain
  contracts, plus the Capture Context and SCM IDs the replication protocol
  still carries.
- `./distillation-evidence`, `./session-distillation`, and
  `./distillation-discovery`: retained account/evidence and operation contracts
  used by residual Memory internals and storage tests. The feature is retired;
  these exports are scheduled for separate dependency cleanup.

This package is pure and owns no storage, transport, authorization adapter, or
application runtime.

## `@ai-usage/authorization-contract`

- `.`: portable tri-state `Authorizer`, permission, principal, resource,
  bounded resource-listing, and complete opaque resource-scope contracts.

This package depends only on `platform-core`. It contains no policy adapter,
scope contents, persistence, transport, or browser integration.

## `@ai-usage/authorization`

- `.`: re-export of the portable authorization contract.
- `./permission-resource`: the frozen permission/resource-kind map.
- `./scope-internal`: opaque-scope construction and adapter consumption;
  restricted to the SQLite adapter and tests, never routes/UI/MCP.
- `./single-user`: personal-Space-only local adapter with explicit
  principal/Space/resource checks and unavailable-infrastructure results.

The package implements explicit domain rules rather than a generic policy DSL
and owns no persistence or transport.

## `@ai-usage/identity`

Imported only by the dormant replication client and the engine's replication
runtime; plan 120 phase B removes the package.

- `.`: Device credential metadata and the `DeviceCredentialResolution` the
  replication client parses from the server's Device answer.
- `./device-tokens`: redacted public-ID/HMAC token and deployment-key-ring
  values with narrow transport accessors and constant-time verification.
- `./private-device-credential`: Node-only owner/no-follow private-file adapter
  for the local recoverable Device credential.

The package owns application contracts and security policy, not SQLite or HTTP
routing.

## `@ai-usage/project-registry`

- `./resolution`: pure repository alias normalization, observed Checkout input,
  candidate contracts, and explicit resolution outcome union.
- `./mapping`: additive acknowledged Project-source mapping reader/writer
  contracts.
- `./review`: privacy-safe Checkout review and explicit create/link/
  leave-unassigned action contracts.

This package owns no persistence and never resolves ambiguity by itself.

## `@ai-usage/local-machine`

- `./campaign-label-config`: read-only campaign-label overrides for Web
  presentation after engine-owned mutations.
- `./claude-session-analysis`: bounded exact-session Claude reader.
- `./claude-session-facts`: pure Claude semantic facts.
- `./codex-session-analysis`: bounded exact-session Codex reader.
- `./codex-skill-observation`: pure Codex catalogue and `SKILL.md` read
  observation extractors.
- `./distillation-evidence`: retained bounded account-evidence extractor; no
  published distillation runtime consumes it after retirement.
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
  retention, explicit checkpointing, and usage replication outbox operations.
  Production use is restricted to the deep `usage-engine-runtime` and
  `usage-merge` owners.
- `./testing`: temporary mixed read/write fixtures for tests and E2E only.

There is deliberately no root export. The unused
`queryDistillationSessionMetadata` reader export remains in the documented
retirement cleanup lot; ordinary report and native Session reads are preserved.

## `@ai-usage/replication-protocol`

- `.`: IO-free protocol version, strict Capture Context/batch/event/ACK/problem
  parsers, closed fact payloads, canonical serialization/hashes, deterministic
  publication IDs, bounds, and stream constants.

It imports only portable platform identities and owns no HTTP, SQLite,
PostgreSQL, authentication, filesystem, or runtime composition.

## `@ai-usage/replication-outbox`

- `.`: portable SQLite statement port, exact outbox schema, generation/event
  state transitions, status/history projection, ACK proof, and bounded retry.
- `./worker`: storage/transport ports and one bounded claim/publish/ACK cycle.

Production code never opens a database or network connection itself.

## `@ai-usage/replication-client`

- `.`: outbound-only bounded HTTP Device-resolution and batch-publication
  transport. It requires TLS outside explicit loopback tests and never owns a
  local or shared persistence adapter.

## `@ai-usage/memory-sqlite`

- `./identity`: owner-only local `memory.sqlite` identity-kernel lifecycle,
  atomic single-user bootstrap, Project/Repository/Checkout persistence,
  additive mappings, resolution review actions, DB-native Memory persistence,
  import state, non-replacing coherent backup, and replication outbox ownership.

This is a write-capable local adapter. Production composition is restricted to
`apps/usage-engine`; Web, CLI, and MCP must use application-service seams. The
identity kernel still attaches the historical account repository. Its schema,
existing records and local-only publication safeguards remain intact after
retirement of the generation runtime.

## `@ai-usage/memory-service`

- `./browse`: bounded accepted-knowledge browse projections with historical
  account provenance rendered as text; complete accepted revisions remain
  accessible through exact reads.
- `./analysis-promotion`, `./distillation-errors`, `./distillation-redaction`,
  and `./distillation-repository`: retained internal account/promotion code and
  storage contracts. Their CLI, browser and loopback publication operations
  are removed; these exports remain in the residual cleanup lot.

- `.`: protocol-v1 contracts, strict parsers, fixed operation paths, and byte/
  count/deadline bounds.
- `./application`: authorization-first Memory application services.
- `./client`: injected authenticated numeric-loopback client for Project
  resolution, accepted Memory, proposal review, search and Project context, with
  bounded responses and cancellation/deadline mapping. It exposes no account
  generation, account browsing or promotion method.
- `./conformance`: adapter-independent persistence conformance.
- `./domain`: storage-independent Observation, Proposal, Item, Revision,
  relation, import, export, and outbox contracts.
- `./export`: deterministic bounded portable serializers.
- `./migration`: bounded legacy/native parsers and preview-proof contracts.
- `./node`: owner-only/no-follow rendezvous parsing/publication and bearer-token
  handling for server-side runtimes.
- `./redaction`: pre-persistence classification and redaction.
- `./read-contract`: strict loopback search, exact-item, and Project-context
  request/result parsers.
- `./repository`: explicit persistence port and typed failures.
- `./search`: bounded versioned search query/result contract, normalization,
  cursor/result limits, and runtime response parser.

This package may import the portable authorization, identity, and
Project-registry contracts but no storage adapter. Browser code does not import
`./client` or `./node`.

## `@ai-usage/memory-search`

- `./chunking`: deterministic accepted-revision chunks.
- `./evaluation`: committed synthetic documents and expected query cases.
- `./evaluation-harness`: adapter-independent corpus seeding.
- `./evaluation-metrics`: recall/MRR/no-answer/no-leak/latency/size reporting
  and the evidence gate for vector search.
- `./ranking`: bounded lexical and trigram query helpers.

This package owns no database. The SQLite adapter consumes these portable
corpus and ranking contracts.

## `@ai-usage/mcp-adapter`

- `.`: exact read-only tool names, schemas, cards, local
  application-service composition, and MCP server construction.
- `./registration`: identity-checked/idempotent JSON and Codex stdio
  registration helpers.
- `./stdio`: stdio transport connection only.

Only this package imports the MCP SDK. It may consume Memory/authorization/
identity contracts and Skills projection locking, but no SQLite or PostgreSQL
adapter. The read-only `work.context` tool is registered only when the
composition passes a Work context reader; the adapter owns its schema, the
one-scope rule, the response bound and sanitized errors, never the store.

## `@ai-usage/usage-engine-control`

- `.`: protocol-v3 branded command, result, status, event, and error contracts,
  including the content-free combined replication-status output;
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
- `./replication`: bounded Usage outbox recovery/backfill and worker-port
  adaptation; network transport remains composed only by `apps/usage-engine`.
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

Executable-only local stdio composition. It imports the MCP adapter, Memory
loopback client, runtime-path contracts, and, for `work.context`,
`@ai-usage/report-data/work-context-read` with the `usage-store/reader` store
path (read-only `query_only`; it never starts or contacts an engine). The
delegation tools read jobs through `@ai-usage/report-data/delegation-read` and
send commands through `@ai-usage/usage-engine-control/delegation-operations` to
a running engine; it never starts one. It exports no in-process domain or
storage API.

## `@ai-usage/web-contract`

- `.`: the composed browser oRPC contract.
- `./memory`: accepted-knowledge browse and exact reads, proposal review/actions
  and accepted-Memory search.
- `./session`: native Session page, detail, VCS, neighbors, campaign children and
  lookup contracts.
- `./projects`, `./replication`, `./report`, `./skills`, `./sync`, `./control`,
  `./errors`, and `./schema-conventions`: the remaining pure browser contracts
  and shared validation/error schemas.

There is no Session-distillation export, router branch or Memory promotion
procedure. Browser imports remain contract-first and do not reach retired
platform account contracts.

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
  `usage-engine-runtime`, composes `usage-store/writer` transitively, or opens
  `memory-sqlite/identity` write-capable in local mode. It also owns the local
  Memory-service listener and optional outbound replication-supervisor
  lifecycles.
- `apps/web` may import design-system, effect-runtime, platform-core,
  report-core/report-data,
  skills, usage-engine-control, web-contract, `usage-store/reader`,
  `local-machine/campaign-label-config`, `local-machine/session-detail`, and
  `local-machine/skills-config`. Server-only files may additionally import
  Memory-service contracts/client/node; browser code imports only the oRPC
  Project and Memory contracts. Web must not reach a storage adapter, collectors, or
  engine-runtime directly or transitively. Its production closure also cannot
  reach the authorization implementation.
- `apps/cli` may import effect-runtime, Memory-service client/search contracts,
  platform-core, report-core,
  `@ai-usage/report-data/portable-report`,
  `@ai-usage/report-data/work-context-read`, usage-engine-control,
  `usage-store/reader`, and `@ai-usage/usage-engine/main` for a bounded
  foreground process. The executable is a terminal process boundary, not an
  in-process runtime dependency. CLI must not import collectors,
  engine-runtime, the usage writer, or the authorization implementation.

## Guardrails

- Biome blocks private `@ai-usage/*/src/**` and relative workspace imports.
- `tools/check-workspace-relative-paths.ts` catches non-import path bypasses.
- `tools/check-public-package-exports.ts` verifies every static workspace import
  resolves through a declared export.
- `tools/check-package-boundaries.ts` checks direct ownership plus the full
  production dependency closure of Web and CLI, including synthetic side-door
  regressions.
