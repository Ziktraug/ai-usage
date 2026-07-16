# @ai-usage/usage-store

## Owns

The SQLite materialized usage store, additive migrations, producer-owned base-row import, source-owned enrichment contributions, normalized dataset-item upserts, merge bundle persistence, status tracking, and validated composed report queries.

## Does Not Own

It does not own raw local history collection, file selection or transfer, network transport, immutable web revision artifacts, Session page/campaign/neighbor projection, report payload rendering, app routes, or CLI formatting.

## Public Interface

The root export provides typed APIs for importing local base rows and normalized dataset items, querying enrichable rows with stable keys, idempotently upserting validated RTK savings contributions, previewing/confirming portable bundles against a store-state token, exporting local merge bundles, and querying composed projections plus semantic generation.

## Depends On

`@ai-usage/usage-store` may depend on `@ai-usage/report-core` for normalized row and merge bundle types.

## Must Not Import

It must not import `@ai-usage/local-collectors`, `@ai-usage/report-data`, `@ai-usage/usage-merge`, or app packages.

## Data Boundary

SQLite stores normalized machine-scoped base usage facts keyed by stable row identity. Enrichers own separate versioned contributions keyed by row and enrichment source; report reads validate and overlay them without teaching base upserts about enrichment fields. Empty or unmatched enrichment runs never clear prior contributions. Versioned dataset items remain keyed by source, machine, dataset, schema, and stable item identity. Generation advances only when the active composed report projection changes; observation timestamps and identical imports do not invalidate report captures.

## Test Strategy

Use temporary SQLite databases for schema, migration, import/export, idempotency, update, tombstone, rollback, and query tests.
