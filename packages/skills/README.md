# @ai-usage/skills

`@ai-usage/skills` owns the local skill-management domain for `ai-usage`.

## Ownership

- Skill-management config types and runtime validation.
- JSON-only source repository state.
- Source repository scans and `SKILL.md` validation.
- Agent-runtime target observation.
- Projection planning, safe reconciliation, and diagnostics.
- Workflow functions consumed by app adapters.

## Non-Ownership

- Usage report row normalization and analytics stay in `@ai-usage/report-core`.
- Local history collection stays in `@ai-usage/local-collectors`.
- Web route rendering and TanStack Start server function facades stay in `apps/web`.
- Native rule formats are read-only diagnostics unless a later plan explicitly expands the mutation boundary.

## Dependencies

This package should stay independent from app packages, report-data, usage-store,
and usage-merge. It may use standard Node filesystem APIs behind
workflow functions and should expose JSON-safe data to app callers.

## Tests

Tests should exercise public package exports. Source-state, scanner,
projection, and workflow tests use temporary directories to verify real
filesystem behavior at package boundaries.
