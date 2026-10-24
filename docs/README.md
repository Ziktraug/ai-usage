# Documentation map

Three kinds of documents live here. **Living reference** is kept current and is
safe to rely on. **Pending removal** documents a dormant subsystem that plan 120
phase B deletes; it stays accurate for the code that still exists until then.
**Dated records** are measurement snapshots that were true at their stated
date; they are retained for provenance, not maintained. When they disagree with
living reference, the living reference wins.

## Living reference

- [`architecture.md`](architecture.md) — data flow, process/package ownership,
  the data-plane/control-plane split.
- [`local-store-upgrade.md`](local-store-upgrade.md) — operator procedure for
  moving the local usage and Memory SQLite stores across code versions
  (backup, update, verify, recover) and its limits.
- [`adr/`](adr/README.md) — the architecture decision index. Start here for
  "why is it like this".
- [`../CONTEXT.md`](../CONTEXT.md) — the ubiquitous language of the domain.
- [`public-package-interfaces.md`](public-package-interfaces.md) — current
  import seams.
- [`generated-tooling-ownership.md`](generated-tooling-ownership.md) — which
  generated trees exist and who owns them.
- [`skills-management.md`](skills-management.md) — the Skills control plane
  feature overview.
- [`session-analysis-sources.md`](session-analysis-sources.md) — what each
  harness can truthfully provide, per metric.
- [`session-distillation.md`](session-distillation.md) — explicit local Codex
  analysis batches, the active-harness skill, Session-panel reading, agent
  search/context, evidence limits and the separate generated corpus.
- [`provider-quota-data-sources.md`](provider-quota-data-sources.md) — quota
  windows and supported sources per provider (research, re-verified
  2026-08-08).
- [`identity-kernel.md`](identity-kernel.md) — stable local Space/Person/Device/
  Repository/Project identities in `memory.sqlite`, the authorization seam,
  resolution, and the local review service.
- [`authorization.md`](authorization.md) — the `Authorizer` port and the local
  single-user policy.
- [`future-work.md`](future-work.md) — the standing backlog and product
  guardrails.

## Pending removal (plan 120 phase B)

- [`device-replication.md`](device-replication.md) — the dormant outbound
  replication client and its SQLite outboxes; the server it published to is
  removed.
- [`memory-search-and-mcp.md`](memory-search-and-mcp.md) — accepted Memory
  search, its Web/CLI surfaces, and the MCP tools. Memory goes in phase B; the
  MCP server stays.

## Dated records

- [`session-scroll-benchmark.md`](session-scroll-benchmark.md) — the plan 031
  decision measurements.
- [`performance/`](performance/) — measured baselines and optimization
  records (usage-engine I/O, web migration, session pipeline, plan 072
  artifacts). Each file states its measurement date and commit.
