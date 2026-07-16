# @ai-usage/usage-store

## Owns

The SQLite materialized usage store, additive migrations, local row import, normalized dataset-item upserts, merge bundle persistence, status tracking, and validated report queries.

## Does Not Own

It does not own raw local history collection, file selection or transfer, network transport, immutable web revision artifacts, Session page/campaign/neighbor projection, report payload rendering, app routes, or CLI formatting.

## Public Interface

The root export provides typed APIs for importing local rows and normalized dataset items, previewing/confirming portable bundles against a store-state token, exporting local merge bundles, and querying stored projections plus semantic generation.

## Depends On

`@ai-usage/usage-store` may depend on `@ai-usage/report-core` for normalized row and merge bundle types.

## Must Not Import

It must not import `@ai-usage/local-collectors`, `@ai-usage/report-data`, `@ai-usage/usage-merge`, or app packages.

## Data Boundary

SQLite stores normalized machine-scoped usage facts keyed by origin machine ID and versioned dataset items keyed by source, machine, dataset, schema, and stable item identity. Dataset imports upsert observed items and never delete absent items. Generation advances only when the active report projection changes; observation timestamps and identical imports do not invalidate report captures.

## Test Strategy

Use temporary SQLite databases for schema, migration, import/export, idempotency, update, tombstone, rollback, and query tests.
