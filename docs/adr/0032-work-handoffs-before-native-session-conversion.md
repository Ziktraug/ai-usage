# ADR 0032: Work handoffs before native session conversion

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

Users need to continue work across Claude, Codex, OpenCode, Cursor, and Devices,
but native harness stores are private, version-specific, and not a safe common
write contract. A generated summary also cannot be treated as observed fact.

## Decision

Build normalized Work Threads and reviewed `WorkHandoff` revisions before
researching native session conversion. A Work handoff contains bounded selected
continuation context whose statements label observed, declared, or generated
evidence. A Person accepts an immutable revision and atomically advances the
Work Thread's current pointer; history remains addressable.

The target harness starts a normal new native Session and retrieves the accepted
Work handoff through application services/MCP. No production code writes
undocumented Claude, Codex, OpenCode, or Cursor session stores. Native
portability remains a disposable, version-pinned spike after the normalized
handoff and archive boundaries exist.

`UsageEngineHandoff*` staged-file transport, imported Memory `kind: "handoff"`,
and the `WorkHandoff*` domain remain separate. There is no new bare `Handoff`
domain type.

## Consequences

- Cross-harness continuity can deliver local value without reverse-engineered
  writes or exact process migration.
- Provenance, uncertainty, and staleness are visible at continuation time.
- Native conversion must beat a supported normalized baseline under explicit
  loss and safety measurements.

## Rejected alternative

Writing translated sessions into private harness stores was rejected because
formats and invariants are undocumented and mutation could corrupt profiles or
misrepresent provenance.

## Reversal condition

Permit native import only for a harness/version with an official supported API,
disposable-environment evidence, round-trip/loss measurements, explicit
credential and filesystem boundaries, and a separately accepted production ADR.

## Evidence

- [Work handoff language](../../CONTEXT.md)
- [Plan 108](../../plans/108-cross-harness-handoffs-work-threads.md)
- [Plan 110](../../plans/110-native-session-portability-spike.md)
