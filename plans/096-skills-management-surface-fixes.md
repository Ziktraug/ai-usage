# Plan 096: Skills Management Surface Fixes — Legible Tree, Honest Statuses, One Health Surface, Matrix Geometry, Frontmatter False Positives

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/skills/shell/skills-tree.svelte apps/web/src/lib/features/skills/shell/skills-workspace.svelte apps/web/src/lib/features/skills/shell/skills-convergence.fixture.svelte apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts apps/web/src/lib/features/skills/management/skills-health-slot.svelte apps/web/src/lib/features/skills/management/skills-health.svelte apps/web/src/lib/features/skills/management/skills-matrix.svelte apps/web/src/lib/features/skills/management/model.ts apps/web/src/lib/features/skills/management/model.test.ts apps/web/src/lib/features/skills/management/management.ssr.test.ts apps/web/src/lib/features/skills/editor/skill-markdown-editor.svelte apps/web/src/lib/features/skills/editor/editor-components.ssr.test.ts apps/web/src/skills-page-model.ts apps/web/src/skills-page-model.test.ts apps/web/src/server/skills-e2e-fixture.server.ts apps/web/src/server/skills-e2e-fixture.server.test.ts apps/web/e2e/skills.spec.ts packages/skills/src/skill-markdown.ts packages/skills/src/skill-markdown.test.ts docs/skills-management-spec.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. One expected exception: plan 087
> (executed before this one in the program order) may have edited
> `editor/skill-markdown-editor.svelte`, `editor/controller.ts`, or
> `editor/slot-controller.ts` for the "Loading…" bug. If only those files
> drifted, re-locate the `documentStatus` excerpt in Current state §C by
> content (the `return { error: false, label: 'Saved', tone: statusPillOk }`
> line) and continue; anything else is a STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW–MED (layout changes on a tested responsive surface; one e2e fixture addition; one visual snapshot regeneration)
- **Depends on**: none. Program order (plan 086) runs 087 before this plan; both touch `editor/skill-markdown-editor.svelte` — see the drift-check exception above.
- **Category**: remediation (presentation + validation honesty)
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U24 (all parts except the "adopt" action, which is plan 083), U25, U26

## Why this matters

The `/skills` surface is the maintainer's inventory of every Agent Skill on
the machine — scope, invocation, origin, state, exposure. The fresh-eyes audit
found that the surface contradicts its own "hierarchize, don't drown" rule in
several small, independent ways:

- the left tree truncates scope names to nearly identical prefixes while a
  wide desktop page leaves substantial horizontal space unused, so sibling
  scopes become indistinguishable exactly when a disambiguating path is
  rendered (the path steals the name's width);
- a "Skills reloaded." toast appears on every passive page load, announcing
  that nothing changed;
- the SKILL.md editor says "Saved" on a file nobody touched, so the word
  "Saved" stops meaning anything after an actual save;
- an incomplete "Healthy links" ratio is rendered in the same neutral tone as
  a zero-valued "Blocked" indicator;
- the right-hand Context panel repeats the health summary that the centre
  column already shows as tiles (and, on the matrix route, repeats the same
  clickable tiles);
- on `/skills/matrix` the tiles are forced into an over-dense grid inside a
  narrow centre column (multi-line captions, "TO CONSOLIDATE" clipped), skill
  names break letter-by-letter because a `table-layout: fixed` table with a
  hard minimum width divides its width equally among every column, and the
  whole matrix scrolls horizontally while the Context column next to it is
  almost empty;
- validation flags `compatibility`, `argument-hint`, `allowed-tools` (and
  other documented fields) as `UnknownFrontmatterField`, so the real token
  warnings drown in false positives.

Each fix is small; together they make the Skills surface say each thing once,
in the right tone, with names you can read. The "To consolidate · N entries"
dead end (no adopt action) is deliberately **not** addressed here — it is
plan 083's design-gated feature.

## Current state

All paths are relative to the worktree root. Line numbers were read at
`51815b70`.

### A. Tree truncation (U24) — `apps/web/src/lib/features/skills/shell/skills-tree.svelte`

- line 121: `const label = css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });`
  — used for skill rows (line 231 `<span class={label}>{skill.name}</span>`)
  **and** for empty-scope rows (line 254 `class={cx(label, scopeName)}`).
- lines 122–129: the scope label is a single-line flex row:
  ```ts
  const scopeLabel = css({
    display: 'flex',
    minW: 0,
    gap: '6px',
    alignItems: 'baseline',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  });
  ```
  lines 130–136 `scopeName` (block, ellipsis, nowrap) and lines 137–144
  `scopePath` (muted 12 px, ellipsis, nowrap, `minW: 0`). Markup at lines
  212–217: name `<span class={cx(strongCell, scopeName)} data-skill-scope-name title={scope.label}>`
  followed by `{#if scope.shortPath}<span class={scopePath}>{scope.shortPath}</span>{/if}`.
  **Root cause**: both flex items have `flex-shrink: 1` and `min-width: 0`,
  so when name + path overflow the row, both shrink *proportionally to their
  content width* — a shorter name beside a much longer path keeps only a
  fraction of its width. That is the nearly identical truncated-prefix
  symptom, and it only appears when `shortPath` is present, i.e. exactly when
  two scopes share
  a label and need telling apart (`apps/web/src/skills-page-model.ts:508-510`:
  `...((labelCounts.get(label) ?? 0) > 1 ? { shortPath: shortPathFor(project.path) } : {})`).
- `apps/web/src/lib/features/skills/shell/skills-workspace.svelte:165-171`:
  ```ts
  const workspaceGrid = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', lg: '240px minmax(0, 1fr)', xl: '240px minmax(0, 1fr) 288px' },
    columnGap: '16px',
    rowGap: '16px',
    alignItems: 'start',
  });
  ```
  The tree column is 240 px at every desktop width. The shell is capped at
  `maxWidth: '1380px'` (`packages/design-system/src/components/layout.ts:22-27`)
  behind a rail of `ml: { base: 0, md: '56px', xl: '216px' }`
  (`apps/web/src/lib/features/shell/app-shell.svelte:37`), so at the audited
  wide desktop viewport the fixed outer columns leave the centre column and
  the tree's label cell much narrower than the available page (panel padding,
  toggle, gap, button padding and the count badge consume the remaining label
  width). Panda's default `2xl` breakpoint (1536 px) is unused anywhere
  in `apps/web/src` today (`grep -rn "'2xl'" apps/web/src` → no hits).
