# Documentation map

Two kinds of documents live here. **Living reference** is kept current and is
safe to rely on. **Dated records** are design plans, audits, and measurement
snapshots that were true at their stated date; they are retained for
provenance, not maintained. When they disagree with living reference, the
living reference wins.

## Living reference

- [`architecture.md`](architecture.md) — data flow, process/package ownership,
  the data-plane/control-plane split.
- [`adr/`](adr/README.md) — the architecture decision index. Start here for
  "why is it like this".
- [`../CONTEXT.md`](../CONTEXT.md) — the ubiquitous language of the domain.
- [`public-package-interfaces.md`](public-package-interfaces.md) — the only
  seams packages may import from each other.
- [`generated-tooling-ownership.md`](generated-tooling-ownership.md) — which
  generated trees exist and who owns them.
- [`platform-server-operations.md`](platform-server-operations.md) — connected
  PostgreSQL 17 lifecycle, migrations, health, configuration, and recovery.
- [`identity-kernel.md`](identity-kernel.md) — stable Space/Person/Device/
  Repository/Project identities, authorization seam, resolution, persistence,
  and the local review service.
- [`authorization.md`](authorization.md) — Authorizer port, organization roles,
  explicit PostgreSQL relations/queries, complete scope, RLS, audit, benchmark,
  and the measured OpenFGA escape hatch.
- [`authentication-and-device-enrollment.md`](authentication-and-device-enrollment.md)
  — GitHub-only connected login, Web sessions, bootstrap, Device enrollment,
  token/key rotation, private local storage, support limits, and threat model.
- [`device-replication.md`](device-replication.md) — outbound-only publication,
  protocol identities, SQLite outbox recovery, transactional PostgreSQL apply,
  replay/security boundary, diagnostics, privacy tombstones, and fallback.
- [`memory-search-and-mcp.md`](memory-search-and-mcp.md) — authorization-first
  SQLite/PostgreSQL search, corpus metrics, vector gate, Web/CLI surfaces, MCP
  tools, registration, and retrieved-content safety.
- [`skills-management.md`](skills-management.md) — the Skills control plane
  feature overview ([`skills-management-spec.md`](skills-management-spec.md)
  holds its binding delivered spec).
- [`session-analysis-sources.md`](session-analysis-sources.md) — what each
  harness can truthfully provide, per metric.
- [`provider-quota-data-sources.md`](provider-quota-data-sources.md) — quota
  windows and supported sources per provider (research, re-verified
  2026-08-08).
- [`future-work.md`](future-work.md) — the standing backlog and product
  guardrails.

## Dated records

- [`app-audit-2026-07-10.md`](app-audit-2026-07-10.md) — full application
  audit; findings remediated through the plans/ backlog.
- [`model-pricing-audit-2026-07-15.md`](model-pricing-audit-2026-07-15.md) —
  pricing research snapshot; the pricing table was updated from it.
- [`project-grouping-plan.md`](project-grouping-plan.md) — delivered grouping
  design (2026-07); paths predate later refactors.
- [`provider-status-windows-plan.md`](provider-status-windows-plan.md) —
  superseded early quota design, kept as historical context (see its banner).
- [`session-scroll-benchmark.md`](session-scroll-benchmark.md) — the plan 031
  decision measurements.
- [`performance/`](performance/) — measured baselines and optimization
  records (usage-engine I/O, web migration, session pipeline, plan 072
  artifacts). Each file states its measurement date and commit.
