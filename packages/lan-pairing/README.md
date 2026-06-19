# @ai-usage/lan-pairing

## Owns

Generic LAN service lifecycle, process-local pairing runtime state, peer discovery, public peer metadata, temporary same-password pairing sessions, generic credential envelopes, and LAN pairing HTTP endpoints.

## Does Not Own

It does not own ai-usage machine config, usage rows, merge bundles, trusted ai-usage peer storage, `.env` token writes, report payloads, or UI rendering.

## Public Interface

Slice 0 documents the boundary only. Future slices will add typed LAN peer identity, discovery, service lifecycle, pairing input/state/result, and error interfaces.

## Depends On

`@ai-usage/lan-pairing` should stay project-agnostic. It may depend on Effect and generic runtime/crypto/HTTP libraries selected in later slices.

## Must Not Import

It must not import any ai-usage domain package such as `@ai-usage/report-core`, `@ai-usage/report-data`, `@ai-usage/local-collectors`, `@ai-usage/usage-store`, `@ai-usage/usage-merge`, or app packages.

## Data Boundary

This package exchanges generic peer metadata and credential envelopes. It never sees `UsageMergeBundle`, `UsageReportPayload`, raw usage rows, or ai-usage token env names.

## Test Strategy

Use fake transport/runtime tests first, then local server tests for port binding, service lifecycle, discovery, pairing windows, and public-state redaction.
