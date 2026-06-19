# apps/web

## Owns

The Solid/TanStack web runtime, report dashboard routes, `/sync` UI route, server function facades, browser export adapters, and UI read-model presentation.

## Does Not Own

It does not own local history collection, report-domain calculations, LAN discovery, pairing protocol details, trusted peer persistence, token storage, or usage-store import/export logic.

## Public Interface

The public interface is the app route tree, server functions under `src/server`, and package scripts in `package.json`.

## Depends On

`apps/web` may depend on `@ai-usage/report-data`, `@ai-usage/report-core`, `@ai-usage/design-system`, `@ai-usage/local-collectors`, `@ai-usage/lan-pairing`, `@ai-usage/usage-merge`, and `@ai-usage/usage-store` through public package exports.

## Must Not Import

It must not import private `@ai-usage/*/src/**` paths, relative workspace paths, future `@ai-usage/lan-pairing` internals directly from UI components, or CLI modules.

## Data Boundary

Solid components receive JSON-safe report and LAN merge state. Effect values, filesystem handles, raw tokens, transport URLs, and SQLite handles stay behind server/runtime modules.

## Test Strategy

Keep pure UI model tests close to their model files, server function adapter tests under `src/server`, and route/runtime checks behind app `check`, `test`, and build scripts.