- Existing e2e coverage: `apps/web/e2e/skills.spec.ts:421-441` ("bounds long
  scope labels…") asserts the 66-character `LONG_PROJECT_LABEL` still
  ellipsises inside its link; `skills.spec.ts:331-419` ("keeps the tree,
  editor, and Inspector in one bounded desktop workspace row") asserts
  `treeBox.width >= MIN_DESKTOP_TREE_WIDTH_PX` (190) at 1280×900. Neither
  renders a scope with a `shortPath`; the e2e fixture
  (`apps/web/src/server/skills-e2e-fixture.server.ts:185-203`,
  `readExtendedE2EKnownSkillProjectPaths`) has one grouped project
  (`groupId: 'project/opaque'`, `groupLabel: 'Opaque project'`) and one
  ungrouped long-label project, no label collision.

### B. Passive "Skills reloaded." toast (U24) — `apps/web/src/lib/features/skills/management/skills-health-slot.svelte`

- lines 98–99: `let hydrationReloadAnnounced = $state(false);` /
  `const hydrationSnapshot = untrack(() => context.snapshot);`
- lines 286–304:
  ```ts
  $effect(() => {
    const nextSnapshot = context.snapshot;
    if (!(mounted && !hydrationReloadAnnounced && nextSnapshot !== hydrationSnapshot)) {
      return;
    }
    hydrationReloadAnnounced = true;
    if (!ownsRefreshRegistration) {
      return;
    }
    if (
      shouldAnnounceSkillsHydrationReload(
        hydrationSnapshot,
        nextSnapshot,
        operationMessage !== null || operationError !== null,
      )
    ) {
      setSuccessMessage('Skills reloaded.');
    }
  });
  ```
- `apps/web/src/lib/features/skills/management/model.ts:136-143`:
  ```ts
  export const shouldAnnounceSkillsHydrationReload = (
    hydrationSnapshot: SkillManagementSnapshot,
    nextSnapshot: SkillManagementSnapshot,
    operationNoticePresent: boolean,
  ): boolean =>
    hydrationSnapshot !== nextSnapshot &&
    !operationNoticePresent &&
    skillsSnapshotAcceptanceSignature(hydrationSnapshot) === skillsSnapshotAcceptanceSignature(nextSnapshot);
  ```
  i.e. it announces precisely when the post-hydration refetch returned a
  snapshot with **identical content** — a notice that nothing changed, on
  every load. Its only test is `model.test.ts:263-274` ("announces only
  same-content hydration replacement and retains mutation notices"). The
  explicit-refresh notice ("Skills refreshed.", lines 305–328 and
  `skills.spec.ts:267`) is a separate path and stays.
- Plan 046 item 26 already shortened this banner to a 5 s auto-dismiss
  (`SUCCESS_MESSAGE_DURATION_MS`, `passiveOperationNotice` in
  `management/styles.ts:104`); the audit confirms it is still noise.

### C. Editor "Saved" on an untouched file (U24) — `apps/web/src/lib/features/skills/editor/skill-markdown-editor.svelte`

- lines 125–148, `documentStatus`: the last branches are
  ```ts
  if (next.message === 'SKILL.md saved; newer edits remain unsaved.') {
    return { error: false, label: next.message, tone: statusPillWarn };
  }
  if (next.message !== null && next.message !== 'SKILL.md saved.') {
    return { error: true, label: next.message, tone: statusPillDanger };
  }
  if (next.dirty) {
    return { error: false, label: 'Unsaved changes', tone: statusPillWarn };
  }
  return { error: false, label: 'Saved', tone: statusPillOk };
  ```
  The fall-through returns "Saved" for a freshly loaded, never-modified
  document. The controller already distinguishes the two states:
  `editor/controller.ts:38-39` `savedMessage(...)` → `'SKILL.md saved.'`
  is published only by `save()` (lines 216–223); a settled load/accept leaves
  `message: null` (lines 118–128 `acceptDocument`), and `discardDraft`
  (lines 132–145) and `setDraft` (lines 252–256) reset `message: null`.
  So `message === 'SKILL.md saved.'` ⇔ "saved in this session".
- Pinned strings: `editor/editor-components.ssr.test.ts:52`
  `expect(html).toContain('Saved');` (settled fixture);
  `apps/web/e2e/skills.spec.ts` lines 54 and 225 (after load / after
  discard-and-reload — both are the *untouched* state), line 338
  (`const editorStatus = detail.getByText('Saved', { exact: true });` used
  for toolbar geometry at 1280×900), and lines 66, 83, 96, 184 (after a
  real save — these stay "Saved"); line 91 asserts `'Saved'` count 0 after
  a follow-up edit.
- `docs/skills-management-spec.md:39`: "Surface Saved, unsaved, saving,
  validation-error, and changed-on-disk states …".
- The brief's anchor `apps/web/src/skill-markdown-editor-model.ts` is a
  legacy controller imported **only** by its own test
  (`grep -rn "skill-markdown-editor-model" apps/web/src apps/web/e2e` → the
  test file only); the live editor uses `lib/features/skills/editor/controller.ts`.
  Do not touch the legacy file.
- The visual snapshot `apps/web/e2e/visual-regression.spec.ts:333-342`
  (`skills-desktop.png`, `SKILLS_MAX_DIFF_PIXELS = 12`) captures
  `/skills/global/alpha-skill` with the status pill visible; it will need
  regeneration.

### D. Health numbers: no alert tone, shown twice (U24)

- `apps/web/src/lib/features/skills/shell/skills-workspace.svelte:323-340`
  (global-scope detail) renders four static tiles:
  `Healthy links {health.healthyLinkCount}/{health.expectedLinkCount}`,
  `To repair`, `Blocked`, `To consolidate … copies / … symlinks` — all in
  `metadataItem` with no tone.
- `apps/web/src/lib/features/skills/management/skills-health-slot.svelte:416-439`
  (inspector placement, global-scope) renders the **same four numbers** as
  `sourceHealthRow` buttons (`Healthy links`, `To repair`, `Blocked`,
  `To consolidate`) under "Source health / Managed runtime exposure", then
  lines 440–457 the action buttons `Exposure matrix`/`Close matrix` and
  `Preview reconcile`. On `/skills/matrix` the same inspector block sits
  beside the six clickable tiles of `skills-health.svelte`.
- `apps/web/src/lib/features/skills/management/skills-health.svelte:42-58`:
  `<section class={metricGrid}>` then the Healthy-links tile's value
  `<div class={metricValue}>{summary.healthyLinkCount}</div>` with no tone;
  `Broken`/`Blocked` use `dangerValue` when > 0 (lines 81, 96) and
  `To consolidate` uses `warningValue` (line 105).
- `apps/web/src/skills-page-model.ts:112-122` `SkillHealthSummary` and
  643–680 `buildSkillHealthSummary` (`expectedLinkCount: countableSkills.length * activeTargets.length`).
  Tests: `apps/web/src/skills-page-model.test.ts:498-528`.
- Fixtures: `management/synthetic-fixture.test-helper.ts`
  (`syntheticManagementSnapshot()`) has one enabled countable skill and one
  enabled target with a `missing` projection → `healthyLinkCount 0 / expectedLinkCount 1`
  — a ready-made "0/N" case. `shell/skills-convergence.fixture.svelte`
  composes the real workspace + real slots but uses the shell
  `syntheticSnapshot()` (no targets).
- e2e: `skills.spec.ts:468-514` asserts on `/skills/global` at 1440×1000 that
  the `Selection actions` inspector shows `Exposure matrix` and is
  `< 350 px` tall; `skills.spec.ts:579-602` asserts on `/skills/matrix` at
  1280×800 that the inspector shows `Close matrix` and is `< 350 px` tall.

### E. Matrix geometry (U25)

- `apps/web/src/lib/features/skills/management/skills-health.svelte:3,42`
  uses the design-system `metricGrid`
  (`packages/design-system/src/components/metric-tile.ts:3-12`):
  `gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))', xl: 'repeat(7, minmax(0, 1fr))' }, gap: '10px', my: '20px'`.
  Seven columns for six tiles inside the ~700 px centre column → ~90 px
  tiles → five-line captions. `skills-health.svelte` is the **only**
  consumer of the shared `metricGrid`
  (`grep -rn "metricGrid" apps/web/src --include=*.svelte` → this file and a
  local const of the same name in `cursor-attribution-panel.svelte`).
- `apps/web/src/lib/features/skills/management/skills-matrix.svelte`:
  - line 45: `const matrixTable = css({ minW: '860px' });`
  - line 46: `const matrixWrap = css({ minH: 'auto', display: { base: 'none', md: 'block' } });`
  - lines 79–87: `stickyCol` (`position: sticky, left: 0, … minW: '320px', textAlign: 'left'`)
  - lines 88–97: `skillCell` (`maxW: '440px'`), `skillTop` (`display: 'flex'`), and
    ```ts
    const skillName = css({
      overflow: 'hidden',
      overflowWrap: 'anywhere',
      whiteSpace: 'normal',
      textAlign: 'left',
      lineHeight: 1.25,
      maxH: '2.5em',
    });
    ```
  - lines 310–318: `<div class={cx(tableWrap, matrixWrap)}><table class={cx(table, matrixTable)}>` with
    `<th class={stickyCol}>Skill</th>` then one `<th>` per target.
  - lines 339–343 and 397–401: the name is
    `<a class={cx(strongCell, skillName, skillNameButton, …)} href=…>{row.name}</a>`.
  - The shared `table` recipe (`packages/design-system/src/components/table.ts:3-8`)
    sets `width: '100%', minW: '1040px', tableLayout: 'fixed'`. In fixed
    layout the column widths come from the first row's `width` values, not
    from `min-width`; no cell here has a `width`, so every column —
    including the Skill column — gets `tableWidth / (targets + 1)`. In the
    audited many-target case, the matrix-specific minimum width is divided
    into columns too narrow for skill names, and `overflowWrap: 'anywhere'`
    (also on `strongCell`,
    `table.ts:124`) lets the name break at any character → "pr-/revi".
    Pre-check you can run: with the 2-target e2e fixture the Skill `th`
    measures ~287 px (860/3), **below** its declared `minW: 320px` — proof
    the min-width is ignored.
  - `cx(table, matrixTable)` and `cx(tableWrap, matrixWrap)` each keep two
    conflicting atoms (`min-w`, `min-h`); which wins is stylesheet order
    (repo pitfall, see `plans/README.md` presentation notes). Do not add a
    third competing atom; use a child selector (Step 5).
- Workspace columns on the matrix route: `skills-workspace.svelte:165-171`
  (above) keeps the 288 px Context column at `xl` even when
  `view.matrixOpen` (line 299: `{#if view.matrixOpen}` … `data-skills-matrix-slot`),
  and `skills-workspace.svelte:261`
  `const mobileContext = css({ display: { base: 'block', xl: 'contents' }, gridColumn: { lg: '2', xl: 'auto' } });`
  places the inspector beside the matrix at `xl`. With the rail, shell padding
  and panel padding (`panel`,
  `packages/design-system/src/components/panel.ts:7`), the centre column
  remains narrow even at a wide desktop viewport.
- e2e: `skills.spec.ts:579-602` (1280×800) asserts the table is visible,
  `border-collapse: separate`, `font-size: 13px`, the state dot is 15 px,
  and the inspector's `Close matrix` is visible with height < 350.

### F. Frontmatter false positives (U26) — `packages/skills/src/skill-markdown.ts`

- lines 16–17:
  ```ts
  const knownFrontmatterExtensions = new Set(['paths', 'disable-model-invocation']);
  const standardFrontmatterFields = new Set(['name', 'description']);
  ```
- lines 44–52 `classifyFrontmatterField` → `'standard' | 'known-extension' | 'unknown-extension'`;
  lines 142–150 emit `createDiagnostic('UnknownFrontmatterField', 'warning', \`Unknown SKILL.md frontmatter field: ${field.key}\`, …)`
  for every `unknown-extension`. `validationStatusFor` (lines 107–119)
  turns any `warning` diagnostic into `validationStatus: 'warning'`, so a
  legitimate field flips the whole skill to "warning" and appears as a
  "Finding" in the inspector (`skills-health-slot.svelte:460-494`).
- Both scanners go through this parser: `source-scan.ts:252`
  `parseSkillMarkdown(skillName, skillMdText)` is used by `scanOneSkill`,
  which `project-scan.ts:22` reuses. One list change fixes global and
  project skills.
- The parser (lines 54–100) reads top-level `key:` lines, collects `- item`
  lists for empty scalars, and skips indented lines — nested mappings such
  as `metadata:` or `hooks:` parse as `[]`; that is fine for classification.
- Tests: `packages/skills/src/skill-markdown.test.ts:5-28` pins
  `['paths','known-extension'], ['disable-model-invocation','known-extension']`
  with `diagnostics` `[]`; lines 46–64 pin that `custom-value` is
  `unknown-extension` with an `UnknownFrontmatterField` diagnostic.
- Repo-confirmed documentation of known fields: only `name`, `description`,
  `paths`, `disable-model-invocation`
  (`plans/001-integrate-skill-management.md:440-443`,
  `plans/001-integrate-skill-management-log.md:240`). The repository
  documents **no other** SKILL.md field; the lists below come from outside
  the repo and the executor must confirm them (Step 6).
- Generalized discovery suggested additional frontmatter keys including
  `compatibility`, `argument-hint`, `allowed-tools`, `metadata`, `environments`,
  `version`, `license`, and `disabled-environments`. Exact private discovery
  paths and counts are omitted; the executor must confirm upstream support.
- Claude Code's skills documentation ("Frontmatter reference", public docs
  at `https://code.claude.com/docs/en/skills`; **not** reproduced in this
  repo — verify) lists: `name`, `description`, `argument-hint`,
  `disable-model-invocation`, `user-invocable`, `allowed-tools`, `model`,
  `context`, `agent`, `hooks`. The Agent Skills open specification
  (`https://agentskills.io`, "SKILL.md frontmatter"; also not in this repo —
  verify) lists `name`, `description`, `license`, `compatibility`,
  `metadata`, `allowed-tools`. `paths` and `disable-model-invocation` are
  the Cursor extensions the repo already accepts.
- `apps/web/src/lib/features/skills/management/skill-diagnostics.svelte` (a
  brief anchor) has **no importer** (`grep -rn "skill-diagnostics" apps/web/src apps/web/e2e` → nothing);
  the live diagnostics list is `skills-health-slot.svelte:460-494`. Do not
  touch it here.
- The diagnostic is computed at scan time and persisted in the snapshot;
  after the change the user sees the effect on the next "Refresh skills" /
  engine rescan — no migration needed.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (worktree has no `node_modules`) | `bun install` | exit 0 |
| Prepare SvelteKit + Panda output (needed before running single web test files) | `bun run --cwd apps/web dev:prepare` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Format + lint | `bun x ultracite fix && bun run lint` | exit 0 |
| Skills package tests | `cd packages/skills && bun test src/skill-markdown.test.ts` | all pass |
| One web unit/SSR file | `cd apps/web && bun test src/<path>.test.ts` | all pass |
| All web unit/SSR tests | `bun run --cwd apps/web test` | all pass |
| One e2e spec | `cd apps/web && bun run test:e2e -- e2e/skills.spec.ts` | all pass |
| Visual snapshot refresh | `cd apps/web && bun run test:e2e -- e2e/visual-regression.spec.ts --update-snapshots` | regenerates `skills-desktop-linux.png` |
| Full e2e | `bun run --cwd apps/web test:e2e` | all pass |
| PII guard | the case-insensitive grep from plan 086 "Cross-cutting rules → PII", run against this plan file | no output |

On NixOS, if Playwright's downloaded Chromium fails to launch, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary (documented
local workaround; `--channel chrome` does not work here).

## Scope

**In scope** (the only files you may modify):
- `apps/web/src/lib/features/skills/shell/skills-tree.svelte`
- `apps/web/src/lib/features/skills/shell/skills-workspace.svelte`
- `apps/web/src/lib/features/skills/shell/skills-convergence.fixture.svelte` (test fixture: optional management snapshot)
- `apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts`
- `apps/web/src/lib/features/skills/management/skills-health-slot.svelte`
- `apps/web/src/lib/features/skills/management/skills-health.svelte`
- `apps/web/src/lib/features/skills/management/skills-matrix.svelte`
- `apps/web/src/lib/features/skills/management/model.ts`
- `apps/web/src/lib/features/skills/management/model.test.ts`
- `apps/web/src/lib/features/skills/management/management.ssr.test.ts`
- `apps/web/src/lib/features/skills/editor/skill-markdown-editor.svelte` (only the last branches of `documentStatus`)
- `apps/web/src/lib/features/skills/editor/editor-components.ssr.test.ts`
- `apps/web/src/skills-page-model.ts`, `apps/web/src/skills-page-model.test.ts`
- `apps/web/src/server/skills-e2e-fixture.server.ts`, `apps/web/src/server/skills-e2e-fixture.server.test.ts`
- `apps/web/e2e/skills.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts-snapshots/skills-desktop-linux.png` (regenerated only)
- `packages/skills/src/skill-markdown.ts`, `packages/skills/src/skill-markdown.test.ts`
- `docs/skills-management-spec.md` (two bullets)

**Out of scope** (do NOT touch):
- The "adopt unmanaged skill into source" action behind "To consolidate" —
  **plan 083** (design-gated). `skills-consolidate.svelte` stays as is.
- The editor "Loading…" bug after client-side navigation — **plan 087**
  (`editor/controller.ts`, `editor/slot-controller.ts`,
  `shell/skills-shell.svelte`, `shell/data.ts`, `shell/snapshot-controller.ts`).
  This plan only changes the untouched-document label in `documentStatus`.
- `packages/design-system/**` — `metricGrid`, `table`, `tableWrap`, `panel`
  stay unchanged; every layout fix lives in the Skills components.
- `apps/web/src/skills-responsive.ts` (breakpoint constants are right),
  `shell/skills-inspector.svelte` (the duplicate rows live in the health
  slot, not in the inspector shell), `management/styles.ts`,
  `management/skill-diagnostics.svelte` (dead, unreferenced),
  `apps/web/src/skill-markdown-editor-model.ts` (dead legacy controller).
- Severity of `UnknownFrontmatterField` stays `warning` — a typo such as
  `descripton` must still surface. Only the known-field list grows.

## Git workflow

- Work on the program branch (`plan/086-ui-ux-audit-remediation`), one commit
  for this plan. Peer sessions may write to the same worktree: stage by
  explicit path, never `git add -A`.
- Commit subject = this plan's title, e.g.
  `Skills management surface fixes: legible tree, honest statuses, one health surface, matrix geometry, frontmatter known fields`.
- Run the PII guard before committing. Do NOT push or open a PR unless the
  operator instructed it.

## Steps

### Step 1: Give tree names the full row (U24 tree)

File: `apps/web/src/lib/features/skills/shell/skills-tree.svelte`.

1. Replace the flex `scopeLabel` (lines 122–129) with a two-line stack so
   the disambiguating path can no longer shrink the name:
   ```ts
   const scopeLabel = css({ display: 'grid', gap: '1px', minW: 0 });
   ```
   Keep `scopeName` (130–136) as is. In `scopePath` (137–144) set
   `fontSize: '11px'` and add `lineHeight: 1.3`; in the markup (line 215) add
   `data-skill-scope-path` to the path span. Name first, path second,
   exactly as today.
2. Add a dedicated skill-row label class and use it at line 231 (leave the
   `label` const untouched — it is still composed with `scopeName` for
   empty-scope rows at line 254, and changing `white-space` there would
   create a `cx` conflict):
   ```ts
   const skillLabel = css({ minW: 0, lineClamp: 2, overflowWrap: 'break-word', lineHeight: 1.3 });
   ```
   `lineClamp` is the Panda utility already used by `sessionTitleClamp`
   (`packages/design-system/src/components/table.ts:137-139`); kebab-case
   names wrap after their hyphens first and only break inside a segment as a
   last resort. Do not use `overflowWrap: 'anywhere'` here — that is what
   allows letter-by-letter breaking.
3. File `apps/web/src/lib/features/skills/shell/skills-workspace.svelte`,
   `workspaceGrid` (lines 165–171): add a `'2xl'` entry so the spare width at
   1536 px+ goes to the tree:
   `gridTemplateColumns: { base: '1fr', lg: '240px minmax(0, 1fr)', xl: '240px minmax(0, 1fr) 288px', '2xl': '280px minmax(0, 1fr) 288px' }`.
4. Fixture: in `apps/web/src/server/skills-e2e-fixture.server.ts`
   `readExtendedE2EKnownSkillProjectPaths` (line 185) **append** a twin of the
   opaque project with the same label and a different group/path, and in
   `readExtendedE2ESkillProjectInventories` (line 205) append one inventory
   for it so it renders as a populated scope (only populated scopes show the
   path — empty ones live under "Projects without skills"):
   ```ts
   {
     groupId: 'project/opaque-twin',
     groupLabel: 'Opaque project',
     label: 'opaque-project-source',
     path: '/fixture/work/opaque-project-source',
     project: 'opaque-project-twin',
     sessions: 1,
   },
   ```
   ```ts
   {
     diagnostics: [],
     observations: [
       {
         description: 'Opaque twin project skill fixture',
         diagnostics: [],
         invocation: 'auto',
         markdownReadable: true,
         name: 'twin-skill',
         path: '/fixture/work/opaque-project-source/.agents/skills/twin-skill',
         placement: 'owned-directory',
         runtimeDirId: 'agents-project',
         skillMdPath: '/fixture/work/opaque-project-source/.agents/skills/twin-skill/SKILL.md',
         tokenCount: { approximate: true, references: 0, skillMd: 4, total: 4 },
         validationStatus: 'valid',
       },
     ],
     projectPath: '/fixture/work/opaque-project-source',
   },
   ```
   Append only — `skills-e2e-fixture.server.test.ts:24-35` reads `data[0]`.
   The `visual` variant (`readE2EKnownSkillProjectPaths`, used by the
   screenshot test) is untouched.
5. e2e, `apps/web/e2e/skills.spec.ts`: add
   `test('keeps colliding scope names legible and says each health number once', …)`:
   - `await page.setViewportSize({ height: 1080, width: 1920 }); await openHydratedSkills(page, '/skills/global');`
   - `const tree = page.getByRole('complementary', { exact: true, name: 'Skill scopes' });`
   - `const twins = tree.locator('[data-skill-scope-name]').filter({ hasText: 'Opaque project' }); await expect(twins).toHaveCount(2);`
   - for each twin: `evaluate((el) => el.scrollWidth <= el.clientWidth)` → `true`
     (the name is no longer ellipsised) and `title === textContent.trim()`.
   - `const paths = tree.locator('[data-skill-scope-path]'); await expect(paths).toHaveCount(2);`
     and for each path:
     `evaluate((el) => { const name = el.previousElementSibling; return name instanceof HTMLElement && name.hasAttribute('data-skill-scope-name') && el.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1; })`
     → `true` (the path sits under the name, not beside it).
   - `expect((await tree.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(272);` (2xl column).
   - `await expect(tree.getByRole('link', { name: /alpha-skill/ }).locator('span').first()).toHaveCSS('-webkit-line-clamp', '2');`
   - the two assertions from Steps 2 and 4 below (no reload toast; one
     "Healthy links") also go in this test.
   - then `await page.setViewportSize({ height: 900, width: 1280 });` and
     re-run the two twin `scrollWidth <= clientWidth` checks (the fix must
     hold at the narrow desktop width too).

**Verify**: `cd apps/web && bun run test:e2e -- e2e/skills.spec.ts` → the
new test passes; the existing "bounds long scope labels…" and "keeps the
tree, editor, and Inspector…" tests still pass; `cd apps/web && bun test src/server/skills-e2e-fixture.server.test.ts` → pass.
Before Step 1 the twin `scrollWidth <= clientWidth` check fails (names are
ellipsised beside their paths).

### Step 2: Remove the passive reload announcement (U24 toast)

1. `apps/web/src/lib/features/skills/management/skills-health-slot.svelte`:
   delete lines 286–304 (the `$effect` that calls
   `shouldAnnounceSkillsHydrationReload`), lines 98–99
   (`hydrationReloadAnnounced`, `hydrationSnapshot`), the
   `shouldAnnounceSkillsHydrationReload` import (line 53), and `untrack` from
   the `svelte` import (line 18) if it is now unused. Keep everything about
   "Skills refreshed." (explicit refresh) untouched.
2. `apps/web/src/lib/features/skills/management/model.ts`: delete
   `shouldAnnounceSkillsHydrationReload` (lines 136–143). Keep
   `skillsSnapshotAcceptanceSignature` — it is still used by the refresh
   path.
3. `apps/web/src/lib/features/skills/management/model.test.ts`: delete the
   import (line 14) and the test at lines 263–274.
4. e2e (inside the Step 1 test, after `openHydratedSkills`):
   `await expect(page.getByRole('status').filter({ hasText: 'Skills reloaded.' })).toHaveCount(0);`
   `data-skills-hydrated="true"` is set only after every Skills query has
   settled (`shell/skills-shell.svelte:201-215`), which is after the old
   effect would have fired, so the assertion is meaningful.

**Verify**: `grep -rn "Skills reloaded\|shouldAnnounceSkillsHydrationReload\|hydrationReloadAnnounced" apps/web/src apps/web/e2e` → no matches;
`cd apps/web && bun test src/lib/features/skills/management/model.test.ts` → pass;
the existing e2e "refreshes the skills snapshot…" (`skills.spec.ts:235-277`, notice at line 267) still sees "Skills refreshed.".

### Step 3: Say "Saved" only after a save (U24 editor status)

1. `apps/web/src/lib/features/skills/editor/skill-markdown-editor.svelte`,
   `documentStatus` (lines 141–147): replace the final two branches with
   ```ts
   if (next.dirty) {
     return { error: false, label: 'Unsaved changes', tone: statusPillWarn };
   }
   if (next.message === 'SKILL.md saved.') {
     return { error: false, label: 'Saved', tone: statusPillOk };
   }
   return { error: false, label: 'Unchanged', tone: statusPillInfo };
   ```
   (`statusPillInfo` is already imported at line 8.) Leave the `Loading…`,
   `Saving…`, conflict, error and follow-up-draft branches alone — plan 087
   owns the loading path.
2. `editor/editor-components.ssr.test.ts:52`: change to
   `expect(html).toContain('Unchanged'); expect(html).not.toMatch(/>Saved</);`
   (the settled fixture is a freshly loaded document).
3. `apps/web/e2e/skills.spec.ts`: lines 54 and 225 (untouched states) →
   `'Unchanged'`; line 338 → `const editorStatus = detail.getByText('Unchanged', { exact: true });`.
   Lines 66, 83, 96, 184 (after a real save) stay `'Saved'`; line 91 stays.
4. `docs/skills-management-spec.md:39`: "Surface unchanged, saved (this
   session), unsaved, saving, validation-error, and changed-on-disk states …".

