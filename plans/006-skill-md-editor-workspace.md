# Plan 006: Make `SKILL.md` the primary, always-editable Skills workspace

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer explicitly told you they maintain the
> index.
>
> **Drift check (run first)**:
> `git diff --stat be83e85..HEAD -- apps/web/src/skill-markdown-editor-model.ts apps/web/src/skill-markdown-editor-model.test.ts apps/web/src/skills-detail.tsx apps/web/src/skills-context-panel.tsx apps/web/src/skills-workspace.tsx apps/web/e2e/skills.spec.ts docs/skills-management.md docs/skills-management-spec.md`
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. If the
> editor state machine, draft guard, snapshot replacement flow, or three-pane
> workspace has materially changed, treat that as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 001–005 (all DONE)
- **Category**: direction
- **Planned at**: commit `be83e85`, 2026-07-11

## Why this matters

The Skills route currently presents `SKILL.md` as a preview that must be put
into an explicit edit mode. Paths, runtime exposure, health counters, and
technical diagnostics compete with the file for attention. That hierarchy is
wrong for the intended product: the primary job is to read and author a skill;
installing the saved source into runtimes is the downstream operation.

After this plan, selecting a managed global skill opens an always-editable
`SKILL.md` document as the dominant central surface. A persistent document bar
shows whether the draft is saved, saving, conflicted, or invalid and exposes
Save / Revert / Reload actions. The right-hand panel becomes an inspector for
the selected document: validation, token information, invocation mode, source
identity, and runtime installation state. The UI must make this state flow
explicit:

```text
Draft --Save--> Source repository --Install / Repair--> Runtimes
```

Saving source content and installing it into runtimes remain separate explicit
actions. Do not add autosave or automatically reconcile runtimes after a save.

## Product decisions locked by this plan

These decisions came from the operator and must not be re-litigated during
implementation:

1. `SKILL.md` is the primary element of a selected global skill page.
2. The document is directly editable after it loads; there is no `Edit` button
   and no read-only preview mode for managed global skills.
3. Save is explicit. Support the visible Save button and `Ctrl+S` / `Cmd+S`.
4. A successful save updates the source repository only. It does not install,
   repair, unlink, enable, or disable any runtime projection.
5. Runtime state, validation, tokens, paths, and actions belong in a contextual
   inspector and must not displace the editor.
6. Existing dirty-draft navigation, refresh protection, revision conflict
   detection, and server-side mutation safety must be preserved.
7. Project-owned skills remain read-only in this plan. Adoption and editing of
   project-owned or unmanaged skills are follow-up work.
8. Do not introduce a full code-editor dependency in this plan. Use the native
   textarea, styled as a document editor. A future CodeMirror/Monaco migration
   should be possible behind the component boundary introduced here.

## Current state

### Relevant files

- `apps/web/src/skill-markdown-editor-model.ts` — framework-independent editor
  state machine; owns loading, drafts, saving, stale-request rejection, and
  SHA-256 conflict handling.
- `apps/web/src/skill-markdown-editor-model.test.ts` — unit coverage for editor
  state transitions and concurrency.
- `apps/web/src/skills-detail.tsx` — all scope and skill detail presentations;
  currently contains the managed Markdown preview/editor implementation.
- `apps/web/src/skills-context-panel.tsx` — permanent right panel; currently
  duplicates health and selected-skill actions instead of inspecting the
  document.
- `apps/web/src/skills-workspace.tsx` — responsive tree/detail/context layout,
  URL-backed selection, and dirty-draft guard plumbing.
- `apps/web/src/routes/skills.tsx` — route orchestration. It owns the snapshot
  replacement confirmation and passes mutations into the workspace. Only
  change it if a prop rename from the in-scope components requires a mechanical
  update.
- `apps/web/e2e/skills.spec.ts` — deterministic browser coverage for drafts,
  refresh, editing, reconciliation, and responsive behavior.
- `docs/skills-management.md` and `docs/skills-management-spec.md` — product
  intent and verification contract.

### Existing editor state machine

At `apps/web/src/skill-markdown-editor-model.ts:8-18`, editing is an explicit
mode:

```ts
export interface SkillMarkdownEditorState {
  dirty: boolean;
  document: SkillMarkdownDocument | undefined;
  draft: string;
  editing: boolean;
  error: string | null;
  loading: boolean;
  message: string | null;
  saving: boolean;
  skillName: string;
}
```

