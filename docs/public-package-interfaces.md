# Public Package Interfaces

The workspace packages expose only these public seams. Cross-package imports must use these package exports, not private `src` paths or relative workspace paths.

## `@ai-usage/effect-runtime`

- `.`: domain-free schema-v2 wide-event model, required process resource
  service/layer, boundary runner (`runBoundaryEffect`), hop measurement
  (`withMeasured` / `withMeasuredIfAvailable`), sanitize-on-emit, explicit
  public-message scrubbing, and capture/no-op sinks. Must not import other
  `@ai-usage/*` packages. Generic sink layers remain sink-only; the explicitly
  named test layer is the only helper that also supplies deterministic fixture
  resource identity.
- `./node`: Node-only severity/detail-aware console projection, generic
  projector contract, bounded NDJSON file sink, typed delivery warnings,
  per-transport diagnostics, workspace log-dir resolution, cooperative
  interprocess lock, rotation, and bounded retention sweeps.

## `@ai-usage/report-core`

- `.`: core barrel for stable domain helpers.
- `./analytics`: analytics summary/group calculations.
- `./auth`: authentication/session provenance helpers.
- `./csv`: CSV serialization for usage rows.
- `./datasets`: typed serialized report datasets carried outside usage rows.
- `./focused-report-query`: strict Overview, Breakdown, and byte-bounded support query/result contracts for immutable report revisions.
- `./harness-metadata`: harness keys, labels, and metadata.
- `./model-identity`: normalized model-family and provider identity helpers.
- `./pricing`: editable model pricing and cost approximation support.
- `./provider-status`: provider-agnostic status windows, reset credits, parsing, and merge helpers.
- `./provider-quota`: strict provider-neutral observation, history, normalization, segmentation, and downsampling contracts.
- `./provenance`: usage row provenance attribution helpers.
- `./project-alias`: project alias config parsing and application.
- `./project-group`: project grouping config, source identity, and selector matching helpers.
- `./merge-bundle`: merge bundle serialization and validation types.
- `./report-data`: serialized usage report payloads and report preparation.
- `./report-budgets`: shared frozen byte, row, artifact, and import-query acceptance budgets.
- `./session-query`: strict JSON-safe session filter, sort, page, campaign-child, neighbor, cursor, and request-fingerprint contracts.
- `./session-detail`: strict revision/row detail requests, private
  source-authority-gated report anchors, prompt-free projection facts,
  deterministic consistency comparison, bounded local detail responses,
  phases, turns, intervals, and parsers.
- `./session-vcs`: strict bounded repository, branch-span, commit, recorded-PR,
  and explicit provider-resolution contracts. These values are credential-free
  portable facts, not authority to read local history or contact a provider.
- `./session-lineage`: parent/root source-session normalization across harnesses.
- `./snapshot`: multi-machine usage snapshot creation, parsing, and source labels.
- `./source-control`: browser-safe collection-source identifiers, defaults, policy contracts, state axes, strict snapshot/command/publication-event decoders, and newest-snapshot replacement.
- `./types`: usage row and provenance types.
- `./usage-row`: usage row derivations such as token totals, active dates, and cost helpers.

## `@ai-usage/local-collectors`

- `.`: local history collection orchestration, including the high-level Codex app-server and rollout quota batch collectors.
- `./codex-history`: low-level Codex rollout-history parsing/collection helpers retained for collector compatibility; application callers use report-data one-shot/provider-quota ports.
- `./claude-history`: bounded exact-session Claude JSONL detail reader; prompts
  remain local and on demand.
- `./claude-session-facts`: pure Claude semantic owner shared by report
  collection and local detail for attribution, deduplication, timing, models,
  tools, lineage, and VCS observations.
- `./datasets`: focused local report-dataset collection helpers.
- `./collectors`: per-harness normalized collector adapters and compatibility selection orchestration.
- `./errors`: local history error and warning formatting/types.
- `./facets`: normalized Cursor commit-attribution collection.
- `./local-history`: local history storage service interface/live layer.
- `./machine-config`: user-local machine, project group, skill-management, and legacy project alias config helpers.
- `./opencode-history`: low-level OpenCode SQLite session-detail parsing and collection helpers.
- `./platform-paths`: supported local input candidate resolution.
- `./rtk-enrichment`: normalized usage-row RTK enrichment.
- `./test-fixtures/harness-home`: test-only deterministic local harness homes,
  fixture identities, private-prompt sentinel, and Codex source mutation helper;
  production application code must not import this export.

## `@ai-usage/report-data`

- `.`: local report row/payload requests, stored report captures with a private
  row-authority sidecar, focused known-project-source discovery, snapshot
  assembly, and full compatibility payload creation over core plus local
  collectors.
- `./one-shot-sources`: explicit timer-free source execution application ports, including policy-aware fresh local merge/project discovery and the combined quota refresh/latest-durable-read operation used by CLI.
- `./provider-quota`: local provider-quota refresh, typed `ProviderQuotaRefreshAborted` cancellation, provider-neutral latest-durable projection, and bounded history-query orchestration. Inside an outer wide-event boundary, the single-flight owner records `quota.refresh` and joiners record `quota.refresh.wait`.
- `./report-payload-artifact`: shared owner-only artifact writer and byte budget used by bounded internal Bun runners.
- `./source-adapters`: autonomous detected source adapters that persist normalized contributions.
- `./source-control`: deep scoped bounded Effect scheduler facade, server policy/publication ports, commands, and snapshot stream; its pure transition model remains internal. Runnable source and publication jobs emit one wide event each (`source.run`, `publication`) with stable trigger/reason codes and publication-generation correlation through `@ai-usage/effect-runtime` when sink and resource layers are provided.

## `@ai-usage/usage-store`

- `.`: SQLite-backed producer-owned base usage rows, versioned source-owned enrichment contributions, composed report queries, provider-quota import/query operations, atomic source checkpoints, and validated merge bundle import/export.

## `@ai-usage/usage-merge`

- `.`: explicit merge bundle file export/import workflows and JSON-safe operation results for app adapters.

## `@ai-usage/skills`

- `.`: domain contracts, config parsing, source scanning, target observation, identity-checked projection workflows, and diagnostics.
- `./application`: deep Skills application factory and its narrow adapter ports.
- `./config`: browser-safe skill-management config and mutation input validation.
- `./shared`: browser-safe skill name, target id, and token diagnostic contracts.

## `@ai-usage/design-system`

- `.`: design-system public barrel.
- `./preset`: Panda preset imported by app Panda configs.
- `./report`: report UI class names and primitives.
- `./css`: generated Panda css runtime.
- `./panda.buildinfo.json`: generated Panda build metadata.
- `./styles.css`: generated Panda stylesheet.

## Guardrails

- `biome` blocks `@ai-usage/*/src/**` and relative `apps`/`packages` workspace paths.
- `tools/check-workspace-relative-paths.ts` catches relative workspace path bypasses outside import syntax.
- `tools/check-public-package-exports.ts` verifies static `@ai-usage/*` imports resolve to declared `package.json` exports.
