# Skills management specification

## Status and scope

This document specifies the Skills management work delivered alongside, but independently from, the application-audit follow-ups recorded in `docs/app-audit-2026-07-10.md`.

The feature provides a local control plane for inspecting, editing, enabling, and projecting agent skills. It does not derive inventory from portable or manually imported usage data and does not mutate native project skill directories or unmanaged runtime entries.

## Requirements

### Configuration and discovery

- Configure one source repository and optional explicit project paths through the existing user-local ai-usage config.
- Discover project roots only from explicit configuration or one focused query of locally observed project sources that pass project-marker and safety checks. The query must not construct a complete report payload or include imported machines.
- Keep source state as JSON in the source repository; do not load executable configuration.
- Bound filesystem traversal and text reads, and report diagnostics instead of failing the complete inventory.

### Inventory and diagnostics

- Scan source skills, configured runtime targets, and eligible project-local skill directories.
- Validate `SKILL.md` frontmatter, name consistency, reference readability, and configured token thresholds.
- Distinguish managed symlinks, missing projections, unmanaged files/directories, invalid skills, and warning-only skills.
- Keep project-local observations read-only.

### Mutations

- Allow source skills to be enabled or disabled through source-state JSON.
- Preview bulk reconciliation before applying it.
- Create configured target directories only after an explicit user action.
- Reconcile valid enabled skills as managed symlinks and unlink only managed projections for disabled skills.
- Refuse to overwrite copied directories, unmanaged files, changed observations, or paths that escape configured roots.
- Serialize source-state and Markdown writes across processes and publish them atomically.

### Web experience

- Expose Skills as a first-class web route with global and project scopes, a runtime matrix, diagnostics, configuration, and reconciliation controls.
- Open each managed global `SKILL.md` as a directly editable source document without a preview-first mode or Edit button.
- Keep Save explicit through the document toolbar and `Ctrl+S` / `Cmd+S`. Saving updates the source repository only; installing or repairing runtime projections remains a separate action in the Inspector.
- Surface Saved, unsaved, saving, validation-error, and changed-on-disk states while preserving the exact local draft after revision conflicts or other save failures.
- Preserve dirty Markdown drafts across selection, refresh, and disk-reload operations. If a new snapshot removes the edited skill, require explicit discard before replacing the snapshot.
- Give the editor priority in the responsive layout: tree, document, then Inspector on wide screens; tree and document with the Inspector stacked after it at intermediate widths; compact picker, document, then Inspector on narrow screens.
- Keep project-owned `SKILL.md` documents read-only until a separate adoption workflow creates a canonical source document.
- Keep snapshot replacement, notices, dependent inventory refresh, and editor refresh behind one route-controller workflow.
- Provide deterministic desktop and narrow-viewport browser coverage for immediate editing, pointer and keyboard Save, source/runtime separation, conflict and discard protection, Inspector action ownership, configuration, filtering, reconciliation, project inventory, and unmanaged entries.

## Package boundaries

- `@ai-usage/skills` owns contracts, validation, bounded filesystem operations, scans, projections, Markdown IO, and workflows.
- `apps/web/src/server/skills*` owns server-function validation and adaptation.
- `apps/web/src/skills-route-controller.ts` owns route operations and snapshot replacement policy.
- `apps/web/src/routes/skills.tsx` composes route presentation and URL-backed selection.
- Browser-safe clients must use the documented `@ai-usage/skills/config` and `@ai-usage/skills/shared` exports and must not import server modules.

## Verification contract

- `bun x ultracite check`
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run test:tools`
- `bun run build`
- `bun run test:web-production`
- `bun run test:setup-loopback`
- `bun run test:e2e`, including `apps/web/e2e/skills.spec.ts`
- `bun run test:html-export`
- `bun run test:html-file`

The filesystem tests must use temporary directories and cover traversal limits, unsafe symlinks, concurrent writers, atomic replacement, stale observations, and unmanaged mutation refusal.
