# Future Work

Global backlog for known follow-ups that should survive individual refactor logs.

## Report Data Architecture

- Add fine-grained reporting query functions in `@ai-usage/reporting` for rows, analytics, harness status, facets, quota snapshots, and project/source summaries.
- Expose those fine-grained queries through TanStack Start server functions without leaking Effect services or collector internals to client code.
- Move the report UI from one compatibility `UsageReportPayload` signal toward independently loaded slices once the query seams exist.
- Keep `UsageReportPayload` for static HTML export and current bootstrapping until the app has migrated safely.
- Revisit the CLI quota adapter exception to `@ai-usage/local-collectors/codex-history` if quota output becomes part of shared reporting.

## Report UI Models

- Move the small `Hero` and `TokenAnatomy` presentation calculations out of `Overview.tsx` if those components grow again.
- Keep adding pure model tests when dashboard or overview calculations change.

## Sync UI

- Add optional live polling on `/sync` once manual refresh/start/stop flows have had real use.
- Add copy-to-clipboard affordances for served snapshot URLs if selectable text is not enough in practice.
- Consider richer inline editing for remote renames; the current edit form intentionally keeps the remote name fixed.
- Keep persistent config using `tokenEnv`; raw tokens should remain process-local or one-shot only.

## Design System

- Audit `@ai-usage/design-system/report` after another app exists or a second report surface appears.
- Promote genuinely reusable primitives from `@ai-usage/design-system/report` to the root `@ai-usage/design-system` API only when there is a concrete second consumer.
- Keep report-specific style slots in `@ai-usage/design-system/report` rather than making the root API app-specific.

## Tooling And Generated Files

- Revisit direct `bun --filter @ai-usage/design-system build` calls in `apps/report` scripts if all local workflows move through `turbo run`.
- Keep `docs/generated-tooling-ownership.md` updated when Panda, TanStack Router, Vite, Nitro, or Turbo generated outputs change.

## Source Logs

- `docs/report-data-architecture-refactor-log.md` contains the original report-data refactor history and the first set of follow-ups.
