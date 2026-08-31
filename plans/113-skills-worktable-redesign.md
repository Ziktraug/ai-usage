# 113 — Skills Worktable: one surface joining placement and evidence

Status: DONE (implementation verified on
`agent/099-skill-invocation-observability`; pending integration on `main`).
Depends on 111 (observation tiers) and 112 (decision-first state and evidence
policy). The adopt action stays gated on plan 083.

## Why

`/skills` was three surfaces for one question. A tree on the left repeated the
inventory a table already listed. An inspector on the right repeated what a
detail page already said. `/skills/matrix` held *placement* — where a skill is
installed, per harness — while a ~190-row observation table under it held
*evidence* — how often it was actually invoked, per harness. Neither page ever
put the two side by side, which is the only comparison that answers "is this
skill installed where it is being used?". Project scopes were routable pages
that rendered empty for every repository whose skill directories hold nothing.

The operator approved "Direction A — the unified worktable" after three review
rounds. One row per skill name; the groups *are* the decisions; the top strip
filters the table instead of navigating away from it.

## Decisions

1. **One surface.** `/skills` renders the worktable. `/skills/matrix`,
   `/skills/global`, and `/skills/projects/[projectKey]` redirect to it. The
   tree and the inspector are deleted, along with the exposure-matrix component
   and the health-tile strip that fed it.
2. **Row identity is the skill name**, grouped into `Managed`, `To adopt`,
   `Projects` (one summary row per repository, expandable in place), and
   `Catalogue only` (a single folded row). Skill-less repositories produce no
   navigable page at all.
