# @ai-usage/report-data

## Owns

Application-facing report orchestration: autonomous durable source adapters, the scoped Effect source control plane and its application-owned wide-event annotations, applying aliases, composing warnings, reading stored-only known local project sources without collecting, creating compatibility payloads for CLI consumers, and executing strict focused/Session queries over web-supplied immutable revision artifacts.

## Does Not Own

It does not own row normalization/query primitives, immutable web revision storage, UI rendering, CLI output formatting, merge bundle file transfer, network transport, or raw collector implementation details.

## Public Interface

The root package export exposes report request/result helpers and compatibility snapshot/report payload assembly used by apps. One pure internal assembler owns final payload construction. `./one-shot-sources` exposes explicit timer-free CLI application workflows, including fresh local merge and project discovery that honor source policy before reading durable results. `./provider-quota` owns refresh, latest durable projection, and bounded history reads; its query, collection, persistence, and projection phases remain in one owner Effect fiber with Deferred-based joiners, and owner cancellation is exposed as `ProviderQuotaRefreshAborted` in the typed Effect error channel. The provider-quota workflow may ask its `@ai-usage/local-collectors` adapter to launch and speak stdio to the installed `codex app-server`; that adapter owns the subprocess boundary rather than the CLI or web renderer, while app-server owns provider communication and authentication refresh. `./source-adapters` exposes the seven Bun runtime adapters used by the collection composition root. `./served-revision-query` validates bounded exact-revision requests and delegates them to the read-only durable SQLite projection API; it does not create copied databases or subprocesses.

## Depends On

`@ai-usage/report-data` may depend on `@ai-usage/effect-runtime`, `@ai-usage/report-core`, `@ai-usage/local-collectors`, and `@ai-usage/usage-store`.

## Must Not Import

It must not import app packages, private package paths, relative workspace paths, or network transport modules directly.

## Data Boundary

This package provides focused stored-row/project-source reads and produces compatibility report payloads from local and stored usage rows. The source control plane holds only bounded operational state: normalized rows, datasets, paths, and raw errors remain outside its snapshot. Its queue is bounded, cadence is completion-relative, policy revisions invalidate stale queued jobs, picked jobs own provider cancellation, and monotonic request/data plus RTK watermarks prevent multi-worker publication from losing demand. Portable source paths stay opaque; only locally observed paths may drive Git/filesystem canonicalization. One private Bun runner validates all six exact-revision query kinds, opens only the leased immutable read-only SQLite materialization, and writes bounded results for bootstrap support, Overview, Breakdown, and paged Sessions/campaign/neighbor reads. Bootstrap projection preserves explicit omission counts when metadata exceeds its byte/item budgets. Stable capture compares semantic store generation and config state before publication. The web adapter owns revision materialization. CLI consumers use the complete compatibility payload directly. File import/export happens through explicit usage-merge actions before reporting.

## Test Strategy

Use integration-style package tests with temporary homes/config directories and fake or in-memory storage where possible. Keep final payload equivalence tests here rather than in app adapters.
