# Public Package Interfaces

The workspace packages expose only these public seams. Cross-package imports must use these package exports, not private `src` paths or relative workspace paths.

## `@ai-usage/report-core`

- `.`: core barrel for stable domain helpers.
- `./analytics`: analytics summary/group calculations.
- `./auth`: authentication/session provenance helpers.
- `./csv`: CSV serialization for usage rows.
- `./datasets`: typed serialized report datasets carried outside usage rows.
- `./harness-metadata`: harness keys, labels, and metadata.
- `./html-export`: static report HTML payload/asset inlining.
- `./pricing`: editable model pricing and cost approximation support.
- `./provider-status`: provider-agnostic status windows, reset credits, parsing, and merge helpers.
- `./provenance`: usage row provenance attribution helpers.
- `./project-alias`: project alias config parsing and application.
- `./project-group`: project grouping config, source identity, and selector matching helpers.
- `./merge-bundle`: merge bundle serialization and validation types.
- `./report-data`: serialized usage report payloads and report preparation.
- `./session-lineage`: parent/root source-session normalization across harnesses.
- `./snapshot`: multi-machine usage snapshot creation, parsing, and source labels.
- `./types`: usage row and provenance types.
- `./usage-row`: usage row derivations such as token totals, active dates, and cost helpers.

## `@ai-usage/local-collectors`

- `.`: local history collection orchestration.
- `./codex-history`: Codex quota/local history helpers used by CLI quota output.
- `./errors`: local history error and warning formatting/types.
- `./local-history`: local history storage service interface/live layer.
- `./machine-config`: user-local machine, project group, and legacy project alias config helpers.
- `./sync-storage`: user-local synced snapshot config, env token resolution, and stored snapshot helpers.

## `@ai-usage/report-data`

- `.`: report payload and snapshot assembly seam over core plus local collectors.

## `@ai-usage/sync`

- `.`: sync package barrel.
- `./discovery`: snapshot remote LAN discovery helpers and peer discovery results.
- `./errors`: sync error types shared by sync modules.
- `./server`: snapshot HTTP protocol, LAN host URL helpers, and Bun/Node snapshot server adapters.
- `./state`: UI-consumable sync state assembled from configured remotes and stored synced snapshots.
- `./transport`: snapshot file/HTTP loading and endpoint health checks.
- `./workflow`: remote registration, selection, token validation, pull, and removal workflow.

## `@ai-usage/skills`

- `.`: skill-management config types, runtime validation, source-state helpers, source scanning, target observation, projection planning/apply, diagnostics, and workflow functions.

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
