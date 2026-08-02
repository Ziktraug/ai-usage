# @ai-usage/local-collectors

## Owns

Collection-only adapters for Claude, Codex, OpenCode, Cursor, Cursor CSV,
Codex usage-limit observations, RTK savings, and Cursor commit attribution. It
also owns collector-private Codex rollout/cache writes and conversion into
normalized contributions.

## Does not own

It does not own exact on-demand Session analysis, machine/config transactions,
the usage-store schema, report assembly, scheduling, commands, publication,
HTTP, or final output.

## Public interface

The root exposes collection orchestration. Focused exports cover Codex
collector history, per-harness collectors, datasets, facets, and RTK
enrichment. Neutral history/config/fact exports were moved to
`@ai-usage/local-machine` and are not compatibility-reexported.

## Dependency rules

It may depend on `local-machine` for neutral reads/facts and report-core for
domain contracts. It must not import report-data, usage-store, engine control,
apps, or renderers. Only `usage-engine-runtime` may compose collectors in
production; Web and CLI are forbidden direct and transitive access.

## Data boundary

Collectors read raw local harness inputs and emit normalized rows, datasets,
warnings, or provider-neutral quota observations. Usage-bearing metrics are
validated as finite and non-negative. Collector-private caches are never a
served report plane and run only under the engine's sole production process.

## Test strategy

Use deterministic temporary harness homes and injected storage/provider
adapters. Collector tests may mutate only their isolated fixture/cache paths.