**Verify**: `cd apps/web && bun test src/lib/features/skills/editor/editor-components.ssr.test.ts` → pass;
`cd apps/web && bun run test:e2e -- e2e/skills.spec.ts` → the four editor
tests pass ("Unchanged" on load, "Saved" after pointer/keyboard save,
"Unchanged" after discard-and-reload).

### Step 4: One health surface with an honest tone (U24 alert + duplication)

1. `apps/web/src/skills-page-model.ts`: next to `buildSkillHealthSummary`
   add a pure tone helper and its type:
   ```ts
   export type SkillHealthTone = 'danger' | 'neutral' | 'ok' | 'warn';
   export const healthyLinkTone = (
     summary: Pick<SkillHealthSummary, 'expectedLinkCount' | 'healthyLinkCount'>,
   ): SkillHealthTone => {
     if (summary.expectedLinkCount === 0) {
       return 'neutral';
     }
     if (summary.healthyLinkCount === 0) {
       return 'danger';
     }
     return summary.healthyLinkCount < summary.expectedLinkCount ? 'warn' : 'ok';
   };
   ```
   Test in `apps/web/src/skills-page-model.test.ts` (after line 528):
   `(0,0) → 'neutral'`, `(0,8) → 'danger'`, `(3,8) → 'warn'`, `(8,8) → 'ok'`.
