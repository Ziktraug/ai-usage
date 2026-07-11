# Skills management specification

## Status and scope

This document specifies the Skills management work delivered alongside, but independently from, the application-audit follow-ups recorded in `docs/app-audit-2026-07-10.md`.

The feature provides a local control plane for inspecting, editing, enabling, and projecting agent skills. It does not derive inventory from synced usage data and does not mutate native project skill directories or unmanaged runtime entries.

## Requirements

### Configuration and discovery

- Configure one source repository and optional explicit project paths through the existing user-local ai-usage config.
- Discover project roots only from explicit configuration or locally observed report paths that pass project-marker and safety checks.
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
- Allow editing source `SKILL.md` files with revision conflict detection.
- Preserve dirty Markdown drafts across selection and refresh operations. If a new snapshot removes the edited skill, require explicit discard before replacing the snapshot.
- Keep snapshot replacement, notices, dependent inventory refresh, and editor refresh behind one route-controller workflow.
- Provide deterministic desktop and narrow-viewport browser coverage for configuration, filtering, editing, reconciliation, project inventory, and unmanaged entries.

## Package boundaries

- `@ai-usage/skills` owns contracts, validation, bounded filesystem operations, scans, projections, Markdown IO, and workflows.
- `apps/web/src/server/skills*` owns server-function validation and adaptation.
- `apps/web/src/skills-route-controller.ts` owns route operations and snapshot replacement policy.
- `apps/web/src/routes/skills.tsx` composes route presentation and URL-backed selection.
- Browser-safe clients must use the documented `@ai-usage/skills/config` and `@ai-usage/skills/shared` exports and must not import server modules.

## Verification contract

- `bun x ultracite check`
- `bun run typecheck`
- `bun run test`
- `bun run build`
- `bun run test:e2e`, including `apps/web/e2e/skills.spec.ts`
- Package-boundary checks through the root `check` task

The filesystem tests must use temporary directories and cover traversal limits, unsafe symlinks, concurrent writers, atomic replacement, stale observations, and unmanaged mutation refusal.
