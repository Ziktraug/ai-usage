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
