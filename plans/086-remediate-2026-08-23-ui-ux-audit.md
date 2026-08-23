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
layout, coherent themes, visible focus, named controls, 0 console errors,
URL-persisted filters — and that the defects cluster in four families:

1. **Concrete bugs** (a blank editor after client-side navigation, a day count
   of "0 days", a dead keyboard hint, a tab that ignores the period).
2. **Numbers that disagree between views** (the same harness total differs by
   ~$208 between Overview and Analysis; the fleet sums to 8,125 sessions while
   the report counts 7,979; a campaign row opens a drawer describing one
   sub-agent session).
3. **Visual noise and jargon** (a provenance icon on every number, a
   "Campaign · 1 session" qualifier on 80 % of rows, "Publication demand is
   fully acknowledged", five counter chips, near-identical series colours).
4. **Dead ends** (182 entries "to consolidate" with no action, a harness
   expander that reveals an identical child, a legend for a chart that is all
   one colour).

Families 1 and 2 undermine trust in a product whose thesis is legibility of
work volume; families 3 and 4 contradict the maintainer's own "hierarchize,
don't drown" rule. Each child plan fixes one coherent slice with deterministic
assertions, so the program can be executed by a single agent in a sitting per
child and verified without a human staring at screenshots.

## Method and evidence

- Browser: Chrome headless driven over CDP (the Chrome extension was not
  connected); each route captured after the page settled (≥ 2.5 s after load,
  see the "Presentation gate" note about warm-server false empties).
- Screenshots (110) were taken against the maintainer's real local data and
  are **not committed** (they contain real prompts, hostnames and paths). The
  table below carries the textual evidence; every child plan re-derives its
  symptom from the synthetic fixtures the repo already ships, so an executor
  never needs the originals.
- One transient `chrome-error://` page was observed when the dev server
  restarted mid-audit (node pid changed); it is not an app defect and is not
  listed.

## Findings table (U01–U42)

Severity: P0 = wrong or broken, P1 = structural UX, P2 = polish.
"Plan" is the child that owns the fix.

| # | Sev | Surface | Symptom (what a reader sees) | Plan |
| --- | --- | --- | --- | --- |
| U01 | P0 | Skills › detail | Client-side nav `/skills/global` → skill card leaves the SKILL.md editor on "Loading…" indefinitely (2/2 repros, no console/network error); full reload renders it | 087 |
| U02 | P0 | Overview vs Analysis | Claude Code ≥ $3,430 (24 %) on Overview vs ≥ $3,222 (23 %) in Harnesses & providers, same filter/minute; Codex and OpenCode identical; harness breakdown does not sum to the overview total | 088 |
| U03 | P0 | Sync | Fleet cards sum to 8,125 sessions; the report says 7,979 for All time. Root cause: the fleet SQL counts every active stored row while the report publishes with `minTokens: 1` from the last revision; 088 resolves it by labelling ("Stored sessions" + caption) and records the normalized-column "one number" path as a follow-up | 088 |
| U04 | P0 | Period | "Today" / Rhythm-day → "Aug 23 → Aug 23 · 0 days"; single-day Activity is one full-width bar with an overflowing value label; "60 % lower than the previous equal-length period" at 09:39 compares a partial day to a full one, silently | 089 (count, caveat) · 093 (chart) |
| U05 | P0 | Sessions | Day filter Jul 15 → Jul 15 lists a row dated Jul 18 first — Date column and range filter use different bounds | 089 |
| U06 | P0 | Drawers | "Campaign · 267 sessions · ≥ $2,567" opens a drawer describing one sub-agent session ($1,020, Calls 1); Sessions drawer header says $8.65 / 5 turns / 83 tools while its grid says $14.36 / 9 / 160 — root vs campaign is never stated | 088 |
| U07 | P1 | Filter bar | Placeholder advertises `( / )` but `/` never focuses the input (CDP key + two synthetic dispatch paths) | 092 |
| U08 | P1 | Analysis › Cursor AI | Commits dated Mar/Apr under a Jul 24 → Aug 23 period; the same commit listed 3× (one per branch); no date order | 090 |
| U09 | P2 | Rhythm readout | "Aug 04, 2026 · 1 sessions" | 098 |
| U10 | P2 | Analysis › Models | "988 / 988 · 100 %" coverage next to "≥" value and "—" per-1M; footnote explains, the 100 % still reads as a contradiction | 098 |
| U11 | P1 | Sessions | Double scroll: page scrolls 372 px, then the table scrolls inside `calc(100dvh − 240px)`; two scrollbars side by side; ~130 px of visible table on 390 px | 091 |
| U12 | P1 | Sessions | TIME column repeats "— root-session time" on every row over two lines | 091 |
| U13 | P1 | Sessions | "Campaign · 1 session" on ~80 % of rows | 091 |
| U14 | P1 | Sessions › Tokens | A provenance "!" on each of the four numbers of every Claude Code row | 091 |
| U15 | P1 | Filter bar | Harness/Machines = bare list without All/checked state; Origin = checkbox popover with Default/All, drawn ~170 px left of its trigger | 092 |
| U16 | P1 | Harnesses & providers | Expanding Codex/Claude reveals one "… sub" child with identical figures | 094 |
| U17 | P1 | Explore activity | Metric chooser and the "API value / Tokens" toggle are one state in two controls; Share leaves the toggle empty; window slider has no ticks/dates | 093 |
| U18 | P1 | Explore activity | Group by Model: the two largest series are near-identical lavenders; "58 grouped" floats under the legend | 093 |
| U19 | P1 | Activity | All time (439 d) at Day interval → 1.6 px bars | 089 |
| U20 | P1 | Session shape | Harness colour legend under an all-orange scatter (legend items inert); untitled standout list; subtitle duplicates the section header | 094 |
| U21 | P1 | Punchcard | Horizontal scroll at 1280 px hides hours 16–23; card two-thirds empty. With the pinned 24 px target the 658 px grid cannot fit a half column below `2xl`, so 094 stacks the two cards 1-up below `2xl` rather than shrinking the dots | 094 |
| U22 | P1 | Provider status | 6/8 detail cards say only "No quota source"; "Codex· MacBook-Pro· partial" chip spacing; Partial vs Unsupported unexplained; five counter chips of jargon; 5H column centred so one item looks like a hole | 095 |
| U23 | P1 | Quota history | "24h" selected yet > 36 h of points; tiny chart with reset hatches over data; three native selects of different widths | 095 |
| U24 | P1 | Skills | Tree names truncate at 1920 px ("Exa…", "Ex…") with 200 px spare; "Skills reloaded." toast on passive load; "Saved" on an untouched file; "To consolidate · 182" is a dead end (→ plan 083); "Healthy links 0/8" not alerting; Context panel duplicates the tiles | 096 |
| U25 | P1 | Skills › matrix | Six narrow tiles with five-line captions; names break letter-by-letter; a 2×4 matrix scrolls in 708 px beside an empty column | 096 |
| U26 | P1 | Skills › validation | `UnknownFrontmatterField` for `compatibility`, `argument-hint`, `allowed-tools` | 096 |
| U27 | P2 | Sync | Fleet cards and contributions table show the same data twice; ~200 px reserved empty space | 097 |
| U28 | P1 | Sources / header | "Publication demand is fully acknowledged.", "RTK dependency: Caught up" (copy → 097). The audit also saw the "1 warning" pill turn into "Sources ready" right after filtering the report to one harness; plan 095 traced the pill to the layout-scoped engine snapshot only (no code path reads the report filter), so the flip is attributed to a coincident engine state change — the warning re-appeared in later captures. 095 makes the pill a pure function of the engine state, stamps the generation, and adds an e2e guard; only a failing guard reopens it as a bug | 097 (copy) · 095 (attribution + guard) |
| U29 | P1 | Session drawer | Harness badge collapses into a circle over "76 matching sessions"; "Aug 02" label overdrawn by the compressed-gaps hatch; five "i" buttons; "Resolve GitHub links" unexplained | 098 |
| U30 | P2 | Projects | One project split per machine while another has no suffix; "+0/-0 · 39/1,514 measured"; centred header over left cells; no search box | 097 |
| U31 | P2 | Report header | "Generated 09:33" reads as the render time; it is in fact the served revision's assembly time (republished about every minute), so the fix is the label — "Data as of <time>" with a `<time datetime>` | 098 |
| U32 | P2 | URL | `?range=%7B%22mode%22%3A%227d%22%7D` | 089 |
| U33 | P2 | Shell | 8 px layout shift between sub-tabs when the scrollbar appears | 098 |
| U34 | P2 | Hero | "≥" wraps alone at 1024 px; no thousands separator | 093 |
| U35 | P2 | KPI tiles | Big numbers not baseline-aligned when a caption is longer | 094 |
| U36 | P2 | Tables | "36,971" / "188k" / "10.9M" in one column | 091 |
| U37 | P2 | Custom range | MM/DD/YYYY inputs (native `type=date` follows the browser UI language — partly an artefact of the audit browser's en-US locale; 089 removes the ambiguity with ISO inputs); two phrasings for "no previous period" | 089 (inputs) · 098 (copy) |
| U38 | P2 | Rhythm | 15 months of "Jun … Aug … Aug" without a year; "scaled by sessions" vs $-first readout; 970 of 1,300 px used. 094 fixes the year marks and the readout order; the width sub-point is deferred — every in-card way to use the width changes the heatmap geometry pinned by ADR 0005/0009 — and is recorded as a section-layout decision, not silently dropped | 094 |
| U39 | P2 | Filter bar | At 1280 px "1 warning" and "Run all" wrap alone | 092 |
| U40 | P2 | Filter bar | Long machine label wraps in a 180 px menu | 092 |
| U41 | P2 | Investigate | 2 + 1 tiles at 768 px | 094 |
| U42 | P2 | Records | "Longest session 53.2h" is a campaign's task-open window | 088 |

What the audit explicitly found **good** and that no child may regress:
persistent quota rail; icon rail at 1024 and bottom bar + cards at 390 with no
horizontal overflow; light/dark parity; 2 px focus ring; named buttons,
labelled inputs, landmark structure; filters in the URL with removable chips
and "Clear all"; drawer ↑↓ "1 / 5" + Analyze timeline; configurable columns
with Work/Tokens/Reliability presets; Copy link / Export CSV everywhere;
campaign rename; reconcile preview with planned/skipped actions; per-metric
provenance ("≥", "Partially measured").

## Child plans and execution order

Run in this order. Plans marked ∥ may run concurrently with the previous group
because they share no files; every other edge is a real file overlap.

| Order | Plan | Title | Pri · Effort · Risk | Findings | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | 087 | Fix the Skills Editor Stuck on "Loading…" After Client-Side Navigation | P0 · S–M · LOW–MED | U01 | isolated bug; root cause is the hydration gate comparing a merged (quota + skills) signature with the skills-only delta → every Skills query `enabled: false` after navigation; ships alone |
| 2 | 088 | One Canonical Number Per Concept | P0 · L · MED | U02 U03 U06 U42 | U02 = `costLowerBound` counted by the executive analytics but not by the harness breakdown; touches `session-drawer.svelte`, `records.svelte`, `machine-fleet.svelte` — must land before 094/097/098 |
| 3 | 089 | Period Semantics — Inclusive Day Counts, Honest Campaign Dates, Auto Interval, Readable Range URLs | P0 · M–L · MED | U04a U05 U19 U32 U37a | U05 = campaign rows date/sort from classifier members outside the range (three engines); touches `report-range-model.ts` and the timeline request — must land before 093 |
| 4 | 091 | Sessions Table — One Scroll Container and Calmer Columns | P1 · M · MED | U11 U12 U13 U14 U36 | keeps ADR 0004 (surface stays the scroll container, sized from measured chrome); plan 076 is already in the tree at `c3de318a` |
| 5 ∥ | 092 | One Checkbox-Filter Mechanic, a Working `/` Shortcut, and a Filter Bar That Holds One Row | P1 · M · MED | U07 U15 U39 U40 | the `/` handler was lost in the Solid→SvelteKit cutover (`807b29af`); replaces the design-system `MultiSelect` |
| 5 ∥ | 090 | Scope the Cursor AI Tab to the Report Period and List One Row per Commit | P1 · S–M · LOW | U08 | web-only: range threaded to the panel, one row per commit with a branch list |
| 6 | 093 | Activity Explorer Controls, Model Palette, and Hero Number Format | P1 · M–L · MED | U17 U18 U34 U04b | after 089; U18 = `hash % 6` collides the two largest series; rank-ordered 12-slot palette validated in OKLab/CVD |
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

- While anchoring the children, two TODO rows of `plans/README.md` turned out
  to be already delivered in the tree at `51815b70`: plan 074 (quota drawer
  strings renamed and `providerHistoryAvailable` wired — verified by grep in
  plan 095's Current state) and plan 076 (campaign root titles on children,
  commit `c3de318a`, noted in plan 091). Their README rows were not changed by
  this program; the maintainer should flip them to DONE after a quick check.
- When a later audit retires a U-row, strike it here rather than deleting it,
  so the evidence trail stays readable.
- Child plans were written by parallel authors against the same base commit;
  if two children disagree on a shared file, the earlier order wins and the
  later child re-derives its "Current state" from the tree it finds.