At lines 125–129, save is refused unless that mode is active:

```ts
const currentDocument = state.document;
if (!(state.editing && currentDocument) || state.saving) {
  return;
}
```

At lines 164–173, successful save exits edit mode. At lines 195–215,
`cancelEditing` restores the saved document and `startEditing` enters the mode.
The new implementation should replace those UI-mode concepts with document
concepts: `revertDraft` restores the last loaded/saved document; a loaded
managed document is always editable.

Do not weaken the existing safeguards:

- selection versioning at lines 75–105 ignores stale loads;
- `select` at lines 108–116 refuses to replace a dirty draft;
- `reload` at lines 118–123 refuses while dirty;
- save includes `baseSha256` at lines 131–136;
- conflicts are surfaced without replacing the draft at lines 148–153;
- stale save responses are ignored at lines 139–142 and 179–182.

### Existing detail hierarchy

At `apps/web/src/skills-detail.tsx:535-615`, a global skill renders:

1. title, validation, invocation and enabled badges;
2. description and duplicate links;
3. source path, `SKILL.md` path, invocation and tokens;
4. full runtime exposure with mutation buttons;
5. the `SkillMarkdownEditor`;
6. diagnostics.

The Markdown editor itself renders a preview and `Edit` button at lines
703–735, then conditionally renders a textarea at lines 737–769. This is the
hierarchy this plan changes.

### Existing workspace and context panel

`apps/web/src/skills-workspace.tsx:40-45` defines the desktop layout:

```ts
gridTemplateColumns: {
  base: '1fr',
  lg: '280px minmax(0, 1fr)',
  xl: '280px minmax(0, 1fr) 320px'
}
```

The tree is rendered at lines 248–261, central detail at 287–340, and context
panel at 341–357. Preserve the overall tree/editor/inspector structure at `xl`.
The editor must receive the flexible column and remain usable at `lg`, where
the inspector may stack below it.

`apps/web/src/skills-context-panel.tsx:190-236` always renders `SourceHealth`
before selection-specific content. For a global skill, lines 342–390 duplicate
Enable/Disable, Reconcile, and issue rows already represented in the central
detail. Replace the global-skill branch with a document inspector; do not leave
duplicate actions in both columns.

### Existing route-level draft protection

`apps/web/src/skills-route-controller.ts:99-101` stores a
`SkillMarkdownDraftGuard`. Snapshot replacement is deferred only if the new
snapshot removes the dirty skill (`skills-route-controller.ts:161-180`).
`skills-workspace.tsx` passes the guard through to the editor. Preserve this
contract; do not move Markdown persistence into the route controller.

### Vocabulary and architecture constraints

Use `runtime` for Claude Code, Codex, OpenCode, and Standard Agents in this UI.
`Harness` is reserved for usage-report collectors, even though the existing
visual badge component is named `HarnessBadge` internally. This rule is
documented in `CONTEXT.md` and `docs/skills-management.md`.

`@ai-usage/skills` owns filesystem safety, Markdown IO, validation, and
projection workflows. Browser components must call the existing server
functions and must not import server-only package internals. Do not move save
or reconciliation logic into UI components.

The repository uses SolidJS, Panda CSS, TanStack Router, Bun tests, and
Ultracite. Match the existing `css(...)` component-local styling and reuse
exports from `@ai-usage/design-system/report` before adding new primitives.
Avoid a new design-system primitive unless it is genuinely reused outside the
Skills route.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused model tests | `bun test apps/web/src/skill-markdown-editor-model.test.ts` | exit 0; all editor tests pass |
| Skills model tests | `bun test apps/web/src/skills-page-model.test.ts apps/web/src/skills-route-model.test.ts` | exit 0; all tests pass |
| Web tests | `bun run --cwd apps/web test` | exit 0; all web tests pass |
| Typecheck | `bun run typecheck` | exit 0; no TypeScript errors |
| Lint and boundaries | `bun run lint` | exit 0 |
| Ultracite | `bun x ultracite check` | exit 0 |
| Build | `bun run build` | exit 0 |
| Skills E2E | `bun run test:e2e -- apps/web/e2e/skills.spec.ts` | exit 0; Skills browser tests pass |
| Full tests | `bun run test` | exit 0; all workspace tests pass |

