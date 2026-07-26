# Plan 046: Close the verified presentation defects

> **Status: TODO**
>
> **Baseline**: commit `96b3dff`. Every row in the defect table was observed
> directly against the dev server on `:3000` on 2026-07-26 (headless Chrome,
> 1440x1000 and 390x844, light and dark, keyboard sweep, DOM and computed-style
> instrumentation). Nothing here is inferred from reading source.
>
> Companion to plan 045, which owns the product direction. This plan is
> **presentational and semantic only**: it reads what the report already produces
> and must not change aggregation, collection, or information architecture.

## Outcome

The report, Skills, Sources, and Sync surfaces stop contradicting themselves.
Identical facts are stated once, missing data uses one vocabulary, every label
means the same thing on every route, and no control lies about what it does.

## Why this is its own plan

Plan 045 changes what the report *says*. This plan fixes cases where the report
already says the right thing badly, or says it three times. Keeping them separate
means an executor can land visible improvements without waiting on 045's
aggregation and dimension work, and 045's reviewer is not asked to arbitrate
pluralisation.

Deliberate overlap to respect: 045 Wave 1 owns the **semantics** of missing data
(the `measured` / `partially measured` / `zero` states). This plan owns the
**vocabulary** used to render them. If 045 Wave 1 has already landed, adopt its
states; if not, unify the glyphs and leave a comment pointing at 045.

## Defect table

Severity: **A** = states something false or contradicts itself; **B** = costs the
reader real effort; **C** = inconsistency with no reading cost.

