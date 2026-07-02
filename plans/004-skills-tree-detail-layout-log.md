# Plan 004 Log: Skills Tree + Detail Workspace

## 2026-07-02

### Step 1 - Workspace model

- Added `SkillSelection`, tree node models, global exposure rows, project skill
  row grouping, attention counts, selection keys, and default selection helpers
  in `apps/web/src/skills-page-model.ts`.
- Added model coverage for global/project tree sorting, default selection,
  exposure synthesis, and project observation grouping.
- Verified with `bun test apps/web/src/skills-page-model.test.ts`.

### Steps 2-7 - Workspace UI and secondary matrix

- Added the three-pane workspace:
  - `skills-tree.tsx` for Global/project scope navigation.
  - `skills-detail.tsx` for scope overviews, global skill detail, project
    detail, runtime exposure, diagnostics, and the global `SKILL.md` editor.
  - `skills-context-panel.tsx` for contextual health/actions.
  - `skills-workspace.tsx` for selection state and the Detail/Matrix mode.
- Replaced the `/skills` tabs and drawer selection with the workspace in
  `apps/web/src/routes/skills.tsx`.
- Kept `SkillsMatrix` as a secondary exposure view. Matrix row activation now
  selects the same central global-skill detail instead of opening a drawer.
- Preserved existing server calls for toggle, reconcile, reconcile preview,
  config save, target directory creation, and `SKILL.md` save.
- Verified with:
  - `bun run typecheck`
  - `bun test apps/web/src/skills-page-model.test.ts`
  - `bun test apps/web/src/server/skills.server.test.ts`

### Step 9 - Docs

- Updated `docs/skills-management.md` to describe the new hierarchy:
  `Global / Project -> Skill -> Runtime exposure`.