2. `apps/web/src/lib/features/skills/management/skills-health.svelte`: on the
   Healthy-links value (line 52) add
   `data-health-tone={healthyLinkTone(summary)}` and a tone class
   (`dangerValue` for `'danger'`, `warningValue` for `'warn'`, a new
   `okValue = css({ color: 'status.ok' })` for `'ok'`, none for `'neutral'`).
   Add `data-skills-health-tiles` to the `<section>` (line 42) — Step 5 and
   the e2e use it.
3. `apps/web/src/lib/features/skills/shell/skills-workspace.svelte`
   metadata grid (lines 323–340): give every tile value a
   `data-health-tone` and the matching colour class (define `dangerValue`,
   `warningValue`, `okValue` locally with `status.danger` / `status.warn` /
   `status.ok`): Healthy links → `healthyLinkTone(health)`; To repair and
   Blocked → `'danger'` when `> 0`; To consolidate → `'warn'` when `> 0`;
   otherwise `'neutral'`. Make the three link-state tiles (`Healthy links`,
   `To repair`, `Blocked`) anchors to `/skills/matrix`
   (`<a class={cx(metadataItem, metadataLink)} href="/skills/matrix" data-sveltekit-noscroll>`
   with `metadataLink = css({ color: 'ink', textDecoration: 'none', _hover: { borderColor: 'accent' }, _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' } })`)
   so the drill-down removed from the Context panel in the next sub-step
   survives; `To consolidate` stays a `div` until plan 083.
