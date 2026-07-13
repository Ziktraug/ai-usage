# @ai-usage/usage-merge

## Owns

File-based usage transfer orchestration: exporting local usage as a portable merge bundle, parsing and importing a merge bundle from another machine, mapping storage failures to a stable public error, and producing JSON-safe import/export results for app adapters.

## Does Not Own

It does not own network discovery, LAN transport, pairing, peer credentials, SQLite schema internals, final report filtering/sorting/analytics, UI rendering, or raw local history collection.

## Public Interface

`createUsageFileMergeService` creates a `UsageFileMergeService` with explicit Effect-based operations:

- `exportManualMergeBundle` returns a local `UsageMergeBundle` and a suggested JSON filename.
- preview validates exact bytes/rows and returns count-based effects plus generation/state token without mutation;
- confirm requires that exact digest/generation/state token before importing idempotently.

Failures use `UsageMergeError` with one of three reasons: `invalid-input`, `self-merge`, or `store-failed`.

## Depends On

`@ai-usage/usage-merge` depends on `@ai-usage/report-core` for merge bundle types and validation, `@ai-usage/usage-store` for persistence, and Effect for typed operations.

## Must Not Import

It must not import network or pairing packages, local collectors, app packages, CLI/web renderers, private package paths, or `@ai-usage/report-data` payload creation modules.

## Data Boundary

This package accepts and returns typed `UsageMergeBundle` data. App adapters own reading uploaded text, downloading JSON, and resolving the local machine and usage-store path.

## Test Strategy

Use temporary SQLite databases and the public service to cover export naming, idempotent import, self-import rejection, and typed errors.
