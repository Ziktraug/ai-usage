# Public package interfaces

Existing workspace packages expose only their current seams below.
Cross-package imports must use declared package exports, never private `src`
paths or relative workspace paths.

Platform entries introduced by plans 101–107 are accepted target interfaces,
not exports currently available on `main`. They remain pending until their plan
status reaches `DONE`: `platform-core`, `authorization-contract`,
`authorization`, `identity`, `project-application`, `project-registry`,
`replication-*`, `memory-*`, `mcp-adapter`, `postgres-store`, `server`, and
`mcp`, plus the platform-specific extensions described for existing packages
and apps. All other entries describe current interfaces.

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

## `@ai-usage/platform-core`

- `./identity`: branded canonical UUID IDs, canonical instants, identity value
  validation, and Space/Person/Device/SCM/Repository/Project/Checkout/Capture
  Context domain contracts.

This package is pure and owns no storage, transport, authorization adapter, or
application runtime.

## `@ai-usage/authorization-contract`

- `.`: portable tri-state `Authorizer`, permission, principal, resource,
  bounded resource-listing, and complete opaque resource-scope contracts.

This package depends only on `platform-core`. It contains no policy adapter,
scope contents, persistence, transport, or browser integration.

## `@ai-usage/authorization`

- `.`: re-export of the portable authorization contract.
- `./conformance`: immutable adapter-independent organization scenarios for
  adapter verification.
- `./in-memory`: explicit organization-policy adapter and relation-read
  instrumentation for application-service/conformance tests.
- `./organization-model`: concrete organization membership, Team, resource,
  grant, sensitivity, expiry, and revocation state contracts.
- `./permission-resource`: the frozen permission/resource-kind map.
- `./scope-internal`: opaque-scope construction and adapter consumption;
  restricted to SQLite/PostgreSQL adapter code and tests, never routes/UI/MCP.
- `./single-user`: personal-Space-only local adapter with explicit
  principal/Space/resource checks and unavailable-infrastructure results.

Authentication and PostgreSQL queries are not part of this package. The
organization adapters implement explicit domain rules rather than a generic
policy DSL.

## `@ai-usage/identity`

- `.`: provider-independent Authentication identity, domain session, Device
  credential/grant metadata, and typed identity-service result contracts.
- `./better-auth`: the GitHub-only Better Auth `1.7.2` application wrapper and
  adapter ports; production composition is restricted to `apps/server` and the
  PostgreSQL authentication adapter.
- `./device-enrollment`: authorization-aware grant, exchange, authentication,
  list, rename, rotation, and revocation application service.
- `./device-tokens`: redacted public-ID/HMAC token and deployment-key-ring
  values with narrow transport accessors and constant-time verification.
- `./private-device-credential`: Node-only owner/no-follow private-file adapter
  for the local recoverable Device credential.
- `./session-digest-adapter`: adapter-private Better Auth token-digest wrapper.
- `./testing`: shared-authentication factory injection for tests/gates only.

The package owns application contracts and security policy, not PostgreSQL,
SQLite, HTTP routing, or Drizzle persistence. Better Auth imports remain inside
its two adapter-private modules.

## `@ai-usage/project-application`

- `.`: authorization-aware Project-listing service, authorized Project catalog
  port, bounded page/result contracts, and typed catalog failures.

The service calls `Authorizer.materializeResourceScope`, treats the complete
scope as opaque, and passes it to persistence. It owns no SQL, transport, or
browser code and never post-filters unrestricted Projects.

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
- `./skill-observation-read`: the one bounded read of durable skill
  observations, folded and clamped to the caller's response caps.
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
  retention, explicit checkpointing, and usage replication outbox operations.
  Production use is restricted to the deep `usage-engine-runtime` and
  `usage-merge` owners.
- `./testing`: temporary mixed read/write fixtures for tests and E2E only.

There is deliberately no root export.

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
`apps/usage-engine`; Web, CLI, and MCP must use application-service seams.

## `@ai-usage/memory-service`

- `.`: protocol-v1 contracts, strict parsers, fixed operation paths, and byte/
  count/deadline bounds.
