# Plan 005 Implementation Log

## 2026-07-02

- Step 1: Implemented curated discovered project paths with home exclusion, project-root markers, preserved configured path scanning, and no machine suffix in labels. Verified with `bun test apps/web/src/server/skills.server.test.ts`.
- Step 2: Split tree attention into actionable issue counts and quiet pending-link counts, alphabetized tree skills, demoted empty project scopes, added short paths and selection-key parsing. Verified with `bun test apps/web/src/skills-page-model.test.ts`.
- Step 3: Moved tree expansion state into the workspace, collapsed project scopes by default, added chevron toggles, single-line scope rows, sticky behavior from `lg`, and an empty-project fold.
- Step 4: Made source health permanent in the context panel, wired health rows to the matrix/global scope, and replaced project placeholders with copy actions plus read-only copy.
- Step 5: Added the read-only `getProjectSkillMarkdown` server function, validated allowed project/runtimes server-side, rendered project SKILL.md content with a runtime picker, and moved project observation/diagnostic counts into the detail metadata. Verified with `bun test apps/web/src/server/skills.server.test.ts` and `bun run typecheck`.
- Step 6: Added `/skills?sel=` validation, URL-backed selection updates, and replace-on-fallback behavior for stale selections. Verified with `bun run typecheck`.
- Step 7: Added cross-scope same-name skill matching and "Also present in" chips in skill details. Verified with `bun test apps/web/src/skills-page-model.test.ts`.
- Step 8: Updated docs and plan status. Verified with `bun x ultracite fix`, `bun test apps/web/src/server/skills.server.test.ts`, `bun test apps/web/src/skills-page-model.test.ts`, `bun run lint`, `bun run typecheck`, `bun run build`, and a `curl -I http://127.0.0.1:3000/skills` smoke check against `bun run --cwd apps/web dev:standalone`.

## 2026-07-02 - Post-review fixes

Live UI review (CDP) after the initial implementation surfaced four bugs and
several polish items; all fixed and re-verified live:

- Tree selection highlight was invisible: TanStack `Link` overrides manual
  `aria-current="true"` with `"page"` (prefix-matched), so the style never
  applied. Selection styling now uses `data-selected` via a shared
  `skills-selection-link.tsx` (deduplicated from tree + detail copies).
- Context-panel selection fought the URL-sync effect ("To consolidate" was a
  no-op; matrix rows worked only through unbatched timing and left mixed
  state). The URL is now the single source of truth: the workspace derives
  selection from the route, the matrix became the `/skills/matrix` route, and
  the context panel navigates instead of mutating local state. Stale deep
  links replace-redirect to `/skills`.
- `projectRouteKey` collided on duplicate basenames (silent first-match).
  Unambiguous names keep the short key; collisions fall back to the full
  path. `skillSelectionPath`/`parseSelectionKey`/`defaultSkillSelection` and
  the dead `skills-projects.tsx` were removed.
- Intra-repo symlinks (`.claude/skills/x` -> same-project dir) were classified
  `external-symlink` and pilled every project skill orange. The scanner now
  classifies them as the new `project-symlink` placement (healthy, "Symlink
  within project"), keeping `external-symlink` for out-of-project targets.
- Polish: real chevrons, short paths only shown when scope labels collide,
  tool data dirs (`~/.local/share`, `~/.cache`) excluded from discovery,
  "Needs attention" pills show issue counts with tooltips instead of a
  misleading validation status, skill tooltips show descriptions.

Verified with `bun run typecheck`, `bun run lint`, `bun test` (model, server,
skills package), and a CDP pass over highlight, health-row navigation, matrix
round-trips, browser back, stale deep links, and project SKILL.md rendering.