4. `apps/web/src/lib/features/skills/management/skills-health-slot.svelte`:
   delete the inspector-placement "Source health" section (lines 416–439)
   and the now-unused `sourceHealthRow` css (lines 167–182). Keep the
   `actionGrid` section (440–457: `Exposure matrix`/`Close matrix`,
   `Preview reconcile`). The `metricList` const stays (used by the Document
   section).
5. SSR assertions:
   - `shell/skills-convergence.fixture.svelte`: add an optional prop
     `healthSnapshot?: 'management'`; when set, build the view from
     `syntheticManagementSnapshot()` (import from
     `../management/synthetic-fixture.test-helper`) instead of
     `syntheticSnapshot()`.
   - `shell/skills-workspace.ssr.test.ts`: add
     `test('says each health number once and tones an empty link count as danger', …)`:
     `render(convergenceFixture, { props: { pathname: '/skills/global', healthSnapshot: 'management' } }).body`
     → `(html.match(/Healthy links/g) ?? []).length === 1` and
     `html` contains `data-health-tone="danger"`;
     `render(convergenceFixture, { props: { pathname: '/skills/matrix', healthSnapshot: 'management' } }).body`
     → `(html.match(/Healthy links/g) ?? []).length === 1`.
     Before this step both renders contain "Healthy links" twice.
   - `management/management.ssr.test.ts`: in the matrix test (lines 77–88)
     add `expect(html).toContain('data-health-tone="danger"')` (the
     management fixture is 0/1).
