# @ai-usage/report-data

## Owns

Application-facing report orchestration: collecting local history through package boundaries, applying aliases, composing warnings, creating compatibility report payloads, and eventually reading report rows through `@ai-usage/usage-store`.

## Does Not Own

It does not own row normalization primitives, UI rendering, CLI output formatting, LAN service lifecycle, LAN scanning, pairing, peer token exchange, or raw collector implementation details.

## Public Interface

The root package export exposes report request/result helpers and compatibility snapshot/report payload assembly used by apps.

## Depends On

`@ai-usage/report-data` may depend on `@ai-usage/report-core`, `@ai-usage/local-collectors`, and later `@ai-usage/usage-store` plus optional peer status metadata from `@ai-usage/usage-merge`.

## Must Not Import

It must not import app packages, private package paths, relative workspace paths, `@ai-usage/lan-pairing`, or network transport modules directly.

## Data Boundary

This package produces report payloads from local and stored usage rows. Report rendering must not perform LAN network work; peer network merge happens through explicit usage-merge actions before reporting.

## Test Strategy

Use integration-style package tests with temporary homes/config directories and fake or in-memory storage where possible. Keep final payload equivalence tests here rather than in app adapters.
