# @ai-usage/usage-store

## Owns

The SQLite materialized usage store, migrations, local row import, merge bundle file import/export, status tracking, and report-row queries.

## Does Not Own

It does not own raw local history collection, file selection or transfer, network transport, report payload rendering, app routes, or CLI formatting.

## Public Interface

The root export provides typed APIs for importing local rows, exporting local merge bundles, importing bundles from another machine, and querying report rows.

## Depends On

`@ai-usage/usage-store` may depend on `@ai-usage/report-core` for normalized row and merge bundle types.

## Must Not Import

It must not import `@ai-usage/local-collectors`, `@ai-usage/report-data`, `@ai-usage/usage-merge`, or app packages.

## Data Boundary

SQLite stores normalized machine-scoped usage facts keyed by origin machine ID. It exports/imports typed merge bundles and returns rows suitable for report-data orchestration.

## Test Strategy

Use temporary SQLite databases for schema, migration, import/export, idempotency, update, tombstone, and query tests.