Before the final checks, run `bun x ultracite fix` once. Review its diff and
revert only unrelated generated or user-owned changes; never discard an
unrelated pre-existing worktree change.

## Suggested executor toolkit

- Use the repository's `mattpocock-skills:implement` skill if available, because
  this file is the complete implementation spec.
- Use Playwright for desktop and 390px mobile verification. The deterministic
  fixture is already configured by `apps/web/playwright.config.ts`; do not test
  against or mutate the operator's real skill directories.

## Scope

### In scope

- `apps/web/src/skill-markdown-editor-model.ts`
- `apps/web/src/skill-markdown-editor-model.test.ts`
- `apps/web/src/skills-detail.tsx`
- `apps/web/src/skills-context-panel.tsx`
- `apps/web/src/skills-workspace.tsx`
- `apps/web/src/routes/skills.tsx` only for mechanical prop/plumbing changes
- `apps/web/e2e/skills.spec.ts`
- `docs/skills-management.md`
- `docs/skills-management-spec.md`
- `plans/README.md` for final status only

Small new component or model files under `apps/web/src/` are allowed when they
make the editor or inspector independently testable. Prefer:

- `apps/web/src/skill-markdown-editor.tsx` for the managed editor UI extracted
  from `skills-detail.tsx`;
- `apps/web/src/skill-document-status.ts` plus a colocated test only if a pure
  derived status model is needed.

### Out of scope

- `packages/skills/**` — do not change filesystem, validation, contracts, or
  Markdown persistence semantics.
- `apps/web/src/server/**` — existing load/save server functions are sufficient.
- Autosave, background save, or save-on-navigation.
- Automatic runtime reconciliation after Save.
- Per-skill/per-runtime installation policy; that requires a domain contract
  and source-state migration and belongs in a separate plan.
- Creating, renaming, duplicating, deleting, importing, or adopting skills.
- Editing project-owned, unmanaged, or runtime-local copies.
- Markdown rendering changes outside the Skills route.
- Adding CodeMirror, Monaco, ProseMirror, or any other editor dependency.
- Changing the warning taxonomy or recognizing additional frontmatter fields.
- Redesigning the global overview, project scopes, matrix, configuration, or
  consolidation workflow beyond layout adjustments required by the editor.

## Git workflow

- Suggested branch: `feature/skills-primary-editor`
- The repository history uses short imperative commit messages, for example
  `Refine skills route orchestration`. Use one logical commit per completed
  vertical slice when practical.
- Do not push or open a PR unless the operator explicitly asks.
- Preserve unrelated worktree changes. Check `git status --short` before every
  commit and before final handoff.

## Target interaction design

### Desktop (`xl` and wider)

```text
┌──────────────────┬────────────────────────────────────┬───────────────────┐
│ Skills           │ pr-review              Saved       │ Inspector         │
│ Search           │ [Save] [Revert] [Reload]           │                   │
│                  │ ┌────────────────────────────────┐ │ Validation        │
│ Global           │ │ ---                            │ │ Tokens            │
│  pr-review       │ │ name: pr-review                │ │ Invocation        │
│  tdd             │ │ description: ...              │ │ Source            │
│                  │ │ ---                            │ │                   │
│ Projects         │ │                                │ │ Installed in      │
│  ai-usage        │ │ # PR Review                    │ │ Claude Code  OK   │
│                  │ │ ...                            │ │ Codex       Missing│
│                  │ └────────────────────────────────┘ │ [Install / Repair]│
└──────────────────┴────────────────────────────────────┴───────────────────┘
```

The editor must dominate the page visually. The inspector is narrower and may
scroll independently only if the existing page shell already supports it;
do not introduce nested scrolling that hides the document toolbar.

### `lg` desktop/tablet

Keep the tree beside the editor. Stack the inspector after the editor content.
The textarea must remain at least 520px wide when the viewport permits. Do not
compress the editor to preserve a 320px right rail.

### Mobile

Keep the existing compact skill picker. After selection, order content as:

1. document header and save state;
2. editor;
3. save/revert actions, sticky only if they do not cover text;
4. collapsed inspector sections.

The existing behavior that closes the picker, scrolls the selected detail into
view, and focuses it must continue to pass.

## Document states and exact UI copy

Derive one visible document state. Do not represent these as several unrelated
messages:

