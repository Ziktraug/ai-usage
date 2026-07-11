# apps/web

## Owns

The Solid/TanStack web runtime, report dashboard routes, the file-based `/sync` import/export route, server function facades, browser export adapters, and UI read-model presentation.

## Does Not Own

It does not own local history collection, report-domain calculations, merge bundle validation, usage-store persistence, or file import/export semantics.

## Public Interface

The public interface is the app route tree, server functions under `src/server`, and package scripts in `package.json`.

## Depends On

`apps/web` may depend on `@ai-usage/report-data`, `@ai-usage/report-core`, `@ai-usage/design-system`, `@ai-usage/local-collectors`, `@ai-usage/usage-merge`, and `@ai-usage/usage-store` through public package exports.

## Must Not Import

It must not import private `@ai-usage/*/src/**` paths, relative workspace paths, network pairing modules, or CLI modules.

## Data Boundary

Solid components receive JSON-safe report data and manual merge results. Effect values, filesystem handles, raw file contents, and SQLite handles stay behind server/runtime modules.

## Test Strategy

Keep pure UI model tests close to their model files, server function adapter tests under `src/server`, and route/runtime checks behind app `check`, `test`, and build scripts.
