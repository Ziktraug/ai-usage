# ADR 0042: Keep generated session accounts local and distinct from accepted Memory

- **Status**: Accepted
- **Date**: 2026-10-04
- **Extends**: 0024, 0026, 0038, 0040, 0041

## Context

Session execution metrics and rounds do not express investigation outcomes.
The Memory authority already provides the writer lifecycle, stable Project
identity and authenticated local service. Structured Observations are candidates
for Memory promotion and export; overloading their lifecycle would make a
strictly local generated corpus difficult to enforce without false sensitivity.

## Decision

The existing Memory database owns separate local analysis jobs, immutable
analysis revisions and a project-scoped lexical search projection. Only the
usage engine writes them. They are absent from Memory observations, accepted
Memory search, snapshots, exports, replication and connected composition.

An explicitly authorized bounded batch prepares redacted evidence from locally
observed Codex sessions of one resolved Project. The runtime resolves source
locators, checks machine and checkout authority, and records source and packet
digests independently of the report anchor. Canonical rounds remain derived in
report-core; children are not silently included. The active harness produces
only content, through a skill; no provider adapter or credentials are added.

Jobs use bounded leases and attempts, one concurrent claim, idempotent
submission and immutable publication. Generation holds no database transaction.
A new interpretation appends a revision. Report revisions and counters are
unchanged. Runtime metadata cannot be set by model-authored content. Structural
and citation validation does not establish semantic truth or accepted guidance.

Pure semantic/evidence contracts live in `platform-core`; the Memory service
therefore remains independent of report calculations and runtime packages.

The Session drawer loads analysis code/data only on explicit inspection. Exact
revision selection remains readable while a later job fails. Evidence reload
rechecks the source version and says changed/unavailable instead of displaying
different text. CLI recall is a separately named generated corpus with bounded
UTF-8 context output and omissions. Historical commands are data.

## Consequences

The local Memory schema advances with the normal paired-store backup procedure;
disposable tests do not authorize or prove a real-store upgrade. Initial product
validation is synthetic. Optional promotion to Memory requires a later explicit
Observation/Proposal action and the existing human review.

## Rejected alternative

Storing all episodes as accepted Memory would alter the meaning of existing
search and could publish generated interpretations implicitly. A third database
or Markdown authority would duplicate lifecycle and integrity ownership.

## Evidence

- [Execution plan](../../plans/115-local-session-distillation.md)
- [Semantic contract](../../packages/platform-core/src/session-distillation.ts)
- [Evidence reader](../../packages/local-machine/src/distillation-evidence.ts)
- [Skill](../../skills/session-distillation/SKILL.md)
- [Synthetic evaluation](../../tools/fixtures/distillation/evaluation.json)