| Condition | Label | Tone | Actions |
| --- | --- | --- | --- |
| Loading | `Loading…` | neutral | all disabled |
| Loaded, unchanged | `Saved` | success/neutral | Save disabled; Reload enabled |
| Draft differs from document | `Unsaved changes` | warning | Save and Revert enabled; Reload invokes discard confirmation |
| Save in flight | `Saving…` | neutral | document input and actions disabled |
| Save conflict | `Changed on disk` | danger | Preserve draft; offer `Reload from disk` through confirmation |
| Other load/save failure | concise existing server message | danger | Preserve any loaded draft; allow retry where safe |

Use these action labels:

- `Save`
- `Revert changes`
- `Reload from disk`
- `Enable` / `Disable`
- `Install` when a projection is missing
- `Repair` for a broken or wrong-target managed projection

The existing server operation may still be named `reconcileManagedSkill`.
Change user-facing copy, not domain APIs, in this plan.

## Steps

### Step 1: Convert the editor model from mode-based to document-based editing

Modify `apps/web/src/skill-markdown-editor-model.ts`:

1. Remove `editing` from `SkillMarkdownEditorState`.
2. Replace controller methods `startEditing` and `cancelEditing` with
   `revertDraft` (or an equally explicit document term). `revertDraft` must:
   - do nothing without a loaded document;
   - restore `draft` from `document.content`;
   - clear `dirty` and the transient message;
   - never perform filesystem IO.
3. Allow `setDraft` whenever a document is loaded and no save is in flight.
4. Allow `save` whenever a document exists, the draft is dirty, and no save is
   in flight. A save on a clean document must be a no-op.
5. After a successful save, keep the new content loaded and editable; update
   the document SHA/content from the server response and set `dirty: false`.
6. Preserve the dirty draft and document after conflict or other save failure.
7. Preserve selection versioning and stale-response protections exactly.
8. Keep `reload` refusing a dirty draft. Confirmation remains a UI concern.

Update `apps/web/src/skill-markdown-editor-model.test.ts` before changing the UI.
Retain all existing concurrency cases, translated to the new API, and add tests
for:

- a loaded document accepts input immediately without `startEditing`;
- clean Save is a no-op and does not call `saveMarkdown`;
- successful Save leaves the document ready for another immediate edit;
- `revertDraft` restores the latest server-confirmed content;
- conflict preserves the exact local draft and marks a visible conflict state
  or message;
- input is ignored while save is in flight.

**Verify**:

```sh
bun test apps/web/src/skill-markdown-editor-model.test.ts
```

Expected: exit 0; all old concurrency guarantees and the new always-editable
cases pass.

### Step 2: Extract and build the always-editable document surface

Extract the current `SkillMarkdownEditor` from `skills-detail.tsx` into
`apps/web/src/skill-markdown-editor.tsx`. The component must own only UI state
adaptation around the existing controller and server functions; it must not own
runtime projection mutations.

Render this order:

1. Document toolbar with `SKILL.md`, visible state label, Save, Revert changes,
   and Reload from disk.
2. A single textarea that is present whenever the document is loaded.
3. A compact error/status region announced with `aria-live="polite"` for normal
   state changes and `role="alert"` for save/load errors.
4. The existing discard confirmation dialog when reload or navigation would
   destroy a dirty draft.

Textarea requirements:

- accessible label: `<skill name> SKILL.md`;
- monospace font;
- full available width;
- minimum height of `clamp(480px, 65vh, 900px)` on desktop or the closest Panda
  representation supported by the project;
- sensible mobile minimum height (at least 60vh);
- resize vertically, not horizontally;
- visible focus ring using existing accent tokens;
- preserve tabs/newlines exactly as entered;
- disabled or read-only only while loading/saving, never merely because the
  user has not clicked Edit.

Keyboard behavior:

- listen on the editor surface for `Ctrl+S` and `Meta+S`;
- call `preventDefault()`;
- invoke the same controller save path as the button;
- do nothing when clean or saving;
- do not install or reconcile runtimes.

Draft guard behavior:

- continue publishing `{ dirty, discard, focus, skillName }` via
  `onDraftStateChange`;
- `discard` must call `revertDraft`;
- `focus` must focus the textarea;
- unsubscribe from the controller on cleanup;
- keep the existing navigation blocker and reload confirmation behavior.

