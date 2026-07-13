# @ai-usage/report-core

## Owns

Pure usage/report domain types, normalized row helpers, pricing, analytics, project alias rules, strict Session and focused-destination query contracts, shared acceptance budgets, snapshot parsing, report payload serialization, and merge bundle serialization types.

## Does Not Own

It does not own filesystem access, local history discovery, SQLite, network transport, file transfer, Effect runtime layers, app routes, or UI rendering.

## Public Interface

The package exports the root barrel plus declared subpath exports in `package.json`. The canonical list of public exports and their responsibilities lives in [`docs/public-package-interfaces.md`](../../docs/public-package-interfaces.md#ai-usagereport-core).

## Depends On

`@ai-usage/report-core` should depend only on TypeScript and pure runtime dependencies when needed. It currently has no workspace package dependencies.

## Must Not Import

It must not import `@ai-usage/local-collectors`, `@ai-usage/report-data`, `@ai-usage/usage-store`, `@ai-usage/usage-merge`, app packages, Node filesystem APIs, or browser-only APIs.

## Data Boundary

Inputs and outputs are typed, deterministic, JSON-safe where they cross processes, and portable. Shared query contracts define validated filters, sort, paging, campaign children, neighbors, focused Overview/Breakdown projections, a byte-bounded support bootstrap with explicit omission counts, complete export results, cursors, and request fingerprints without deciding where data is stored, collected, fetched, or rendered.

## Test Strategy

Use focused unit tests for pure calculations, normalization, parsing, serialization, sorting, filtering, and analytics. No tests should require local machine history or network access.