| # | Sev | Surface | Defect (verified) |
| --- | --- | --- | --- |
| 1 | A | all routes | The theme toggle's label and icon assume light mode on first load. With no stored override and `prefers-color-scheme: dark`, `/`, `/sources` and `/sync` render dark (`body` background `rgb(17, 17, 19)`) while the control reads `aria-label="Switch to dark theme"`. `/skills` alone is correct. After one toggle cycle the label self-corrects. |
| 2 | A | dashboard | Deltas render as `▲ 115%` with no comparison basis on the card face. The basis exists only inside the `i` dialog ("Previous period of equal length: 786"), two interactions away. |
| 3 | A | `/sources` | Provider status shows five `· partial` pills plus `2 unsupported providers` plus `7 providers without quota windows` for a stated total of 8 providers. The categories overlap and the arithmetic cannot be reconciled by the reader. |
| 4 | A | Breakdown | Value bars have a minimum-width floor, so `$20.41`, `$0.79`, `$0.12` and `$0.00` all draw an identical bar. Below roughly 3% the bar encodes nothing. Worse, a row with `n/a` draws an **empty** track while a row with `$0.00` draws a floored bar — two contradictory encodings of absence. |
| 5 | A | report + drawer + Breakdown | Missing data uses three glyphs for at least three different meanings: `—` (RTK savings), `-` (drawer `LINES`), and italic `n/a` (Breakdown). Adopt 045 Wave 1's states, or unify to one vocabulary and document it. |
| 6 | B | dashboard | `More report metrics` renders 8 cards in a 7-column grid, orphaning `Tool calls` on its own row. |
| 7 | B | dashboard | Cards without a delta (`MEAN / SESS`, `RTK SAVINGS`) centre their value while cards with a delta top-align it, so the KPI row has two baselines. |
| 8 | B | dashboard | Provenance `i` controls are click-only; hover produces nothing. They are correctly built (`aria-haspopup="dialog"`, names like `About API value`) but undiscoverable, which matters because they carry the only explanation of several metrics. |
| 9 | B | drawer | `TOTAL TOKENS 1,401,461,167` sits about 200 px from `Cache read 1.38B` — two formats for the same magnitude in one panel. |
| 10 | B | drawer | `SUB VALUE`, `PARTIAL Yes`, and `TASK-OPEN TIME` have no explanation. `TASK-OPEN TIME 44.8h` against `STARTED Jul 12, 14:34` / `ENDED Jul 15, 09:31` (66.9h elapsed) is actively confusing without one. The dashboard's `i` pattern is not present in the drawer. |
| 11 | B | dashboard | `Token anatomy`'s legend places each label left and its value right within four equal columns, so the gap between a label and its own value exceeds the gap to the next label. It reads as `Cache read … 12.72B ■ Cache write`. The drawer's 2x2 legend for the same data is unambiguous — adopt that. |
| 12 | B | `/skills` | The tree clips scope names against the count badge with no ellipsis: `exalibur-svelt`, `spotify-playlis`. |
| 13 | B | `/skills` | `SkillMarkdownTokenWarning` breaks mid-word across two lines in the Inspector. Long identifiers need `overflow-wrap`. |
| 14 | B | `/skills` | Validation stacks two identical `warning` pills with only one description, so the second is unidentifiable. The same warning appears a third time beside the title. |
| 15 | B | `/skills` | The SKILL.md editor does not wrap and shows no horizontal scrollbar, so prose is cut at roughly 95 characters. For a Markdown authoring workspace this is the page's most costly defect. |
| 16 | B | all routes | Navigation differs per route and the home link has two names: `/` offers Skills, Sync, Sources; `/skills` offers **Report**, Sync, Sources; `/sources` offers **Report** only; `/sync` offers **Dashboard**, Sources. `/sources` cannot reach Skills or Sync, and `/sync` cannot reach Skills. On `/sources` the `Report` navigation control is styled identically to the two adjacent action buttons. **Do not fix here** — plan 045 Wave 5 replaces per-route headers with a left rail covering all six destinations, which resolves this structurally. Fixing it first would be discarded work. Listed so the evidence is not lost. |
| 17 | B | mobile | At 390x844 the header and filter stack consume about 745 px before the first content card. The two selects are about 360 px wide while the filter input is about 700 px. (No horizontal overflow — `document.body.scrollWidth` equals 390. That part is correct.) |
| 18 | C | `/sources` | Each source card states the same fact three ways: a `Ready` pill, an `enabled` pill beside it, and `LAST OUTCOME success`, plus the sentence "The last run completed successfully." The two pills also disagree on capitalisation. |
| 19 | C | `/sources` | `View Codex history` (card header) and `View history` (inside the Codex card) are the same action about 400 px apart. |
| 20 | C | `/sources` | A 40-character revision hash (`ms1ujfed-3142669549a734c6e527c1a0522e89d2`) is printed twice at the top of the page and wraps across two lines. |
| 21 | C | `/sources` | `1 sources` — pluralisation, on the `Provider usage` group. |
| 22 | C | `/sources` + dashboard | `Opencode` in Provider status versus `OpenCode` in the chart legend. |
| 23 | C | Breakdown | `<synthetic>` and bare `codex` appear as model names — internal placeholders in a user-facing list. |
| 24 | C | dashboard | `From` / `To` render as native `MM/DD/YYYY` date inputs (`06/26/2026`) while every other date on the page reads `Jun 26, 2026`. |
| 25 | C | `/skills` | `Exalibur` is addressed by UUID (`/skills/projects/eb2f5015-00d3-40eb-a4e8-2b5ca5af8e55`) while every sibling scope uses a readable slug. **Do not fix here** — plan 045 Wave 4 owns project identity. Listed so it is not lost. |
| 26 | C | `/skills` | The `Skills reloaded.` banner persists until dismissed, holding about 60 px of the workspace. |

## Not defects — verified, do not "fix"

Recorded because each one looks like a bug and is not:

- The activity-day date input **is** correctly labelled, via an implicit wrapping
  label plus `aria-describedby` (`apps/web/src/overview.tsx:374-391`). Plan 029's
  requirement is met.
- The chart-option radios read `tabIndex: -1` in the DOM but **are** reachable by
  keyboard; Ark UI moves the tabindex on focus. A static-attribute audit produces
  a false positive here.
- Mobile has **no** horizontal overflow. Elements extending past 390 px live
  inside `overflow-x: auto` containers, which is correct.