- `./application`: authorization-first Memory application services.
- `./client`: injected authenticated numeric-loopback client with bounded
  response reads and cancellation/deadline mapping.
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

This package owns no database. SQLite and PostgreSQL adapters consume the same
portable corpus and ranking contracts.

## `@ai-usage/mcp-adapter`

- `.`: exact read-only tool names, schemas, cards, local/connected
  application-service composition, and MCP server construction.
- `./registration`: identity-checked/idempotent JSON and Codex stdio
  registration helpers.
- `./stdio`: stdio transport connection only.

Only this package imports the MCP SDK. It may consume Memory/authorization/
identity contracts and Skills projection locking, but no SQLite or PostgreSQL
adapter.

## `@ai-usage/usage-engine-control`

- `.`: protocol-v3 branded command, result, status, event, and error contracts,
  including the content-free combined replication-status output;
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

Provider usage polling is the engine-owned `codex.usage-limits` source at its
five-minute cadence. Web and CLI display its stored freshness through read-only
facades; an explicit refresh sends `collect-fresh-quota` through the control
client and never starts an app-owned provider timer.

## `@ai-usage/usage-engine`

- `./main`: executable application entrypoint resolved by CLI for the bounded
  foreground `once <command-request-json>` process. It is a terminal process
  boundary, not an in-process API.

## `@ai-usage/postgres-store`

- `./authentication`: shared-authentication database and identity-store port;
  Better Auth row/adapter types remain behind the application wrapper.
- `./authorization`: connected authorization administration and Authorizer
  contracts composed by the shared writer.
- `./identity`: validated shared identity repository contracts returned by the
  write-pool composition; no row or pool type escapes.
- `./devices`: Device enrollment/lifecycle persistence port returned by the
  writer composition; HMAC verifier fields never enter HTTP projections.
- `./memory`: shared PostgreSQL Memory repository port returned by the writer
  composition.
- `./schema`: the current platform schema identity/version contract; no
  inferred Drizzle row type or pool escapes.
- `./migrations`: the explicit ordinal migration registry and validation
  contracts; only `apps/server` may consume migration capabilities.
- `./performance-testing`: Project authorization query access for the
  repository benchmark only; forbidden from production packages.
- `./projects`: authorized Project persistence-catalog contract.
- `./reader`: validated readiness result and typed bounded failures.
- `./writer`: the write-pool composition and lifecycle; production use is
  restricted to `apps/server`.
- `./testing`: disposable raw fixture/migration helpers and the failing-factory
  injection seam for test or fixture source only.

There is deliberately no root export. The package imports only authorization,
`platform-core`, `project-application`, and `project-registry` contracts from
the workspace and owns no SQLite, HTTP, local-machine, or harness filesystem
access.

## `@ai-usage/server`

- `./main`: executable connected-server process entrypoint. It is not a
  browser or in-process domain API.

## `@ai-usage/mcp`

Executable-only local stdio composition. It imports the MCP adapter, Memory
loopback client, and runtime-path contracts; it exports no in-process domain or
storage API.

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
  reach the authorization implementation or `project-application`.
- `apps/cli` may import effect-runtime, Memory-service client/search contracts,
  platform-core, report-core,
  `@ai-usage/report-data/portable-report`, usage-engine-control,
  `usage-store/reader`, and `@ai-usage/usage-engine/main` for a bounded
  foreground process. The executable is a terminal process boundary, not an
  in-process runtime dependency. CLI must not import collectors,
  engine-runtime, the usage writer, or PostgreSQL.
- `apps/server` may import `postgres-store/writer`, identity application
  services, authorization,
  Project-catalog, and migration contracts plus connected application-service
  contracts. It must not import usage-store, collectors, local-machine,
  usage-engine, CLI, or Web implementations.

## Guardrails

- Biome blocks private `@ai-usage/*/src/**` and relative workspace imports.
- `tools/check-workspace-relative-paths.ts` catches non-import path bypasses.
- `tools/check-public-package-exports.ts` verifies every static workspace import
  resolves through a declared export.
- `tools/check-package-boundaries.ts` checks direct ownership plus the full
  production dependency closure of Web and CLI, including synthetic side-door
  regressions.
