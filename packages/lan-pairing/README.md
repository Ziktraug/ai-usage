# @ai-usage/lan-pairing

## Owns

Generic LAN service lifecycle, process-local pairing runtime state, peer discovery, public peer metadata, temporary same-password pairing sessions, generic credential envelopes, and LAN pairing HTTP endpoints.

## Does Not Own

It does not own ai-usage machine config, usage rows, merge bundles, trusted ai-usage peer storage, `.env` token writes, report payloads, or UI rendering.

## Public Interface

The public interface exposes generic LAN peer identity, active discovery, service lifecycle, pairing input/state/result, CPace PAKE proof helpers, and typed errors. It does not expose application-specific merge or report data.

## Depends On

`@ai-usage/lan-pairing` stays project-agnostic. It depends on Effect, Node/Bun runtime APIs, and `@cipherman/pake-js` for encapsulated CPace key agreement.

## Must Not Import

It must not import any ai-usage domain package such as `@ai-usage/report-core`, `@ai-usage/report-data`, `@ai-usage/local-collectors`, `@ai-usage/usage-store`, `@ai-usage/usage-merge`, or app packages.

## Data Boundary

This package exchanges generic peer metadata and credential envelopes. It never sees `UsageMergeBundle`, `UsageReportPayload`, raw usage rows, or ai-usage token env names.

## Test Strategy

Use fake transport/runtime tests first, then local server tests for port binding, service lifecycle, discovery, pairing windows, and public-state redaction.

## PAKE Selection

The selected PAKE implementation is `@cipherman/pake-js` CPace/Ristretto255. It was accepted for this spike because it is stateless, has one runtime dependency (`@noble/curves`), exposes no transport/storage opinions, supports Bun and Node imports, and keeps CPace isolated behind this package's transcript helpers.

The maturity risk is real: the package is pre-1.0, recently published, and single-maintainer. For that reason, `lan-pairing` treats it as replaceable infrastructure and does not leak its API outside this package. Production hardening should revisit audit status before relying on it for hostile networks.

Fallback candidates:

- OPAQUE and SRP-style libraries were not adopted in this slice because the desired LAN pairing model is balanced same-password pairing, not verifier-based login.
- Noise was explicitly rejected as the short-password PAKE mechanism. It is useful for authenticated key exchange when keys already exist, but it is not a PAKE for low-entropy user-entered codes.
- HMAC challenge-response remains only a documented emergency fallback. It is weaker because captured handshakes can be brute-forced offline, and would require a generated high-entropy passphrase rather than a short user password.