- The session table is virtualised with working infinite scroll
  (`scrollHeight` grows 4,372 → 30,577 px while the DOM holds 36 rows).

## Scope

In scope: the 26 rows above, **excluding #16 and #25**. Text, layout, tokens,
wrapping, pluralisation, glyph vocabulary, and the two `i` affordance decisions
(#8, #10).

Two rows are deliberately owned elsewhere and must be left alone here:

| Row | Owner | Why |
| --- | --- | --- |
| #16 navigation divergence | plan 045 Wave 5 | The left rail replaces per-route headers entirely. |
| #25 `/skills` project UUID | plan 045 Wave 4 | Project identity (`projectKey` vs `projectLabel`) is settled there. |

Row #5 (missing-data vocabulary) is in scope but **depends on plan 045 Wave 1** for
its meaning: stop on it if the three-state result has not landed, rather than
guessing whether a value is zero or unknown.

Out of scope: aggregation, collection, dimensions, session identity, campaign or
origin modelling, the two conflicting range totals, chart meaning, information
architecture, and the heatmap's compact density (plan 029 fixed that as
non-negotiable). All of those belong to plan 045.

## Implementation

Land in four commits, each independently verifiable.

### Step 1: Fix what is false (defects 1-5)

1. Resolve the theme toggle's label and icon from the **resolved** theme, not from
   the stored override, so first load with no override is correct. Reuse whatever
   `/skills` already does — it is the one correct route.
2. Put the comparison basis on the delta itself. Keep the number compact; the
   basis is the qualifier, not a second number. Do not add an always-visible
   count.
3. Rebuild the Provider status summary so its categories are disjoint and sum to
   the stated provider total, or state the total per category rather than one
   global `8`.
4. Remove the bar minimum-width floor and give absence one encoding. A value of
   zero and a value that is unknown must not look like each other, and neither
   may look like a small positive value.
5. Unify the missing-data vocabulary. If plan 045 Wave 1 has landed, adopt its
   three states; otherwise pick one glyph per meaning and add a comment
   referencing 045 Wave 1.

**Verify**:

```sh
bun run --cwd apps/web test:e2e
```

Expected: a test asserts the toggle's accessible name matches the resolved theme
on first load with no stored override, in both `prefers-color-scheme` values; a
test asserts zero, unknown, and small-positive bars are visually distinguishable.

### Step 2: Reduce reader effort (defects 6-11, 17)

1. Give `More report metrics` a grid that does not orphan its last card, and
   top-align every value so the row has one baseline.
2. Decide the `i` affordance once, and apply it to the drawer too: either keep
   click-only and make the trigger visibly interactive, or add hover as an
   additional path while keeping click for touch and keyboard. Do not regress the
   existing `aria-haspopup="dialog"` semantics.
3. Format one magnitude one way within a panel.
4. Give `SUB VALUE`, `PARTIAL`, and `TASK-OPEN TIME` the same provenance treatment
   the dashboard metrics already have.
5. Replace `Token anatomy`'s spread legend with the drawer's 2x2 pairing.
6. Give the mobile filter stack a coherent width rule so the selects and the filter
   input agree. **Scope this to the filters only**: the navigation buttons that make
   up the rest of the 745 px are removed by plan 045 Wave 5's bottom bar, so do not
   restyle them here or the two plans will fight over the same header.

**Verify**:

```sh
bun run --cwd apps/web test:e2e && bun run --cwd apps/web test:e2e-demo
```

Expected: a test asserts content is visible above the fold at 390x844; a test
asserts every metric card in the row shares one value baseline.

### Step 3: Fix Skills presentation (defects 12-15, 26)

1. Ellipsise tree labels against the count badge.
2. Allow long identifiers to wrap in the Inspector.
3. Make each validation finding individually identifiable, and state the same
   warning once per surface.
4. Wrap the SKILL.md editor, or give it a visible horizontal scrollbar. Wrapping
   is preferred for a prose-authoring surface.
5. Auto-dismiss the reload banner, or make it non-displacing.

**Verify**:

```sh
bun test packages/skills/src && bun run --cwd apps/web test:e2e
```