6. e2e (Step 1 test, on `/skills/global`):
   `await expect(page.getByText('Healthy links', { exact: true })).toHaveCount(1);`
   and in the Step 5 matrix test the same count on `/skills/matrix`.

**Verify**: `cd apps/web && bun test src/skills-page-model.test.ts src/lib/features/skills/shell/skills-workspace.ssr.test.ts src/lib/features/skills/management/management.ssr.test.ts` → pass;
`grep -n "Source health" apps/web/src/lib/features/skills/management/skills-health-slot.svelte` → no match;
existing e2e "presents unmanaged copies…" (`Exposure matrix` visible, inspector < 350 px) still passes.

### Step 5: Let the matrix use its column (U25)

1. `apps/web/src/lib/features/skills/shell/skills-workspace.svelte`:
   on the matrix route drop the Context column at `xl`+ and move the
   inspector under the matrix. Use attribute variants (specificity beats the
   atomic class, no `cx` conflict):
   - `workspaceGrid`: add
     `'&[data-matrix-open="true"]': { gridTemplateColumns: { xl: '240px minmax(0, 1fr)', '2xl': '280px minmax(0, 1fr)' } }`
     and put `data-matrix-open={view.matrixOpen}` on the root `div` (line 264).
   - `mobileContext` (line 261): add
     `'&[data-matrix-open="true"]': { display: { xl: 'block' }, gridColumn: { xl: '2' } }`
     and `data-matrix-open={view.matrixOpen}` on its `div` (line 426).
2. `apps/web/src/lib/features/skills/management/skills-health.svelte`:
   replace `metricGrid` (import and line 42) with a local
   `healthGrid = css({ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' })`
   (the pattern used by `origin-filter.svelte:47` and
   `session-table-styles.ts:14`). Do not `cx` it with `metricGrid` — same
   property, stylesheet-order conflict. 150 px is the narrowest tile in
   which the longest caption ("TO CONSOLIDATE", 11 px uppercase with
   0.07 em tracking, 16 px padding each side) fits on one line.
3. `apps/web/src/lib/features/skills/management/skills-matrix.svelte`:
   - delete `matrixTable` (line 45) and its use (line 311 → `class={table}`);
     in `matrixWrap` (line 46) add a child-selector override that wins over
     the recipe's atoms deterministically:
     `'& > table': { tableLayout: 'auto', minW: 0 }`.
     With auto layout the existing `stickyCol minW: '320px'` is honoured,
     target columns size to their badge, the table is only wider than its
     container when the targets need it (sticky first column still
     applies), and a two-target matrix no longer scrolls.
   - `skillName` (lines 90–97): replace with
     `css({ minW: 0, fontWeight: 600, lineClamp: 2, overflowWrap: 'break-word', textAlign: 'left', lineHeight: 1.25 })`
     and **drop `strongCell`** from both name links (lines 340 and 398):
     `strongCell` carries `overflowWrap: 'anywhere'`
     (`table.ts:124`) and would conflict with `break-word` by stylesheet
     order. (`maxH`/`overflow` are covered by `lineClamp`.)
