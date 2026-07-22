# Wide-event presentation, provenance, and delivery diagnostics

- **Status**: Accepted
- **Date**: 2026-07-22
- **Supersedes**: selected clauses of ADR 0002 and plan 036 only

## Context

The schema-v1 implementation produced truthful machine records for most
boundaries, but its serialization-shaped TTY line was unreadable, Session
validation could fail after a success event, retained files could mix producer
versions without provenance, and web file-delivery loss was silent. The default
tagged-error classifier also accepted a generic `.message` from allowlisted
errors even though only explicitly public text should cross the boundary.

## Decision

New records use schema v2 and contain a required, sanitized process-scoped
resource: instance id, runtime mode, service name/version, and surface. Web and
CLI composition roots provide the resource; the domain-free runtime package
does not read application configuration or import another workspace package.
Historical schema-v1 files are not rewritten.

Canonical storage and terminal presentation are independent. NDJSON and JSON
console records remain one compact object per physical line. Pretty TTY output
may use multiple lines in one console call and is built from a generic projector
contract. Web injects application-owned summaries; unknown boundaries use the
generic total fallback. Outcomes select info/warn/error, while `LOG_LEVEL`
controls only console filtering and debug expansion.

Tagged errors expose a message only through explicit `publicMessage`; generic
`.message` fallback is removed. Approved public text is bounded and scrubbed
for credential-shaped query and authorization values. Domain boundaries prefer
stable reason and warning codes.

Web file warnings use fixed typed kinds, bounded counters, and per-kind
rate-limiting. They write directly to the console warning channel and never
re-enter the file sink. Shutdown prints a console-only loss summary when a
transport dropped or failed records. CLI warnings and summaries remain silent.
An append timeout opens the circuit at the configured deadline while the
non-cooperative append and cooperative lock remain alive until I/O settles.
Retention sweeps run on the first successful append and target rotation, not on
steady-state appends.

This ADR supersedes only ADR 0002/plan 036 choices that required one physical
TTY line, omitted producer resource context, kept web file diagnostics silent,
or allowed generic `.message` fallback.

## Preserved decisions

- one canonical event for each real boundary and fresh isolated event state;
- a domain-free `@ai-usage/effect-runtime` package;
- NDJSON one object per physical line and CLI file-only output;
- bounded best-effort delivery, private permissions, cooperative locking,
  rotation, and retention;
- no raw causes, payloads, prompts, credentials, OTLP, or remote exporter.

## Consequences

Application projectors and resource layers become explicit composition
dependencies. Operators gain short semantic TTY summaries, stable anomaly
dimensions, source/publication generation correlation, and visible web
delivery loss without changing product results or scheduler policy.
