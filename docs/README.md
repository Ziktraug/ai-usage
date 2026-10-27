# Documentation map

Two kinds of documents live here. **Living reference** is kept current and is
safe to rely on. **Dated records** are measurement snapshots that were true at
their stated date; they are retained for provenance, not maintained. When they
disagree with living reference, the living reference wins.

## Living reference

- [`architecture.md`](architecture.md) — data flow, process/package ownership,
  the data-plane/control-plane split.
- [`delegation.md`](delegation.md) — delegating read-only reviews from any MCP
  client: setup, MCP registration (Claude Code, Codex, generic stdio), the
  portable caller instruction, rules, results and limits.
- [`mcp.md`](mcp.md) — the local stdio MCP server: its tools, start,
  registration rules, and failure and redaction rules.
- [`local-store-upgrade.md`](local-store-upgrade.md) — operator procedure for
  moving the local usage store across code versions (backup, update, verify,
  recover) and its limits.
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
- [`provider-quota-data-sources.md`](provider-quota-data-sources.md) — quota
  windows and supported sources per provider (research, re-verified
  2026-08-08).
- [`future-work.md`](future-work.md) — the standing backlog and product
  guardrails.

## Dated records

- [`session-scroll-benchmark.md`](session-scroll-benchmark.md) — the plan 031
  decision measurements.
- [`performance/`](performance/) — measured baselines and optimization
  records (usage-engine I/O, web migration, session pipeline, plan 072
  artifacts). Each file states its measurement date and commit.
