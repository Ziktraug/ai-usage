# @ai-usage/local-collectors

## Owns

Local history adapters, harness-specific file/database reads, machine config, project-source discovery, local warning/error mapping, `.env` discovery helpers, and trusted peer config file primitives when introduced.

## Does Not Own

It does not own report analytics, report payload creation, LAN transport, pairing sessions, UI state, usage-store schema, or final output rendering.

## Public Interface

The package exposes local collection orchestration plus declared subpath exports for Codex history, errors, local history storage, machine config, and sync storage while legacy sync exists.

## Depends On

`@ai-usage/local-collectors` may depend on `@ai-usage/report-core` for normalized row/domain types and pure helpers.

## Must Not Import

It must not import `@ai-usage/report-data`, `@ai-usage/usage-store`, `@ai-usage/usage-merge`, `@ai-usage/lan-pairing`, app packages, or CLI/web renderers.

## Data Boundary

This package reads local raw history and config, then emits normalized row inputs, collected rows, warnings, and config records. It does not produce final reports or exchange data over LAN.

## Test Strategy

Use fixture-backed and temporary-filesystem tests for each collector and config boundary. Keep deterministic normalization expectations in report-core tests when possible.
