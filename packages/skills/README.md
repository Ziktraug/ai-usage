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

`src/index.ts` is the explicit public facade. Keep implementation imports on the
smallest internal seam instead of importing the facade from inside the package:

- `contracts.ts`, `config.ts`, and `validation.ts` own JSON-safe contracts and input parsing;
- `filesystem.ts` owns bounded reads, cross-process locks, and atomic writes;
- `source-state.ts`, `source-scan.ts`, and `project-scan.ts` own inventory inputs;
- `skill-markdown.ts` and `skill-markdown-io.ts` own parsing and transactional editor IO;
- `projections.ts` owns target observation, planning, and safe projection mutations;
- `workflows.ts` composes those seams for application adapters.

Workspace-package imports are forbidden by both Biome and
`tools/check-package-boundaries.ts` so the control plane cannot acquire report,
store, transport, or app dependencies accidentally.

## Tests

Tests should exercise public package exports. Source-state, scanner,
projection, and workflow tests use temporary directories to verify real
filesystem behavior at package boundaries.