Do not add a Markdown preview to the primary surface. If retaining the existing
`MarkdownPreview` is necessary for project-owned read-only skills, leave that
component in `skills-detail.tsx` or extract it separately.

**Verify**:

```sh
bun run typecheck
bun test apps/web/src/skill-markdown-editor-model.test.ts
```

Expected: both exit 0; no `editing`, `startEditing`, or `cancelEditing` references
remain in the managed editor path:

```sh
rg -n "editing|startEditing|cancelEditing|>Edit<" \
  apps/web/src/skill-markdown-editor-model.ts \
  apps/web/src/skill-markdown-editor.tsx \
  apps/web/src/skills-detail.tsx
```

Expected: no mode-related match for the managed editor. Matches in unrelated
copy or comments must be justified in the handoff.

### Step 3: Make the document the central global-skill detail

Modify `GlobalSkillDetail` in `apps/web/src/skills-detail.tsx`:

1. Keep a compact header containing skill name, description, and at most the
   validation plus enabled badges.
2. Render the extracted managed editor immediately after that header.
3. Remove the metadata grid, full runtime exposure list, diagnostics list, and
   duplicated mutation buttons from the central column for global skills.
4. Keep duplicate-scope links only if they remain a compact single line; they
   must not push the editor below a large card.
5. Pass all data required by the inspector through the existing workspace
   composition rather than duplicating it.
6. Do not change `GlobalScopeDetail`, `ProjectScopeDetail`, or
   `ProjectSkillDetail` beyond mechanical shared-component extraction.

The editor must be visible within the first desktop viewport after the normal
application header. It is acceptable for the textarea to extend well below the
fold; it is not acceptable for runtime cards or paths to precede it.

**Verify**:

```sh
bun run typecheck
bun run --cwd apps/web test
```

Expected: exit 0; global and project detail types remain valid and all web unit
tests pass.

### Step 4: Turn the global-skill Context panel into a document inspector

Modify `apps/web/src/skills-context-panel.tsx` while preserving its other
selection branches.

For `selection.type === 'global-skill'`:

1. Change the panel title from generic `Context` to `Inspector`.
2. Do not render global `SourceHealth`; that belongs to global-scope overview,
   not the selected document inspector.
3. Render compact sections in this order:
   - **Validation**: valid/warning/invalid state and grouped diagnostics;
   - **Document**: total tokens plus `SKILL.md` tokens when available,
     invocation (`Auto` / `Manual`), and enabled state;
   - **Source**: source path and `SKILL.md` path with copy actions rather than
     large wrapping cards;
   - **Installed in**: one row per enabled runtime, with user-facing state;
   - **Actions**: Enable/Disable and a context-sensitive Install/Repair action.
4. Group repeated diagnostics by code/message when they are identical. Show a
   count instead of repeating the same message. Do not change the underlying
   diagnostic taxonomy.
5. Runtime rows must expose expected/actual paths only through a disclosure or
   tooltip; the primary row is runtime label + state.
6. Replace the user-facing `Reconcile` label:
   - `Install` if every actionable issue is missing;
   - `Repair` if any actionable issue is broken/wrong-target;
   - disable the action when no safe action exists;
   - if mixed states make a single label misleading, use `Review installation`
     and show the existing preview flow rather than inventing a direct unsafe
     mutation.

For `global-scope`, retain source-health and bulk preview actions. For project
scope and project skill, retain their read-only behavior. A generic panel title
may remain for those selections if `Inspector` would be misleading.

Remove global-skill actions and issue lists that became duplicates. One action
must have one visible home.

**Verify**:

```sh
bun run typecheck
bun test apps/web/src/skills-page-model.test.ts
```

Expected: exit 0. Add pure model tests if deriving the Install/Repair label
requires more than a trivial condition.

### Step 5: Tune the responsive workspace around editor priority

Modify `apps/web/src/skills-workspace.tsx` only as necessary:

1. Preserve the three-column `xl` layout, but allow the central editor to be
   meaningfully wider. Prefer reducing the tree/inspector widths slightly or
   increasing the page shell's available width over constraining the editor.
2. At `lg`, retain tree + center and stack the inspector below the editor.
3. At mobile widths, keep the existing picker and selected-detail focus
   behavior.
4. Ensure the inspector follows the document on mobile and does not appear
   before it in DOM order.
