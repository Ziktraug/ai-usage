# apps/cli

## Owns

The terminal command surface, argument parsing, terminal/CSV/JSON/HTML rendering adapters, setup commands, quota command, and legacy sync command entry points until cleanup.

## Does Not Own

It does not own report-domain calculations, local collector implementations, web UI runtime, manual merge-bundle persistence, or usage-store schema.

## Public Interface

The public interface is the `ai-usage` binary, `bun run cli`, command-line options, and CLI output formats.

## Depends On

`apps/cli` may depend on `@ai-usage/report-data`, `@ai-usage/report-core`, `@ai-usage/local-collectors`, and temporary legacy `@ai-usage/sync`.

## Must Not Import

It must not import `apps/web`, private package `src` paths, relative workspace paths, or web-only file-transfer modules directly.

## Data Boundary

The CLI consumes report payloads, normalized rows, snapshots, and command results from package APIs, then renders terminal/file output. It should not become a shared data source for other apps.

## Test Strategy

Cover parsing, formatting, and command behavior with CLI tests. Shared report behavior belongs in package tests rather than CLI renderer tests.
