# Public Package Interfaces

The workspace packages expose only these public seams. Cross-package imports must use these package exports, not private `src` paths or relative workspace paths.

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
- `./session-lineage`: parent/root source-session normalization across harnesses.
- `./snapshot`: multi-machine usage snapshot creation, parsing, and source labels.
- `./source-control`: browser-safe collection-source identifiers, defaults, policy contracts, state axes, and snapshot DTOs.
- `./types`: usage row and provenance types.
- `./usage-row`: usage row derivations such as token totals, active dates, and cost helpers.

## `@ai-usage/local-collectors`

- `.`: local history collection orchestration, including the high-level Codex app-server and rollout quota batch collectors.
- `./codex-history`: Codex quota/local history helpers used by CLI quota output.
- `./datasets`: focused local report-dataset collection helpers.
- `./collectors`: per-harness normalized collector adapters and compatibility selection orchestration.
- `./errors`: local history error and warning formatting/types.
- `./facets`: normalized Cursor commit-attribution collection.
- `./local-history`: local history storage service interface/live layer.
- `./machine-config`: user-local machine, project group, skill-management, and legacy project alias config helpers.
- `./platform-paths`: supported local input candidate resolution.
- `./rtk-enrichment`: normalized usage-row RTK enrichment.

## `@ai-usage/report-data`

- `.`: local report row/payload requests, focused known-project-source discovery, snapshot assembly, and full compatibility payload creation over core plus local collectors.
- `./provider-quota`: local provider-quota refresh and bounded history-query orchestration.
- `./report-payload-artifact`: shared owner-only artifact writer and byte budget used by bounded internal Bun runners.
- `./source-adapters`: autonomous detected source adapters that persist normalized contributions.
- `./source-control`: scoped bounded Effect scheduler, server policy/publication ports, commands, and snapshot stream.

## `@ai-usage/usage-store`

- `.`: SQLite-backed normalized usage row and provider-quota import/query operations, atomic source checkpoints, and validated merge bundle import/export.

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