5. Avoid nested page/editor scroll regions. The page should retain one primary
   vertical scroll.
6. Do not make the textarea horizontally scroll the full page. Long Markdown
   lines may scroll within the textarea itself.

Manually inspect at 1440×900, 1280×800, 1024×768, and 390×844 using the E2E
fixture. The central editor must remain the visually dominant surface at each
size.

**Verify**:

```sh
bun run typecheck
bun run test:e2e -- apps/web/e2e/skills.spec.ts
```

Expected: exit 0; existing desktop and mobile navigation tests still pass.

### Step 6: Rewrite E2E coverage around the authoring workflow

Update `apps/web/e2e/skills.spec.ts`. Replace interactions that click `Edit`
with direct textarea interactions. Preserve every existing safety assertion.

Add or expand deterministic tests for these user journeys:

1. **Immediate editing**
   - navigate directly to `/skills/global/alpha-skill`;
   - assert the `alpha-skill SKILL.md` textarea is visible without clicking
     Edit;
   - type content and assert `Unsaved changes` plus enabled Save/Revert actions.
2. **Keyboard save**
   - modify content;
   - press `Control+S` (and use `Meta+S` in a browser-neutral unit/helper test if
     Playwright platform handling makes both impractical);
   - assert `SKILL.md saved.` or the final `Saved` state;
   - assert the textarea remains visible and accepts a second edit immediately.
3. **Save does not install**
   - record the displayed runtime states before Save;
   - save a content-only change;
   - assert runtime states did not change and no installation success notice
     appeared.
4. **Navigation protection**
   - retain the current keep-editing/discard flow;
   - after `Keep editing`, assert the textarea remains focused with exact draft
     content;
   - after discard, assert navigation succeeds.
5. **Reload protection**
   - dirty document + Reload from disk opens confirmation;
   - keep preserves exact text;
   - discard reloads fixture content.
6. **Inspector**
   - selected global skill shows Inspector with Validation, Document, Source,
     and Installed in sections;
   - no duplicate Enable/Disable or Install/Repair buttons exist in central
     detail and inspector combined.
7. **Mobile**
   - retain picker behavior;
   - textarea appears before inspector content in document order;
   - Save remains reachable at 390×844 without horizontal page overflow.

Use role/name queries. Do not couple tests to Panda-generated class names.

**Verify**:

```sh
bun run test:e2e -- apps/web/e2e/skills.spec.ts
```

Expected: exit 0; all authoring, protection, inspector, and responsive cases
pass against the deterministic fixture.

### Step 7: Update the product documentation

Update both Skills docs so future work does not restore the preview-first
hierarchy.

In `docs/skills-management.md`, record:

- managed global skills open as directly editable source documents;
- the state flow is Draft → Source repository → Runtimes;
- Save is explicit and source-only;
- runtime install/repair remains a separate action;
- the inspector contains validation, document metadata, and runtime exposure;
- project skills remain read-only pending adoption.

In `docs/skills-management-spec.md`, update Web experience requirements and E2E
coverage to include immediate editing, keyboard save, source/runtime separation,
conflict preservation, and responsive editor priority.

Do not claim autosave, live line-level diagnostics, creation, adoption, or
per-runtime policy exists.

**Verify**:

```sh
rg -n "Draft|Source repository|Runtimes|directly editable|Ctrl|Cmd" \
  docs/skills-management.md docs/skills-management-spec.md
```

Expected: matches document the new behavior in both files.

### Step 8: Run final verification and review the diff

Run formatting first:

```sh
bun x ultracite fix
```

Then run every gate:

```sh
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:e2e -- apps/web/e2e/skills.spec.ts
```

Expected: every command exits 0.

Finally inspect scope:

```sh
git status --short
git diff --check
git diff --stat
```

Expected: no whitespace errors, no secrets or machine-local paths added, and no
files outside this plan's scope modified by this work. Pre-existing unrelated
changes may remain but must be identified in the handoff.

Update plan 006 to `DONE` in `plans/README.md` only after all verification gates
pass.

## Test plan summary

### Unit tests

Extend `skill-markdown-editor-model.test.ts` using its existing deferred-promise
pattern. Required state-machine coverage:

- immediate input after load;
- clean-save no-op;
- dirty save and subsequent re-edit;
- revert to latest saved document;
- conflict preserves draft;
- input ignored while saving;
- stale loads and stale saves remain ignored;
- dirty selection and reload remain blocked.

