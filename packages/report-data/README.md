# @ai-usage/report-data

## Owns

Application-facing report orchestration: collecting local history through package boundaries, applying aliases, composing warnings, reading known local project sources without creating a full report, creating compatibility payloads for CLI consumers, and executing strict focused/Session queries over web-supplied immutable revision artifacts.

## Does Not Own

It does not own row normalization/query primitives, immutable web revision storage, UI rendering, CLI output formatting, merge bundle file transfer, network transport, or raw collector implementation details.

## Public Interface

The root package export exposes report request/result helpers and compatibility snapshot/report payload assembly used by apps. One pure internal assembler owns final payload construction. The `./report-payload-artifact` export writes the bounded private artifact used by the Bun-to-Nitro full-payload compatibility handoff.

## Depends On

`@ai-usage/report-data` may depend on `@ai-usage/report-core`, `@ai-usage/local-collectors`, and `@ai-usage/usage-store`.

## Must Not Import

It must not import app packages, private package paths, relative workspace paths, or network transport modules directly.

## Data Boundary

This package provides focused local-row/project-source reads and produces compatibility report payloads from local and stored usage rows. Portable source paths stay opaque; only locally observed paths may drive Git/filesystem canonicalization. One private Bun runner validates all six exact-revision query kinds, opens only the leased immutable read-only SQLite materialization, and writes bounded results for bootstrap support, Overview, Breakdown, and paged Sessions/campaign/neighbor reads. Bootstrap projection preserves explicit omission counts when metadata exceeds its byte/item budgets. Stable capture compares semantic store generation and config state before publication. The web adapter owns revision materialization. CLI consumers use the complete compatibility payload directly. File import/export happens through explicit usage-merge actions before reporting.

## Test Strategy

Use integration-style package tests with temporary homes/config directories and fake or in-memory storage where possible. Keep final payload equivalence tests here rather than in app adapters.
