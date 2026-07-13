# @ai-usage/local-collectors

## Owns

Local history adapters, harness-specific file/database reads, machine config, project-source discovery, local warning/error mapping, and `.env` discovery helpers.

## Does Not Own

It does not own report analytics, report payload creation, network transport, UI state, usage-store schema, or final output rendering.

## Public Interface

The package exposes local collection orchestration plus declared subpath exports for Codex history, focused datasets, errors, local history storage, and machine config.

## Depends On

`@ai-usage/local-collectors` may depend on `@ai-usage/report-core` for normalized row/domain types and pure helpers, and `@ai-usage/skills` for the skill-management config schema embedded in machine config.

## Must Not Import

It must not import `@ai-usage/report-data`, `@ai-usage/usage-store`, `@ai-usage/usage-merge`, app packages, or CLI/web renderers.

## Data Boundary

This package reads local raw history and config, then emits normalized row inputs, collected rows, focused datasets, warnings, and config records. It does not produce final reports or transfer data between machines.

## Test Strategy

Use fixture-backed and temporary-filesystem tests for each collector and config boundary. Keep deterministic normalization expectations in report-core tests when possible.
