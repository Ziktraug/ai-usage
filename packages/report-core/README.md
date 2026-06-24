# @ai-usage/report-core

## Owns

Pure usage/report domain types, normalized row helpers, pricing, analytics, project alias rules, snapshot parsing while legacy sync exists, report payload serialization, and future merge bundle serialization types.

## Does Not Own

It does not own filesystem access, local history discovery, SQLite, LAN transport, pairing, Effect runtime layers, app routes, or UI rendering.

## Public Interface

The package exports the root barrel plus declared subpath exports in `package.json`. The canonical list of public exports and their responsibilities lives in [`docs/public-package-interfaces.md`](../../docs/public-package-interfaces.md#ai-usagereport-core).

## Depends On

`@ai-usage/report-core` should depend only on TypeScript and pure runtime dependencies when needed. It currently has no workspace package dependencies.

## Must Not Import

It must not import `@ai-usage/local-collectors`, `@ai-usage/report-data`, `@ai-usage/usage-store`, `@ai-usage/usage-merge`, `@ai-usage/lan-pairing`, app packages, Node filesystem APIs, or browser-only APIs.

## Data Boundary

Inputs and outputs are typed, deterministic, and portable. This package may define serialized objects, but it must not decide where they are stored, collected, fetched, or rendered.

## Test Strategy

Use focused unit tests for pure calculations, normalization, parsing, serialization, sorting, filtering, and analytics. No tests should require local machine history or network access.