If a pure inspector presentation model is introduced, test state-to-label
mapping for linked, missing, broken link, wrong target, unmanaged copy, invalid,
and no-action cases.

### Browser tests

Use `apps/web/e2e/skills.spec.ts` and its existing deterministic backend. Cover:

- editor visible without Edit;
- pointer and keyboard save;
- source save does not mutate projections;
- draft protection on navigation, refresh, and disk reload;
- conflict/error state keeps local content;
- inspector content and single-home actions;
- desktop/mobile ordering and absence of horizontal page overflow.

### Regression tests that must remain green

- Skills route selection remains URL-addressable.
- Project skills remain readable and read-only.
- Matrix reconciliation remains preview-first.
- Snapshot refresh never silently removes a dirty selected skill.
- Mobile picker closes and focuses selected detail.

## Done criteria

All items are required:

- [x] Selecting a managed global skill displays a textarea without clicking an
      Edit button.
- [x] `rg -n ">Edit<|startEditing|cancelEditing"` returns no managed-editor
      implementation matches.
- [x] Save is disabled for clean content, enabled for dirty content, and leaves
      the document immediately editable after success.
- [x] `Ctrl+S` and `Cmd+S` use the same save path as the button.
- [x] Save never invokes enable/disable or reconciliation operations.
- [x] The UI clearly distinguishes `Saved`, `Unsaved changes`, `Saving…`, and
      `Changed on disk` states.
- [x] Revert and reload never silently discard a dirty draft.
- [x] Navigation and snapshot replacement draft guards still work.
- [x] The editor precedes runtime exposure, technical paths, and diagnostics in
      the global-skill experience.
- [x] Global-skill validation, tokens, source paths, invocation, and runtime
      states appear in the Inspector.
- [x] Global-skill mutation actions are not duplicated between center and right
      columns.
- [x] Project-owned skills remain read-only.
- [x] No new editor dependency is added to `apps/web/package.json` or lockfile.
- [x] Unit, typecheck, lint, Ultracite, build, and Skills E2E commands all exit 0.
- [x] Documentation describes Draft → Source repository → Runtimes and explicit
      source-only Save.
- [x] `git diff --check` exits 0 and the diff stays inside declared scope.
- [x] `plans/README.md` marks plan 006 DONE only after all gates pass.

## STOP conditions

Stop and report instead of improvising if:

1. The editor model or save server contract has materially changed since commit
   `be83e85`, especially if `baseSha256` conflict detection no longer exists.
2. Direct editing requires changing `@ai-usage/skills` contracts or filesystem
   mutation semantics.
3. The textarea cannot receive direct input without adding a third-party editor
   dependency.
4. Preserving dirty drafts would require weakening navigation, refresh, reload,
   or snapshot replacement confirmation.
5. A source Save triggers runtime reconciliation anywhere in the live code. Do
   not normalize that behavior; report it as a separate correctness issue.
6. Moving runtime details into the inspector makes project-scope or matrix
   actions disappear. Restore the prior behavior or stop; do not redesign those
   flows inside this plan.
7. The responsive design requires nested page scrolling or makes the editor
   narrower than the existing central detail at 1024px.
8. Any verification command fails twice after a reasonable scoped correction.
9. Ultracite formatting touches unrelated user-owned files that cannot be
   separated safely.

## Maintenance notes

- Keep the extracted editor component behind a narrow contract. A future rich
  editor should replace the textarea without changing draft/save/runtime
  semantics.
- A later line-aware validation feature will need parser diagnostics with
  source locations; current diagnostics do not provide that contract. Do not
  fake line associations in this plan.
- Per-skill runtime targeting is a separate domain feature. The inspector built
  here should accept exposure rows from the current snapshot so it can later
  gain per-runtime controls without another page-layout rewrite.
- Adoption of unmanaged/project skills should eventually open the same editor
  only after a canonical source document exists. Do not allow editing runtime
  copies in place.
- Reviewers should scrutinize three risks: stale async responses replacing a
  newer selection, Save accidentally causing runtime mutation, and mobile
  ordering that places inspector content ahead of the editor.
- The current unknown-frontmatter warning noise is intentionally not addressed
  here. It deserves a separate compatibility/diagnostics plan so editor UX and
  validator policy do not become coupled.