3. **Cells join placement × evidence.** A managed row's cell for a configured
   target carries the existing letterform placement mark (`✓` linked, `C` copy,
   `→` to link, `!` broken, `—` absent) *and* that harness's invocation counts.
   Adoption candidates carry counts only. Harness observability ("Cursor —
   not observable") is one compact line beside the strip, never a zero.
4. **Two notations in the table, and only two.** A plain number is an
   invocation the harness recorded; a tilde-prefixed number is one reconstructed
   from a weaker trace. `decl`/`inf`/`exp` are gone from every cell. Exposed
   counts appear nowhere in the table — availability is not use — and live in
   the drawer prose and the Catalogue group. Tiers are never summed (ADR 0022).
   Accessible text spells every count's tier out in words.
5. **State / Action column.** Managed rows carry the enable/disable switch
   (the existing toggle operation), the Auto/Manual pill, and an issues pill.
   A disabled row dims, reads `Kept in source`, and keeps its invocation
   history: disabling removes links, never observations. Adoption candidates
   carry an `Adopt…` button rendered **disabled**, described by one sentence
   naming the gate — no dialog and no filesystem operation ship here.
6. **Detail is a drawer over the worktable.** `/skills/global/[skillName]` and
   `/skills/projects/[projectKey]/[skillName]` stay the drawer's URLs; the URL
   remains the single source of truth for selection. The drawer uses the design
   system's `Drawer` (Ark UI: focus trap, Escape, focus restore), and carries
   the name, the toggle, the Auto/Manual and issue pills, the description, the
   path + residence line, "What the history says" with a per-target placement
   fact and its action, the lower-bound caveat, the SKILL.md editor (managed) or
   a read-only preview (project), and the validation findings. No inspector
   column anywhere.
7. **No sparkline.** See "Gaps" below — the wire model carries counts and
   `lastObservedAt`, not per-week buckets.
8. **Kept:** the name-scoped counts caveat, the producer-completeness pending
   notice, the harness observability line, and every typed error / empty /
   loading state.

### Deliberate refinements to the mockup

- **Harness- and plugin-shipped invoked names** (`unmanagedResidence:
  'external'`) are not adoptable, but they *are* invoked. Dropping them would
  hide real evidence, so they sit behind their own fold inside the `To adopt`
  group, labelled "they live upstream, not adoptable". The `To adopt` count
  itself remains the runtime-installed backlog only, as decided.
- **"Replace with link" is not offered for an unmanaged copy.** The reconcile
  workflow refuses to overwrite unmanaged content, so the row states
  "Unmanaged content is never overwritten" instead of an action that would be
  refused. `Link` and `Repair link` are offered where reconcile can act.
- **The drawer is not modal**, though the mockup draws a scrim over a dimmed worktable. A modal
  drawer marks everything outside itself `aria-hidden`, and two things the app owns live outside
  it: the application rail, and the shell's own "Discard unsaved changes?" dialog. With the scrim
  in place the guard raised by leaving a dirty editor was rendered, painted above the drawer, and
  invisible to assistive technology — a hard-gate failure, not a cosmetic one. The drawer therefore
  keeps Escape, the ✕, click-outside, and an explicit focus restore to the row it was opened from,
  and leaves the rest of the page in the accessibility tree. Ark's positioner still spans the
  viewport, so it is made pointer-transparent for this drawer only (`:has(.skills-drawer-panel)`) —
  otherwise a non-modal drawer would still swallow every click aimed past its panel.
- **A refused close reopens the drawer.** Closing is a navigation, and the unsaved-draft guard can
  cancel it. The confirmation it raises is rendered inside the drawer, so a drawer that stayed shut
  would hide the question it is asking — the close is therefore released as soon as the navigation
  settles, and the drawer comes back with its draft and its dialog intact when the URL still names
  a skill.
- **Configuration and the unmanaged backlog** ("To consolidate") stay on the
  page as folds below the table. They were reachable only through the matrix
  page; deleting that page without rehoming them would have removed the only
  way to set the source repository.

## File-level changes

New:

- `apps/web/src/lib/features/skills/worktable/model.ts` — the worktable
  projection: columns (targets joined to observable harnesses), evidence
  notation, groups, decision filters, drawer history sentence.
- `apps/web/src/lib/features/skills/worktable/model.test.ts`
- `apps/web/src/lib/features/skills/worktable/skills-worktable.svelte`
- `apps/web/src/lib/features/skills/worktable/skill-drawer.svelte`
- `apps/web/src/routes/skills/+page.svelte`
- `apps/web/src/routes/skills/matrix/+page.ts`,
  `apps/web/src/routes/skills/global/+page.ts`,
  `apps/web/src/routes/skills/projects/[projectKey]/+page.ts` — redirects.

Rewritten:

- `apps/web/src/lib/features/skills/shell/skills-workspace.svelte` — the
  worktable page: headline, page-action host, table, drawer, folds.
- `apps/web/src/lib/features/skills/management/skills-health-slot.svelte` —
  now the page-level operation host only (refresh + reconcile registration,
  the reconcile plan, operation notices). It draws no facts.
- `apps/web/src/routes/skills/+layout.svelte` — header carries `Refresh skills`
  and `Reconcile links…`; no matrix slot; no health placement.

Changed:

- `shell/model.ts` — selection is `global-skill | project-skill | none`;
  `matrixOpen` removed; `inventories` exposed for the Projects group;
  `fallbackHref` is `/skills`.
- `management/operation-episode.svelte.ts` — operation owners are now
  `health-page`, `worktable`, `skill-drawer`, `configuration`.
- `management/skills-consolidate.svelte` — `onReviewEntry` optional (there is
  no second destination to review in).
- `lib/foundation/navigation/svelte/skills-url.ts` — fallback intent is
  `/skills`.

Also deleted, because the matrix and the health-tile strip were their only consumers and the
repository's design-export gate refuses an orphan: `activeFilterButton` and `refreshButton` in
`packages/design-system/src/components/button.ts`, `panelHeaderRow` in `.../panel.ts`.

Deleted: `shell/skills-tree.svelte`, `shell/skills-inspector.svelte`,
`shell/skills-global-overview.svelte`, `shell/project-scope-table.svelte`,
`shell/selection-link.svelte`, `shell/navigation.ts`,
`management/skills-matrix.svelte`, `management/skills-matrix-slot.svelte`,
`management/skills-health.svelte`, `src/skills-responsive.ts`, and the
route pages that only existed to host the deleted surfaces.

Fixture: `apps/web/src/server/skills-e2e-fixture.server.ts` gains invocation observations for
`legacy-local-copy`, the unmanaged runtime-directory entry the snapshot already carried. Through
the real join that name becomes a `runtime-installed` adoption candidate, so the `To adopt` group
and its gated action finally have a population in the browser suite.

One measured consequence worth naming: the rail's Skills link used to land on `/skills`, redirect
to `/skills/global`, and fetch route data twice. It now lands on the worktable directly, so the
browser-cache gate in `e2e/svelte-shell.spec.ts` counts one route-data request instead of two (and
three instead of four across the cross-route walk). The per-operation acquisition counts that gate
exists for are unchanged.

Tests: `shell/skills-workspace.ssr.test.ts` and
`management/management.ssr.test.ts` re-anchored to the worktable and the
page-action host; `worktable/model.test.ts` added; `e2e/skills.spec.ts`,
`e2e/accessibility.spec.ts`, and `e2e/svelte-shell.spec.ts` re-anchored to the
new structure; the `skills-desktop` visual snapshot re-recorded.

## Gaps and follow-ups

1. **Activity sparkline (decision 7).** The skill-observation wire model
   (`packages/web-contract/src/skills.ts`) carries per-harness, per-tier
   *counts* and a single `lastObservedAt`; there is no per-time-bucket series.
   The Activity column therefore renders recency (`last <date>`, with the
   existing stale marker), and no bucketed data is fabricated. A sparkline
   needs an engine + contract change: a bounded weekly histogram per skill
   name and harness, tier-separated so the bars are never stacked into one
   number. Not attempted in this pass.
2. **`skill-observations.svelte` `variant="overview"`** is no longer mounted by
   any surface: its deletion/adoption/catalogue sections are now the
   worktable's groups. The `variant="skill"` branch is mounted by the drawer.
   The overview branch and its tests should be retired in a follow-up once the
   worktable's group coverage is settled.
3. **The drawer is client-only.** Ark UI's portal does not render drawer
   content during SSR, so a direct load of a per-skill URL server-renders the
   worktable and opens the drawer on hydration. Acceptable (the worktable is
   the SSR payload), but a server-rendered detail would need a non-portal
   fallback.
4. **The drawer's close is a navigation with three outcomes**, and each needed handling: it can
   succeed (focus returns to the row), be refused by the unsaved-draft guard (the drawer comes
   back without stealing focus from the confirmation), or already have happened (a discarded draft
   replaying its navigation — closing again would push a second history entry). Worth revisiting if
   the design-system `Drawer` ever grows a way to veto a close.
5. **Below the labelled breakpoint the drawer covers the mobile navigation popover.** It stops
   short of the fixed bottom bar, so the bar itself stays tappable, but the "Manage" popover opens
   into the drawer's area. Leaving Skills from an open drawer on a phone therefore means closing it
   first. A phone-shaped drawer (a bottom sheet, or a stacking order that puts the popover above
   it) is the fix; not attempted here.
6. **`buildSkillsMatrixView` and the cell-state filter vocabulary** in
   `management/model.ts` survive with tests but no consumer. Retire or re-use
   them when the "Links healthy" filter grows sub-states.
