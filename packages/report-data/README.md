# @ai-usage/report-data

## Owns

Application-facing report orchestration: collecting local history through package boundaries, applying aliases, composing warnings, creating compatibility report payloads, and reading local or manually imported report rows through `@ai-usage/usage-store`.

## Does Not Own

It does not own row normalization primitives, UI rendering, CLI output formatting, merge bundle file transfer, network transport, or raw collector implementation details.

## Public Interface

The root package export exposes report request/result helpers and compatibility snapshot/report payload assembly used by apps.

## Depends On

`@ai-usage/report-data` may depend on `@ai-usage/report-core`, `@ai-usage/local-collectors`, and `@ai-usage/usage-store`.

## Must Not Import

It must not import app packages, private package paths, relative workspace paths, or network transport modules directly.

## Data Boundary

This package produces report payloads from local and stored usage rows. File import/export happens through explicit usage-merge actions before reporting; report rendering does not perform transfer work.

## Test Strategy

Use integration-style package tests with temporary homes/config directories and fake or in-memory storage where possible. Keep final payload equivalence tests here rather than in app adapters.
