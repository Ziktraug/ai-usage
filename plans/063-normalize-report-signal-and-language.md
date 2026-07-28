# Plan 063: Normalize Report Signal and Language

> Apply the copy and signal table exactly; do not invent synonyms. DOM, token,
> and render assertions are authoritative; snapshots are review artefacts only.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- packages/design-system/src/preset.ts apps/web/src/dashboard.tsx apps/web/src/session-columns.tsx apps/web/src/routes/sources.tsx apps/web/src/skills-context-panel.tsx plans/045-valorize-the-report-dimensions.md`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MEDIUM
- **Depends on**: plans 053 and 062
- **Category**: tech-debt
- **Planned at**: commit `f4f9650`, 2026-07-28

## Locked decisions

- API metric full name: **Estimated API-equivalent value**. Compact label:
  **API value**. Add both to plan 045's Copy table; replace `$API` and other names.
- Partial API pricing: state the rule once in the column-header popover; retain
  `≥` on partial values; remove the repeated extra warning glyph. Usage-unavailable
  and other non-price warnings retain row-level provenance.
- Palette: `accent` is interaction only; `chart.c1` differs from it in both
  themes; Claude Code gets a distinct categorical color; default-valued controls
  have neutral background. Assert tokens in `preset.test.ts`.
- Replace `ambig` with `ambiguous`; replace bare `root` with `root-session time`.
- Diagnostic label: “Skill document token warning”. Extend `SkillDiagnostic`
  with optional structured token measurement `{ observed, threshold, unit:
  'tokens' }`; populate it in `tokenDiagnosticFor`, preserve it through strict
  client decoding, and show `<observed> / <threshold> tokens`. Other diagnostics
  omit the field. Never parse numbers from the message or hard-code a threshold.
- Use locale formatting already established by `fmtNum`, `fmtPct`, and
  `fmtMoney`; fix singular/plural and add spacing between provenance glyphs/text.
- Range labels: “Activity range follows report range” and “Selected report
  window” for the internal marker.
- Freshness copy: keep the pill and add popover text “No source freshness
  observation is available for this report revision.”
- `/sources`: healthy sources collapse into one summary; cards render only for
  deviations; pipeline fields move under “Details”; `Run all enabled` uses the
  established outline action.
- `Unmanaged copy` is neutral backlog styling and each row links to its existing
  consolidation/reconcile action.

## Scope

The drift-check files and focused tests, plus:

- `packages/skills/src/contracts.ts`
- `packages/skills/src/source-scan.ts` and `source-scan.test.ts`
- `apps/web/src/skills-client-contracts.ts` and tests
- `apps/web/e2e/dashboard-presentation.spec.ts`
- `apps/web/e2e/sources.spec.ts`
- `apps/web/e2e/skills.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts` and affected snapshots

No collectors, pricing arithmetic, source lifecycle, or new Skills mutations.

## Steps

### Step 1: Add copy/palette tests before edits

**Verify**: focused tests fail on old names/colors only.

### Step 2: Apply canonical metric/provenance and palette rules

**Verify**: preset, provenance-marker, session-column, and metric render tests pass.

### Step 3: Apply remaining language rules

**Verify**: render tests contain canonical strings and exclude old abbreviations.

### Step 4: Make Sources exception-led and unmanaged state neutral

**Verify**: a healthy fixture renders summary/no cards; degraded fixture renders
only deviations; unmanaged rows expose an action.

### Step 5: Update deterministic snapshots and run gates

**Verify**: update the existing deterministic snapshot suite with
`bun run --cwd apps/web test:e2e -- e2e/visual-regression.spec.ts --update-snapshots`,
then run
`bun run check && bun run lint && bun run typecheck && bun run test && bun run test:e2e-demo && git diff --check`
→ all pass with canonical-string, token-distinction, healthy/degraded-source,
and unmanaged-action assertions green.

## STOP conditions

- A copy change alters metric semantics.
- Healthy/degraded source classification would need lifecycle changes.
