# @ai-usage/usage-merge

## Owns

The future ai-usage LAN merge domain: adapting machine identity to LAN pairing, encoding ai-usage credential envelopes, trusted peer records, peer freshness state, peer bundle fetch/import orchestration, and first-merge behavior.

## Does Not Own

It does not own generic LAN pairing mechanics, SQLite schema internals, final report filtering/sorting/analytics, UI rendering, or raw local history collection.

## Public Interface

Slice 0 documents the boundary only. Future slices will add Effect-level commands for starting/stopping LAN merge, reading `LanMergeState`, pairing peers, merging peers, forgetting peers, and reading peer statuses.

## Depends On

`@ai-usage/usage-merge` may depend on `@ai-usage/lan-pairing`, `@ai-usage/report-core`, `@ai-usage/usage-store`, and narrow local config/env helpers from `@ai-usage/local-collectors` if needed.

## Must Not Import

It must not import app packages, CLI/web renderers, private package paths, or `@ai-usage/report-data` payload creation modules.

## Data Boundary

This package translates between generic LAN pairing credentials and ai-usage merge semantics. It moves `UsageMergeBundle` data into usage-store and exposes JSON-safe merge state to app server facades.

## Test Strategy

Use fake LAN pairing, fake store, fake clock, and fake token/env adapters for state, pairing, merge, forget, and error-path tests.
