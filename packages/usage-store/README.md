# @ai-usage/usage-store

## Owns

The SQLite materialized usage store, migrations, local row import, merge bundle persistence, status tracking, and validated report-row queries.

## Does Not Own

It does not own raw local history collection, file selection or transfer, network transport, immutable web revision artifacts, Session page/campaign/neighbor projection, report payload rendering, app routes, or CLI formatting.

## Public Interface

The root export provides typed APIs for importing local rows, exporting local merge bundles, importing bundles copied from another machine, and querying stored report rows.

## Depends On

`@ai-usage/usage-store` may depend on `@ai-usage/report-core` for normalized row and merge bundle types.

## Must Not Import

It must not import `@ai-usage/local-collectors`, `@ai-usage/report-data`, `@ai-usage/usage-merge`, or app packages.

## Data Boundary

SQLite stores normalized machine-scoped usage facts keyed by origin machine ID. It exports/imports typed merge bundles and returns validated rows with corrupt-row isolation for report-data orchestration.

## Test Strategy

Use temporary SQLite databases for schema, migration, import/export, idempotency, update, tombstone, rollback, and query tests.
