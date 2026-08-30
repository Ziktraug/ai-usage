# Plan 112: Skills Decision-First Surface — Verdicts on the Landing Page, Ranked Observations, Joined Axes

> **Executor instructions**: Follow this plan step by step. Run the named
> verification after each step. This plan is the execution record of the
> 2026-08-29 UX audit (artifact `e29ddc46-d0a1-470f-9380-023ee5ec3da3`,
> 18 findings A1–D4); the audit is the spec for every presentation choice
> below. When done, update this plan's row in `plans/README.md`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (wide presentation refactor across `/skills`; one additive
  contract field; no collection or storage change)
- **Depends on**: plan 111 (DONE). Explicitly does **not** implement the
  adopt-into-source action — that stays plan 083's, whose design awaits
  operator approval. This plan only *segments* the adoption backlog so 083
  has a place to land.
- **Category**: presentation refactor + one server-side join extension
- **Planned at**: 2026-08-29, branch `agent/099-skill-invocation-observability`

## Why

Plan 111's data model is sound (ADR 0022), but the surface inverts the
hierarchy: verdicts render only on `/skills/matrix` below ~5 screens; the
observations table is a ~190-row alphabetical wall where ~114 exposed-only
catalogue rows drown the invocation signal; exposure and usage never join on
one row; the landing page carries zero usage. Findings and evidence: the audit
artifact. Binding invariants that this plan must not weaken:

- Tiers are never summed; every count keeps its tier + harness (ADR 0022).
- `not observable` ≠ `none observed`; Cursor never renders as 0 and is stated
  per surface (the coverage list), not repeated per row.
- Absence verdicts stay qualified by `invocationLowerBound`/`skipped` exactly
  as today.
- A project-only name keeps its adoption verdict (spec) — presentation may
  *segment and reword in context*, never reassign the verdict.
- Reconcile's preview → refusals → apply trust pattern is untouched.

## Steps

1. **Residence fact (server + contract).** Add
   `unmanagedResidence: 'runtime-installed' | 'project-owned' | 'external' | null`
   to `observedSkillSchema` (`packages/web-contract/src/skills.ts`). Compute it
   in `skill-observation-join.ts` from two new pure inputs:
   `unmanagedEntryNames` (snapshot `unmanagedEntries`) and
   `projectPathPrefixes` (known project paths): name has a runtime-dir entry →
   `runtime-installed`; else any resolved path under a known project →
   `project-owned`; else `external` (harness-bundled, plugin, deleted).
   `null` for managed rows. Wire both inputs in `skills.server.ts
   readObservations`. Verify: `bun test apps/web/src/server` +
   `bun test packages/web-contract`.
2. **Observations view: rank, segment, roll up.** In
   `observations/model.ts` + `skill-observations.svelte`:
   evidence-ranked default order (declared ⟩ inferred ⟩ none, then most
   recent); the overview table keeps only rows with invocation evidence or
   managed-ness — exposed-only rows move entirely into a catalogue rollup
   grouped by plugin prefix (one expandable row per catalogue); the Cursor
   column leaves the table (coverage list still names it, per-skill detail
   keeps its row); empty cells render `—` with a header note; adoption group
   renders as three residence sub-groups with distinct copy; stale
   last-observed (>90 UTC days) gets a textual `· stale` marker (date-only
   arithmetic, SSR-stable). Verify: `bun test apps/web/src/lib/features/skills`.
3. **Landing page becomes the decision surface.** Global-scope branch of
   `skills-workspace.svelte`: three verdict tiles (adopt / delete / catalogue,
   provisional hedges carried) linking to the matrix groups by anchor; the four
   health tiles collapse into one links strip using the single taxonomy
   (healthy · to link · to repair · blocked); a joined inventory table (managed
   skills × exposure summary × usage per tier × last observed × verdict) plus
   per-project rows from the tree joined to observation rows by name;
   "Needs attention" gains `+N more`. Verify: workspace ssr tests + e2e.
4. **Detail synthesis band.** New `skill-summary-band` mounted above the
   editor on global-skill and project-skill branches: state, exposure summary,
   per-harness usage one-liners, last observed, verdict sentence
   (residence-aware wording on project-owned selections), and the two existing
   operations (toggle, reconcile-skill) reusing the management mutation path.
   The editor itself stays primary and always editable (plan 006 unchanged).
5. **Project scope page.** Replace the dead-end with the project mini-table:
   `buildProjectSkillRows` × observation rows by name (usage, last observed,
   placement), one read-only ownership sentence; de-duplicate the inspector's
   Context section.
6. **Tree curation.** Server: strip the redundant ` — <machineLabel>` suffix
   on local labels; exclude tool-managed worktree checkouts
   (`.claude/worktrees` path segments) from known project paths. Tree: issue
   chips get a shape prefix (`⚠ n`) + accessible label; `…` placeholder.
7. **Copy & taxonomy pass.** Humanize reconcile refusal reasons (state slug →
   words); fix `resolvedPathsNote`, project-scope plural, toggle
   "Nothing to change."; clear the operation notice on reconcile Cancel;
   rename the matrix "Broken" tile to "To repair"; label the chip row as
   skill-count filters; legend above the matrix; matrix cell glyphs gain a
   letterform so copy/not-linked differ by shape.
8. **Gates.** Update unit/ssr/contract/e2e tests alongside each step;
   `bun x ultracite fix`; `bun run check`; axe stays green in
   `e2e/skills.spec.ts`; re-capture `/skills`, `/skills/matrix`, one detail,
   one project at 1920 and 1100 and compare against the audit captures.

## STOP conditions

- A step needs the adopt/import mutation → that is plan 083, stop the step.
- A step wants to sum tiers, drop `not observable`, or render Cursor as 0 →
  re-read ADR 0022, redesign the presentation.
- Residence classification would require new collection or a usage-store
  schema change → stop; the fact must derive from data already read.

## Done criteria

`bun run check` passes; the landing page shows verdicts and joined usage; the
observations surface has no flat exposed-only wall; adoption backlog is
segmented by residence; detail and project pages open on synthesis; tree has
no machine suffix and no worktree duplicates; all copy defects from audit C3
are gone; plans/README.md row updated.