4. e2e, `apps/web/e2e/skills.spec.ts`: add
   `test('keeps matrix tiles, names, and the table legible beside the tree at 1280', …)`:
   - `await page.setViewportSize({ height: 800, width: 1280 }); await openHydratedSkills(page, '/skills/matrix');`
   - tiles: `const tiles = page.locator('[data-skills-health-tiles] > button'); await expect(tiles).toHaveCount(6);`
     for each: `boundingBox().width >= 150`; caption = `tile.locator(':scope > div').first()`:
     `evaluate((el) => el.scrollWidth <= el.clientWidth)` → `true` and one
     line box:
     `evaluate((el) => { const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects().length; })` → `1`.
   - table: `const table = page.getByRole('table'); await expect(table).toHaveCSS('table-layout', 'auto'); await expect(table).toHaveCSS('min-width', '0px');`
     `expect((await table.getByRole('columnheader', { name: 'Skill' }).boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(320);`
     `expect(await table.locator('..').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);`
   - name: `const name = table.getByRole('link', { exact: true, name: 'alpha-skill' }); await expect(name).toHaveCSS('overflow-wrap', 'break-word');`
     and the same `Range.getClientRects().length === 1` check on it.
   - layout: `const matrixSlot = page.locator('[data-skills-matrix-slot]'); const inspector = page.getByRole('complementary', { name: 'Selection actions' });`
     `expect(matrixBox.width).toBeGreaterThanOrEqual(700)` and
     `expect(inspectorBox.y).toBeGreaterThanOrEqual(matrixBox.y + matrixBox.height - 1)`
     (inspector below, not beside); `Close matrix` still visible (the
     existing test at lines 579–602 keeps asserting it).
   - `await expect(page.getByText('Healthy links', { exact: true })).toHaveCount(1);`
   - `await page.setViewportSize({ height: 1080, width: 1920 });` and
     re-assert tiles `width >= 150` and table `scrollWidth <= clientWidth`.

**Verify**: `cd apps/web && bun run test:e2e -- e2e/skills.spec.ts` → new
and existing matrix tests pass (including "renders matrix cards on mobile…":
`border-collapse: separate`, `font-size: 13px`, 15 px state dots are
unaffected). Before this step the Skill `th` measures ~287 px at 1280
(860/3) and the wrap scrolls horizontally.

### Step 6: Accept documented SKILL.md frontmatter (U26)

1. Confirm the two external references named in Current state §F (Claude
   Code skills docs "Frontmatter reference"; Agent Skills specification).
   If a field listed below is **absent** from both, leave it out and note
   it in the commit body; if either doc lists a field not below, add it.
2. `packages/skills/src/skill-markdown.ts:16`: extend the known list and
   say where each comes from:
   ```ts
   // Claude Code SKILL.md frontmatter reference, the Agent Skills specification
   // (agentskills.io), and the Cursor extensions `paths`/`disable-model-invocation`.
   const knownFrontmatterExtensions = new Set([
     'agent',
     'allowed-tools',
     'argument-hint',
     'compatibility',
     'context',
     'disable-model-invocation',
     'hooks',
     'license',
     'metadata',
     'model',
     'paths',
     'user-invocable',
   ]);
   ```
   `name`/`description` stay `standard`. `version`, `environments`,
   `disabled-environments` were suggested by generalized discovery but are
   documented by neither reference — they stay `unknown-extension` (still a
   warning); record them in Maintenance notes, not in the set.
3. `packages/skills/src/skill-markdown.test.ts`: add
   `test('accepts documented Claude Code and Agent Skills frontmatter without diagnostics', …)`
   parsing a document whose frontmatter has every key above (scalar values
   for `argument-hint`, `compatibility`, `model`, `context`, `agent`,
   `license`; a `- item` list for `allowed-tools`; `metadata:` and `hooks:`
   followed by indented lines; `user-invocable: false`;
   `disable-model-invocation: true`; `paths:` list). Assert
   `result.diagnostics` equals `[]` and every non-standard field has
   `kind: 'known-extension'`. Keep the existing `custom-value` test
   (lines 46–64) unchanged — it must still warn.
4. `docs/skills-management-spec.md` "Inventory and diagnostics": add one
   bullet: "Frontmatter fields documented by Claude Code, the Agent Skills
   specification, or Cursor (`paths`, `disable-model-invocation`) are known
   extensions; only undocumented keys raise `UnknownFrontmatterField`."

**Verify**: `cd packages/skills && bun test src/skill-markdown.test.ts` →
pass (new case + the three existing ones); `bun run test:packages` → pass.

### Step 7: Gates and snapshot

1. `bun x ultracite fix && bun run lint && bun run typecheck`.
2. `bun run --cwd apps/web test` and `bun run test:packages`.
3. `cd apps/web && bun run test:e2e -- e2e/skills.spec.ts e2e/svelte-shell.spec.ts e2e/accessibility.spec.ts`
   (the last two render the extended fixture that now has the twin scope).
4. `cd apps/web && bun run test:e2e -- e2e/visual-regression.spec.ts`; when
   `skills-desktop.png` fails on the status pill, regenerate with
   `--update-snapshots` and inspect the PNG: the only intended differences
   are the "Unchanged" pill text/tone and (if any) tree label line breaks.
5. `bun run --cwd apps/web test:e2e` → all pass.
6. PII guard on this plan file → no output. Update the status row in
   `plans/README.md`.

## Test plan

- New unit: `healthyLinkTone` (4 cases) in `skills-page-model.test.ts`;
  frontmatter acceptance case in `skill-markdown.test.ts`.
- Removed unit: the same-content hydration announcement case in
  `management/model.test.ts`.
- SSR: "Unchanged" on a settled editor (`editor-components.ssr.test.ts`);
  one "Healthy links" per route + `data-health-tone="danger"` via the
  convergence fixture with the management snapshot
  (`skills-workspace.ssr.test.ts`); `data-health-tone="danger"` in the
  matrix render (`management.ssr.test.ts`).
- e2e (`skills.spec.ts`): two new tests (tree/Context/toast at 1920 and
  1280; matrix tiles/table/layout at 1280 and 1920); three label updates in
  existing editor tests; fixture twin covered by the fixture unit test.
- Existing geometry tests that must keep passing unchanged: "keeps the tree,
  editor, and Inspector in one bounded desktop workspace row", "bounds long
  scope labels…", "presents unmanaged copies…", "renders matrix cards on
  mobile…", "prioritizes the editor on mobile…".

## Done criteria

