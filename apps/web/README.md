# apps/web

## Owns

The Solid/TanStack web runtime, report dashboard and `/skills` routes, the file-based `/sync` import/export route, immutable report revision/focused-query adapters, exact-revision report query server functions, and UI read-model presentation.

## Does Not Own

It does not own local history collection, report-domain calculations, merge bundle validation, usage-store persistence, or file import/export semantics.

## Public Interface

The public interface is the app route tree, server functions under `src/server`, and package scripts in `package.json`.

## Depends On

`apps/web` may depend on `@ai-usage/report-data`, `@ai-usage/report-core`, `@ai-usage/design-system`, `@ai-usage/local-collectors`, `@ai-usage/skills`, `@ai-usage/usage-merge`, and `@ai-usage/usage-store` through public package exports.

## Must Not Import

It must not import private `@ai-usage/*/src/**` paths, relative workspace paths, retired network adapter packages, or CLI modules. Production and setup listeners remain numeric-loopback-only.

## Data Boundary

Solid components receive JSON-safe focused Overview/Breakdown/support results, bounded Session query results, and manual merge results. Served reads name an exact immutable revision and canonical request fingerprint; every report query executes in Bun against a leased revision directory and its read-only SQLite materialization. The support bootstrap admits filter options, provider representatives/statuses, and warnings under the shared 512 KiB budget, returns exact omission counts, and is presented as a bounded summary when truncated. Row-derived destination queries are independent of those summary omissions; omitted support metadata remains identified. Effect values, filesystem handles, raw file contents, and SQLite handles stay behind server/runtime modules.

## Test Strategy

Keep pure UI model tests close to their model files, server function adapter tests under `src/server`, and route/runtime checks behind app `check`, `test`, and build scripts. After `bun run build`, `test:web-production` covers the loopback production entry point, while `test:e2e-production` uses a temporary 205-session home and the built Node server to cover revision publication and paging.