Expected: all pass; a test asserts two distinct validation findings are
distinguishable from each other.

### Step 4: Unify vocabulary (defects 18-24)

Navigation (#16) is **not** in this step. Plan 045 Wave 5 owns it.

1. State each source's health once per card.
2. Remove the duplicate history action.
3. Stop printing the revision hash twice; if an operator needs it, make it
   copyable rather than displayed twice.
4. Fix pluralisation, harness capitalisation, and placeholder model names.
5. Render `From` / `To` in the same format as every other date on the page.

**Verify**:

```sh
bun run lint && bun run --cwd apps/web test:e2e
```

Expected: exit 0; a test asserts each source card states its health once, and that
no page prints the same revision hash twice.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Formatting | `bun x ultracite fix` | files rewritten, exit 0 |
| Formatting check | `bun run check` | Ultracite exits 0 |
| Lint and boundaries | `bun run lint` | exit 0, no boundary errors |
| Typecheck | `bun run typecheck` | all tasks pass |
| Unit tests | `bun run test` | all workspace and tool tests pass |
| Browser tests | `bun run test:e2e` | all pass |
| Demo browser tests | `bun run test:e2e-demo` | all pass |
| Diff hygiene | `git diff --check` | no output, exit 0 |

Do not run `bun install`; the workspace already has its dependencies.

To reproduce any row in the defect table, drive the dev server on `:3000` with
headless Chrome over CDP at 1440x1000 and 390x844 in both themes. Force the theme
with `document.documentElement.dataset.theme = 'light' | 'dark'` rather than
clicking the toggle. Note that `element.click()` does **not** activate Ark UI tabs
or radios — dispatch real pointer events (`Input.dispatchMouseEvent`) or the
interaction will silently no-op.

## Git workflow

- Create one branch for this plan; do not reuse plan 045's branch.
- One commit per step, only after that step's verification passes.
- Match the existing imperative commit style, for example
  `Fix theme toggle label on first load`.
- Do not push or open a pull request unless the operator explicitly asks.

## Verification

- `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:e2e`, `bun run test:e2e-demo` all pass.
- Contrast is re-checked for any token touched, in both themes (plan 029 owns the
  contrast gate; do not regress it).
- The four step-level assertions above exist as durable tests, not manual checks.
- Visual comparison before and after at 1440x1000 and 390x844, both themes:
  chart density, heatmap cadence, and table row height are unchanged.

## Done

- [ ] No control's label contradicts its behaviour or the resolved theme.
- [ ] Every delta states its comparison basis without a second interaction.
- [ ] Provider status categories are disjoint and reconcilable.
- [ ] Zero, unknown, and small-positive values are mutually distinguishable in
      every bar and every value cell.
- [ ] Missing data uses one vocabulary across report, drawer, and Breakdown.
- [ ] One baseline and no orphan card in the metric row.
- [ ] Provenance is discoverable, and present in the drawer.
- [ ] Skills labels ellipsise, identifiers wrap, findings are individually
      identifiable, and SKILL.md prose is readable.
- [ ] Pluralisation, capitalisation, placeholder names, and date format are
      consistent.
- [ ] Content is visible above the fold at 390x844.

## STOP conditions

Stop and report if:

- a fix requires changing what the report computes rather than how it is
  rendered — that belongs to plan 045;
- reconciling Provider status reveals that the underlying provider categories
  genuinely overlap, meaning the data model needs a decision, not the UI;
- unifying the missing-data vocabulary cannot be done without knowing whether a
  value is zero or unknown — that is plan 045 Wave 1's three-state result, and
  this plan must wait for it rather than guess;
- a token change needed for contrast would alter chart colour identity;
- fixing the SKILL.md editor requires replacing the editor component.

## Maintenance

Missing-data vocabulary and metric-card layout each have exactly one owner after
this plan: a future metric must not introduce a fourth way to render absence, and a
future card must not reintroduce a second value baseline. Navigation is **not** this
plan's to own — plan 045 Wave 5 makes the left rail its single owner.