- [ ] `grep -rn "Skills reloaded\|shouldAnnounceSkillsHydrationReload" apps/web/src apps/web/e2e` → no matches
- [ ] `grep -n "label: 'Unchanged'" apps/web/src/lib/features/skills/editor/skill-markdown-editor.svelte` → 1 hit; `grep -c "'Saved'" apps/web/e2e/skills.spec.ts` → 5 (lines 66, 83, 91, 96, 184 only)
- [ ] `grep -n "Source health" apps/web/src/lib/features/skills/management/skills-health-slot.svelte` → no match
- [ ] `grep -n "healthyLinkTone" apps/web/src/skills-page-model.ts apps/web/src/lib/features/skills/shell/skills-workspace.svelte apps/web/src/lib/features/skills/management/skills-health.svelte` → 3 files
- [ ] `grep -n "metricGrid\|matrixTable\|overflowWrap: 'anywhere'" apps/web/src/lib/features/skills/management/skills-health.svelte apps/web/src/lib/features/skills/management/skills-matrix.svelte` → no matches
- [ ] `grep -n "data-matrix-open" apps/web/src/lib/features/skills/shell/skills-workspace.svelte` → ≥ 2 hits
- [ ] `grep -n "'argument-hint'\|'allowed-tools'\|'compatibility'" packages/skills/src/skill-markdown.ts` → 3 hits
- [ ] `bun run typecheck` exits 0; `bun run lint` exits 0
- [ ] `bun run --cwd apps/web test` and `bun run test:packages` exit 0 with the new cases
- [ ] `cd apps/web && bun run test:e2e -- e2e/skills.spec.ts e2e/svelte-shell.spec.ts e2e/accessibility.spec.ts e2e/visual-regression.spec.ts` exits 0
- [ ] `git status` shows only in-scope files modified (plus the regenerated PNG)
- [ ] PII guard on this file → no output; `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The Current state excerpts do not match the working tree, other than the
  plan-087 exception described in the drift check.
- After Step 5 the Skill `th` still measures below 320 px at 1280×800 with
  the 2-target fixture (means the `& > table` override did not take effect —
  report the computed `table-layout`/`min-width` values; do not add
  `!important` or inline styles on your own).
- Adding the twin opaque project breaks `svelte-shell.spec.ts` or
  `accessibility.spec.ts` (for example an axe rule on identically named
  links, or a route assertion) — report the failing assertion rather than
  renaming fixture data other tests depend on.
- Any existing e2e assertion pins the `Selection actions` inspector's metric
  rows (`Healthy links` inside the inspector) — would mean another plan owns
  that presentation.
- The external frontmatter references cannot be reached and a field cannot
  be confirmed by either: ship only the three candidate fields required by the
  generalized finding (`compatibility`, `argument-hint`, `allowed-tools`) plus
  the repo-known four, and record their unconfirmed provenance in the commit
  body for a follow-up.
- The visual snapshot diff shows anything beyond the status pill and tree
  label wrapping.

## Maintenance notes

- Tone rule for the Skills health numbers: `healthyLinkTone` is the single
  source of truth; the four-tile detail grid and the six-tile matrix grid
  both read it. Do not reintroduce a second copy of the numbers in the
  Context panel — that panel is actions only.
- The Context column is dropped at `xl`+ only while `view.matrixOpen`; the
  editor routes keep the three-column layout the 1280×900 geometry test
  protects.
- `version`, `environments`, `disabled-environments` were suggested by
  generalized discovery but are undocumented; if the maintainer wants them
  silent, first confirm their provenance, then add them to
  `knownFrontmatterExtensions` with a comment naming the tool that writes them
  — do not downgrade `UnknownFrontmatterField` to `info`.
- Dead code noticed, not removed here (out of scope, candidate for a
  cleanup commit): `management/skill-diagnostics.svelte` (no importer) and
  `apps/web/src/skill-markdown-editor-model.ts` (+ its test; only the test
  imports it).
- Reviewer should scrutinize: the `& > table` child-selector override in
  `matrixWrap` (deliberate use of the "descendant selector beats atomic
  class" rule), the removal of `strongCell` from the matrix name links, and
  the regenerated `skills-desktop-linux.png`.
- Deferred: the adopt/consolidate action (plan 083); a richer inspector for
  the matrix route if "Close matrix" proves hard to reach under long
  matrices (the tree's scope links already close it).

## Execution notes

- Re-anchored at `3a0bf943`. Relative to `51815b70`, the only in-scope drift
  was plan 087's authorized client-navigation test in
  `apps/web/e2e/skills.spec.ts`; the pre-change exact `'Saved'` count was 8.
  The implemented test now has the required 5 post-save occurrences.
- The live Claude Code frontmatter reference has expanded beyond the list
  frozen in Step 6. In addition to the planned keys, this execution accepts
  `when_to_use`, `arguments`, `disallowed-tools`, `effort`, `background`, and
  `shell`, all listed by the current upstream reference. `version`,
  `environments`, and `disabled-environments` remain warning-producing
  unknown extensions.
- Browser verification disproved the plan's assumption that
  `message === 'SKILL.md saved.'` survives a real save. The plan-087 query
  revalidation/cache synchronization feeds the just-saved document back
  through `editor/controller.ts`, whose `acceptDocument` path cleared the
  message. With orchestrator authorization, `controller.ts` now preserves
  that message only for the identical saved SHA; its focused test also proves
  a different external revision clears the message. The implementation
  deviation is 2 changed logic lines.
- At 1280 px the plan's proposed two-line scope stack still left "Opaque
  project" truncated because the separate count column consumed the last
  usable width. Rather than widening the full workspace and perturbing the
  stable visual fixture, colliding scopes now place their count beside the
  second-line path. The deterministic 1280/1920 geometry test passes, while
  non-colliding rows retain their previous layout.
- The first Playwright attempt never opened port 4174 and timed out after 300
  seconds. Moving the copied Vite optimizer caches outside the worktree made
  the server start normally; no source or dependency install was involved.
  The four initially failing assertions were rerun serialized and passed,
  followed by the complete requested browser gates.
- Two-machine applicability: this Skills snapshot is deliberately local-host
  inventory and has no machine identity to group or deduplicate. The relevant
  identity collision is instead covered by two populated projects with the
  same visible label and different group IDs, paths, and skill values; it
  proves both scopes remain distinct and legible.
- Copy assertions pin `Unchanged`, the absence of the passive reload notice,
  and the single visible `Healthy links` label. The plan-083 adoption action
  remains untouched.
- Codex round 1 correctly found that the cache-synchronization guard above
  compared only the saved SHA. It now also compares skill identity; a focused
  counter-test proves a different skill with the same SHA clears the notice.
  A server-render assertion pins the danger health state to `status.danger`;
  deterministic browser assertions resolve the `muted`, `status.warn`, and
  neutral `ink` tokens to computed colours, and pin each health link's role,
  `/skills/matrix` destination, navigation, and focus-visible presentation.
  The visible `Opaque twin project skill fixture` copy is asserted verbatim.
- The visual snapshot's removal of `Skills reloaded.` is an
  orchestrator-authorized cross-child delta: plan 087's finite-SWR cache
  synchronization made passive reloads legitimate, and the program handoff
  explicitly assigned U24's passive-notice removal to plan 096. The notice is
  intentionally not restored; its deterministic post-hydration absence
  assertion remains in `apps/web/e2e/skills.spec.ts`.
- Maintainer decision D20 reopened the exhausted correction budget. The
  round-3 review defect is closed causally: each transformed matrix refresh
  is held until the test observes `aria-busy="true"`, then released, observed
  settled at `aria-busy="false"`, and checked against the transformed healthy
  link count before its tone is asserted. The Cursor extension reference now
  lists both `disable-model-invocation` and `paths`.
- Final re-anchored gates at the current program tip: Skills package 101/101,
  web 1,076/1,076, typecheck 28/28 with zero Svelte findings, lint/check over
  1,092 files plus repository guards, targeted Playwright 54/54, full
  Playwright 168/168 under the shared lock with two workers, production-report
  13/13, synthetic 5,000-session scale 2/2, build 15/15 immediately followed
  by bundle 4/4, and clean structural, focus, and added-line PII scans. The
  Darwin Skills visual baseline was regenerated only after the exact failing
  title reproduced and the intended UI delta was inspected.
