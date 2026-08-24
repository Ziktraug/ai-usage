# Plan 086: Remediate the 2026-08-23 Fresh-Eyes UI/UX Audit (program plan)

> **Executor instructions**: This is the umbrella for plans 087–098. Do not
> implement anything from this file directly; execute the child plans in the
> order given in "Execution order", one commit per child plan, on one branch.
> Read each child plan fully before starting it, run its drift check, honor its
> STOP conditions, and update its row in `plans/README.md` only when its done
> criteria actually pass. When every child is DONE or REJECTED, run the
> "Program gate" below and update this plan's row.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` — the child plans
> were anchored at `51815b70` (2026-08-23). If `main` has moved, run each
> child's own drift check before touching it; a mismatch in a child is a STOP
> for that child only, not for the program.

## Status

- **Priority**: P0 (children 087–089) / P1 (090–097) / P2 (098)
- **Effort**: L as a program; every child is S–M and independently executable
- **Risk**: LOW–MEDIUM (see per-child risk)
- **Depends on**: none — does not block and is not blocked by plans 074–085;
  overlaps are called out per child in "Execution order"
- **Category**: remediation (correctness, data consistency, presentation)
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit**: 42 findings U01–U42, table below

## Why this matters

On 2026-08-23 the delivered app was audited end to end by a reviewer who had
deliberately not read the code, the ADRs, or the prior plans: the six routes
and every sub-tab, all interactions (filters, periods, explore, drawers,
rhythm, matrix, reconcile preview), five viewports (1920 / 1280 / 1024 / 768 /
390), both themes, keyboard, and the console. The verdict was that the
foundation is strong — clear Report/Manage architecture, real responsive
layout, coherent themes, visible focus, named controls, no observed console errors,
URL-persisted filters — and that the defects cluster in four families:

1. **Concrete bugs** (a blank editor after client-side navigation, a day count
   of "0 days", a dead keyboard hint, a tab that ignores the period).
2. **Numbers that disagree between views** (the same harness total differs
   between Overview and Analysis; the fleet and report totals disagree; a
   campaign row opens a drawer describing one sub-agent session).
3. **Visual noise and jargon** (a provenance icon on every number, a
   repeated single-session campaign qualifier, "Publication demand is fully
   acknowledged", jargon-heavy counters, near-identical series colours).
4. **Dead ends** (a consolidation count with no action, a harness expander
   that reveals an identical child, a legend for a chart that is all one
   colour).

Families 1 and 2 undermine trust in a product whose thesis is legibility of
work volume; families 3 and 4 contradict the maintainer's own "hierarchize,
don't drown" rule. Each child plan owns one coherent slice and is intended to
be verified with deterministic assertions, so the program can sequence work
without relying on a human staring at screenshots.

## Method and evidence

- Private captures and local histories were discovery inputs only and are not
  committed. Generalized observations may explain a finding, but exact private
  payloads, figures, and inventory counts are omitted and none count as proof.
- The U-table below is a discovery and ownership ledger. A finding is accepted
  or closed only after deterministic reproduction with repository-owned
  synthetic fixtures over loopback and a settled DOM, computed-geometry,
  render, or token assertion. If no such fixture can reproduce the symptom,
  the owning child remains BLOCKED or the finding remains UNVERIFIED.

## Findings table (U01–U42)

Severity: P0 = wrong or broken, P1 = structural UX, P2 = polish.
"Plan" is the child that owns the fix.

| # | Sev | Surface | Symptom (what a reader sees) | Plan |
| --- | --- | --- | --- | --- |
| U01 | P0 | Skills › detail | Client-side nav `/skills/global` → skill card leaves the SKILL.md editor on "Loading…" indefinitely without a console or network error; a full reload renders it | 087 |
| U02 | P0 | Overview vs Analysis | The Overview and Harnesses & providers surfaces disagree for the same filter and revision; the harness breakdown does not sum to the overview total | 088 |
| U03 | P0 | Sync | Fleet cards report more sessions than the All-time report. Root cause: the fleet SQL counts every active stored row while the report applies its published minimum-token rule; 088 resolves it by labelling ("Stored sessions" + caption) and records the normalized-column "one number" path as a follow-up | 088 |
| U04 | P0 | Period | A same-day Today / Rhythm range reports zero days; single-day Activity becomes one overflowing full-width bar; the comparison silently pits a partial day against a complete previous day | 089 (count, caveat) · 093 (chart) |
| U05 | P0 | Sessions | A single-day filter can list a row whose displayed date is later — Date column and range filter use different bounds | 089 |
| U06 | P0 | Drawers | A campaign row opens a drawer describing one sub-agent session, while the Sessions drawer header and grid disagree on their totals — root vs campaign is never stated | 088 |
| U07 | P1 | Filter bar | Placeholder advertises `( / )` but `/` never focuses the input (CDP key + two synthetic dispatch paths) | 092 |
| U08 | P1 | Analysis › Cursor AI | Commits outside the selected period appear in the list; the same commit repeats once per branch and the rows are not date-ordered | 090 |
| U09 | P2 | Rhythm readout | A singular session count uses the plural noun | 098 |
| U10 | P2 | Analysis › Models | Complete coverage appears beside a lower-bound value and an unavailable per-million value; the footnote explains it, but the summary still reads as a contradiction | 098 |
| U11 | P1 | Sessions | The document and table both scroll, leaving only a shallow slice of the table visible on a narrow viewport | 091 |
| U12 | P1 | Sessions | TIME column repeats "— root-session time" on every row over two lines | 091 |
| U13 | P1 | Sessions | The same single-session campaign qualifier repeats on most rows | 091 |
| U14 | P1 | Sessions › Tokens | The same provenance warning repeats beside every token metric in affected rows | 091 |
| U15 | P1 | Filter bar | Harness/Machines is a bare list without All/checked state; Origin uses a checkbox popover with Default/All that is visibly detached from its trigger | 092 |
| U16 | P1 | Harnesses & providers | Expanding Codex/Claude reveals one "… sub" child with identical figures | 094 |
| U17 | P1 | Explore activity | Metric chooser and the "API value / Tokens" toggle are one state in two controls; Share leaves the toggle empty; window slider has no ticks/dates | 093 |
| U18 | P1 | Explore activity | Group by Model gives the largest series near-identical colours, while the grouped-series count floats under the legend | 093 |
| U19 | P1 | Activity | All time at Day interval compresses bars below a legible width | 089 |
| U20 | P1 | Session shape | Harness colour legend under an all-orange scatter (legend items inert); untitled standout list; subtitle duplicates the section header | 094 |
| U21 | P1 | Punchcard | Horizontal scroll hides late hours while much of the card remains empty. The pinned dot target cannot fit a half column below `2xl`, so 094 stacks the cards there rather than shrinking the dots | 094 |
| U22 | P1 | Provider status | Most detail cards say only "No quota source"; machine chips lack spacing; Partial vs Unsupported is unexplained; jargon counters dominate; a centred quota column makes a lone item look like a gap | 095 |
| U23 | P1 | Quota history | The selected short window shows older points; reset hatches obscure the small chart and the native controls have inconsistent widths | 095 |
| U24 | P1 | Skills | Tree names truncate despite spare width; "Skills reloaded." appears on passive load; "Saved" appears on an untouched file; consolidation is a dead end (→ plan 083); unhealthy links are not alerting; Context duplicates the tiles | 096 |
| U25 | P1 | Skills › matrix | Narrow tiles force multi-line captions and letter-by-letter names; the matrix scrolls beside an empty column | 096 |
| U26 | P1 | Skills › validation | `UnknownFrontmatterField` for `compatibility`, `argument-hint`, `allowed-tools` | 096 |
| U27 | P2 | Sync | Fleet cards and the contributions table repeat the same data while reserving a visibly empty region | 097 |
| U28 | P1 | Sources / header | "Publication demand is fully acknowledged." and "RTK dependency: Caught up" expose internal mechanisms (copy → 097). The audit also saw the warning pill become "Sources ready" after a report filter change; code inspection found no filter dependency, so 095 owns only a deterministic engine-state attribution guard and a failing settled guard would be required to reopen it as a bug | 097 (copy) · 095 (attribution + guard) |
| U29 | P1 | Session drawer | The harness badge collapses over the matching-session summary; a date label is overdrawn by the compressed-gap hatch; info buttons repeat; "Resolve GitHub links" is unexplained | 098 |
| U30 | P2 | Projects | Project grouping is inconsistent across machines; the measured-summary copy is opaque; the header and cells misalign; there is no search box | 097 |
| U31 | P2 | Report header | "Generated" reads as render time but represents the served revision's assembly time, so the intended label is "Data as of <time>" with a `<time datetime>` | 098 |
| U32 | P2 | URL | `?range=%7B%22mode%22%3A%227d%22%7D` | 089 |
| U33 | P2 | Shell | Sub-tabs shift horizontally when the scrollbar appears | 098 |
| U34 | P2 | Hero | "≥" wraps alone at 1024 px; no thousands separator | 093 |
| U35 | P2 | KPI tiles | Big numbers not baseline-aligned when a caption is longer | 094 |
| U36 | P2 | Tables | "36,971" / "188k" / "10.9M" in one column | 091 |
| U37 | P2 | Custom range | MM/DD/YYYY inputs (native `type=date` follows the browser UI language — partly an artefact of the audit browser's en-US locale; 089 removes the ambiguity with ISO inputs); two phrasings for "no previous period" | 089 (inputs) · 098 (copy) |
| U38 | P2 | Rhythm | A long span repeats month labels without a year; "scaled by sessions" conflicts with a cost-first readout; much of the card is unused. 094 fixes year marks and readout order; the width sub-point is deferred because in-card expansion changes the heatmap geometry pinned by ADR 0005/0009 | 094 |
| U39 | P2 | Filter bar | At 1280 px the warning-count pill and "Run all" wrap alone | 092 |
| U40 | P2 | Filter bar | A long machine label wraps in the menu | 092 |
| U41 | P2 | Investigate | The final tile wraps onto a row by itself at the intermediate layout | 094 |
| U42 | P2 | Records | "Longest session" can report a campaign's task-open window rather than one session | 088 |

What the audit explicitly found **good** and that no child may regress:
persistent quota rail; icon rail at 1024 and bottom bar + cards at 390 with no
horizontal overflow; light/dark parity; 2 px focus ring; named buttons,
labelled inputs, landmark structure; filters in the URL with removable chips
and "Clear all"; drawer ↑↓ "1 / 5" + Analyze timeline; configurable columns
with Work/Tokens/Reliability presets; Copy link / Export CSV everywhere;
campaign rename; reconcile preview with planned/skipped actions; per-metric
provenance ("≥", "Partially measured").

## Child plans and execution order

Run in this order. `∥` means production scopes may proceed concurrently after
their current allowlists are checked; it is not a guarantee that every test or
documentation path is file-disjoint. Plans 090 and 092 both include
`apps/web/e2e/dashboard.spec.ts`, so those test hunks must be serialized or
rebased additively. Every other stated dependency edge remains real.

| Order | Plan | Title | Pri · Effort · Risk | Findings | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | 087 | Fix the Skills Editor Stuck on "Loading…" After Client-Side Navigation | P0 · S–M · LOW–MED | U01 | isolated bug; root cause is the hydration gate comparing a merged (quota + skills) signature with the skills-only delta → every Skills query `enabled: false` after navigation; ships alone |
| 2 | 088 | One Canonical Number Per Concept | P0 · L · MED | U02 U03 U06 U42 | U02 = `costLowerBound` counted by the executive analytics but not by the harness breakdown; touches `session-drawer.svelte`, `records.svelte`, `machine-fleet.svelte` — must land before 094/097/098 |
| 3 | 089 | Period Semantics — Inclusive Day Counts, Honest Campaign Dates, Auto Interval, Readable Range URLs | P0 · M–L · MED | U04a U04b U05 U19 U32 U37a | U04 count/caveat and U05 campaign date/sort behavior; touches `report-range-model.ts` and the timeline request — must land before 093 |
| 4 | 091 | Sessions Table — One Scroll Container and Calmer Columns | P1 · M · MED | U11 U12 U13 U14 U36 | keeps ADR 0004 (surface stays the scroll container, sized from measured chrome); plan 076 is already in the tree at `c3de318a` |
| 5 ∥ | 092 | One Checkbox-Filter Mechanic, a Working `/` Shortcut, and a Filter Bar That Holds One Row | P1 · M · MED | U07 U15 U39 U40 | the `/` handler was lost in the Solid→SvelteKit cutover (`807b29af`); replaces the design-system `MultiSelect`; shares `apps/web/e2e/dashboard.spec.ts` with 090, so serialize or additively rebase the test hunk |
| 5 ∥ | 090 | Scope the Cursor AI Tab to the Report Period and List One Row per Commit | P1 · S–M · LOW | U08 | web-only: range threaded to the panel, one row per commit with a branch list; shares `apps/web/e2e/dashboard.spec.ts` with 092, so serialize or additively rebase the test hunk |
| 6 | 093 | Activity Explorer Controls, Model Palette, and Hero Number Format | P1 · M–L · MED | U17 U18 U34 U04-chart | after 089; U18 = `hash % 6` collides the two largest series; rank-ordered 12-slot palette validated in OKLab/CVD |
| 7 | 094 | Calm the Overview Secondary Panels (Harness Disclosure, Session Shape, Punchcard Fit, KPI Baseline, Rhythm Axis, Record Tiles) | P1 · M · LOW–MED | U16 U20 U21 U35 U38 U41 | after 088/093; Punchcard goes 1-up below `2xl` (cannot fit a half column with the pinned 24 px target); U38's "fill the card width" is deferred (ADR 0005/0009) |
| 8 ∥ | 095 | Make Provider Status and Quota History Legible | P1 · M · LOW–MED | U22 U23 U28b | plan 074's renames/gate are already in the tree; U28b was not reproducible from code — see the U28 row |
| 8 ∥ | 096 | Skills Management Surface Fixes — Legible Tree, Honest Statuses, One Health Surface, Matrix Geometry, Frontmatter False Positives | P1 · M · LOW–MED | U24 U25 U26 | U24's adopt action is plan 083; executor must confirm the frontmatter field list against upstream docs (STOP fallback: ship only the observed fields) |
| 8 ∥ | 097 | Sync, Sources, Projects: Duplication and Jargon | P1 · M · LOW | U27 U28a U30 | keeps the fleet cards, deletes the contributions table; excludes plans 075/077/079 |
| 9 | 098 | Session Drawer, Analysis, and Report Chrome Polish | P2 · M · LOW–MED | U09 U10 U29 U31 U33 U37b | after 088 (drawer, records) and 093/094 (`preset.ts`) |

## Cross-cutting rules every child obeys

- **Presentation gate** (`plans/README.md`): a visual defect is DONE only with
  a deterministic DOM / computed-geometry / render / token assertion that fails
  on the symptom and passes on the fix. Snapshots are review artefacts, not
  the gate. Settled state only — never assert before the report resolves.
- **Per-metric provenance is settled**; children may de-duplicate identical
  markers within a row or lower their weight, never remove or globalize them.
  Partial data is always shown; a filter default never excludes "unknown".
- **ADR 0004** (windowed continuous session scrolling) and **ADR 0005/0009**
  (compact heatmap/punchcard geometry, single day control, semantic table)
  stay in force; the 5,000-session scale proof must keep passing.
- **No re-opened decisions**: no ROI, no saved views, no LAN sync, no HTML
  export; `Other` never becomes an exact filter (plan 082); "Adopt into
  source" is plan 083.
- **Copy**: English, plain, one idea per sentence; names of internal
  mechanisms (publication demand, RTK dependency, quota windows) are replaced
  by what the reader can act on.
- **PII**: plans and tests use synthetic fixture names, `/home/alex`,
  `MacBook-Pro`. Before every commit, grep `plans/08[6-9]-*.md plans/09*.md`
  for the maintainer's first name, the default-form macOS hostname, and the
  private e-mail alias domain (the markers the repo's PII convention names);
  the result must be empty. Never write those markers into a plan, not even
  inside the grep command itself.
- **Git**: one commit per child on the program branch; commit message = child
  title; no push and no PR unless the maintainer asks.

## Commands you will need

```sh
bun run lint
bun run typecheck
bun run test                      # packages + tools
cd apps/web && bun test src        # web unit + ssr tests
bun run --cwd apps/web test:e2e    # Playwright against synthetic fixtures
bun run demo                      # synthetic app for a fresh-eyes pass
bun x ultracite fix               # format before each commit
```

## Program gate (after the last child)

1. `bun run lint && bun run typecheck && bun run test && cd apps/web && bun test src && cd ../.. && bun run --cwd apps/web test:e2e` all green.
2. `bun run demo`, then walk `/`, `/?tab=sessions`, `/?tab=models`,
   `/?tab=harness-providers`, `/?tab=projects`, `/?tab=cursor-ai`,
   `/skills/global`, `/skills/global/<fixture-skill>`, `/skills/matrix`,
   `/sync`, `/sources` at 1920×1080, 1280×800, 768×1024, 390×844, dark and
   light, and tick every U-row in the table above as "verified on demo" or
   record the residual symptom. A row with a residual symptom is not DONE.
3. `plans/README.md`: every row 086–098 has a status; every U-row maps to a
   DONE child or to a REJECTED line with rationale.

## Done criteria

- Children 087–098 each DONE (or REJECTED with rationale in `plans/README.md`).
- Program gate steps 1–3 pass and are recorded in `plans/execution-log.md`.
- No new `plans/` file introduces maintainer PII.

## STOP conditions

- A child's drift check shows its in-scope files changed since `51815b70` in
  a way that invalidates its "Current state": STOP that child, continue the
  program, record the blocker.
- Any child would require reopening a settled decision listed above.
- The 5,000-session e2e proof or the accessibility spec fails after a child
  and the failure is not explained by that child's intended change.
- A fix needs the maintainer's real data to verify (synthetic fixtures cannot
  reproduce it): record it as BLOCKED with what fixture is missing.

## Maintenance notes

- Plans 074 and 076 were already delivered by `c3de318a` and recorded in the
  2026-08-20 Direction Audit execution log. Program closure corrected their
  stale README rows to DONE.
- When a later audit retires a U-row, strike it here rather than deleting it,
  so the evidence trail stays readable.
- Child plans were written by parallel authors against the same base commit;
  if two children disagree on a shared file, the earlier order wins and the
  later child re-derives its "Current state" from the tree it finds.
