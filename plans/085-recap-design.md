# Design: A Printable Period Recap on the Existing Print Path

> Deliverable of **plan 085**. A decision memo plus a throwaway visual
> prototype. **Nothing was shipped**: no route, no button, no nav change, and
> the prototype lives in the session scratchpad, not in the repo.
>
> Written at `69ce9b75` (base `5e4cf954`). The plan's drift check over
> `packages/design-system/src/components/`,
> `apps/web/src/lib/features/report/actions/` and
> `apps/web/src/lib/features/shell/` returned empty.

---

## 0. Summary of recommendations

| Question | Recommendation |
|---|---|
| Does a print-optimised route fall under the plan-009 rejection? | **No — it is outside it.** §1 gives the argument; the maintainer confirms. |
| What does the recap say? | **Four statements** (§2). Six candidates are killed, five of them because a single bounded Overview request cannot support them (§2.6). |
| Does it fit the bounded Overview payload? | **Yes, after the cuts** — one request, one timeline dimension, no widening (§2.7). |
| Does browser print-to-PDF produce something postable? | **Yes** — one A4 page with 17% headroom; the two engines agree on page height to 0.9 px (§3). |
| What is the privacy exposure? | **None.** After the cuts, the surviving four statements contain no project name, machine label, session title, or prompt-derived text. The exclusion control becomes a *precondition* for ever adding a killed card back, not a feature to ship now (§4). |
| Should it be built? | **Yes, if the maintainer wants the "Wrapped" direction at all** — S–M, and it is the cheapest possible version. §5 lists two things that must land with it. |

**One Done criterion is only partially met and the status row should be read
with that in mind:** print results were obtained from two engines, but a
Firefox *PDF* could not be produced in this environment (§3.1). Gecko was
verified for print stylesheet and geometry; its pagination is unverified.

---

## 1. Step 1 — the constraint ruling

**Ruling: a print-optimised route rendered by the live app is outside the
plan-009 rejection.** Recommended for confirmation, because
`plans/README.md` explicitly reserves this decision.

Plan 009 did not reject "a second way to look at the report". It rejected **a
generated-artifact pipeline**, and it enumerated exactly what that pipeline
was. From `plans/009-remove-html-export.md` ("Why this matters"):

> The current HTML path hangs in its integration test and spans much more
> than a renderer. It adds a CLI format, a root export command, a complete
> focused-query kind, a public package export, browser globals, hash routing,
> an asset inliner, special Vite chunking, a web download action, Playwright
> configuration, and two CI jobs. Keeping those seams for an unused feature
> increases every later report refactor's state space.

Point by point, against a print stylesheet on a normal SSR route:

| Plan 009 removed | Does a print route reintroduce it? |
|---|---|
| A CLI output format (`--html`) | No — nothing in the CLI changes |
| A root `bun run html export` command | No |
| A focused-query kind (`html-payload`, `FocusedHtmlPayloadResult`) | No — it reads the Overview payload the app already fetches |
| A public package export (`@ai-usage/report-core/html-export`) | No |
| Browser globals (`__AI_USAGE_REPORT*`) and hash routing | No — a normal SvelteKit route with normal history |
| An asset inliner / asset-closure graph | **No, and this is the crux** — nothing is inlined, because nothing is detached from the app |
| Special Vite chunking (CSS code-splitting disabled) | No |
| A web download action | No — the browser's own print dialog produces the file |
| Playwright configuration + two CI jobs | One print-emulation assertion in the existing suite (§5), not a separate config or job |

The decisive property is **detachment**. Everything plan 009 removed existed
to make an artifact that had to survive *away from the running app* — which
is why it needed inlined assets, globals, hash routing, and a second render
target, and why it rotted. A print stylesheet has no second render target:
the app renders itself, the browser paginates it, and the PDF comes from the
user's own print dialog. If the app changes, the print view changes with it,
because it *is* the app.

Two supporting facts:

1. **The print path is already maintained.** 19 `_print` rules exist across
   `packages/design-system/src` (9) and `apps/web/src` (10) —
   `layout.ts:51,130`, `table.ts:91,100,105,110,119`, `button.ts:89`,
   `svelte/overlays/styles.ts:22`, `app-shell.svelte:39`,
   `app-navigation.svelte:60,142`, `provider-quota-rail.svelte:102`,
   `report-sharing-actions.svelte:20`, `breakdown/styles.ts:84`,
   `sync/styles.ts:80,89,90`, `sources/styles.ts:19`. This spike adds a
   *consumer* for maintenance already being paid. (All 19 are
   chrome-suppression or table-unclipping; there is no `@page` rule, no
   `break-*` rule, and no `window.print()` call anywhere in the repo — so
   pagination is a clean slate.)
2. **Nothing else can produce a shareable file.** No PNG/PDF/canvas code
   exists in `apps/web/src` or `packages/*/src` (no `jspdf`, `html2canvas`,
   `satori`, `resvg`, `toDataURL`, `toBlob`, `getContext('2d')`). The only
   export paths are two text blobs: `apps/web/src/report-export.ts:2` (CSV)
   and `sync/manual-transfer.svelte:99` (merge bundle). Browser print-to-PDF
   is the only shareable-artifact mechanism the codebase affords without a
   new dependency — which is what the plan's "PNG is a follow-up question
   only if PDF fails" ordering already anticipated.

**One caveat, stated against my own recommendation:** plan 009's list
describes *that* implementation; it is not a definition of the rejected
category. If the maintainer's intent was broader — "no second presentation of
the report, full stop" — this ruling is wrong and the spike should stop at
this section. Nothing in the written record says that, which is why the
recommendation is "outside", but the record is a description rather than a
rule.

*(The STOP condition "the constraint ruling comes out inside the plan-009
rejection" was therefore not triggered, and Steps 2–3 proceeded.)*

---

## 2. Step 2 — the recap content

Numbers are real, computed read-only from this machine's store for
2026-07-21 → 2026-08-20 (2,911 sessions, 4 harnesses).

### 2.0 The constraint that shapes everything: one request, one dimension

This section was rewritten after adversarial review, which correctly found
that the first draft's statement set could not be produced from the payload
it cited. The governing fact:

> `FocusedOverviewResult.timeline` carries **exactly one dimension at a
> time**, chosen by `FocusedOverviewRequest.timeline.dimension`
> (`focused-report-query.ts:113–117`), and the app opens on `'harness'`
> (`report-destination.ts:98–101`).

Every per-dimension roll-up — per model, per machine, per project, per
harness *over time* — comes from that one slot. The recap therefore gets
**one** grouped statement, and everything else must come from the
always-present parts of the payload.

Spending that slot on models (§2.4) is what killed the **per-machine split**
(§2.6). The other kills have their own, independent causes — a hard cap on
`outliers`, a roll-up that lives in a different query, a suppression rule in
the report's own presentation layer, and a revision-wide rather than
range-scoped source. §2.6 names each one; the shared theme is that the
payload is narrower than the plan's candidate list assumed, not that one
constraint explains everything.

What is always present regardless of dimension: `summary.*` (including
`priceMeasurement`), `view.previousSummary`, `view.executive.harnesses[]` and
`.models[]` (**capped at 5 groups**, `MAX_EXECUTIVE_GROUPS = 5` at `:406`,
current period only), `view.heatmap`, `view.records`, `view.punchcard`,
`view.sessionShape`, `view.topSessions` (top 5). The sibling bootstrap
document adds `support.machineFreshness.machines[] { id, label, lastSeenAt }`
(`:50–54`) and `support.filterOptions`.

### 2.1 Hero — API-equivalent value **[keep]**

> **≥ $13,871** · *Partially measured*
> "Billed at published API list prices, this month of work would read as
> roughly fourteen thousand dollars of model usage. That is a way to read the
> volume of what was done — not a bill, not a saving, and not a claim about
> what it was worth."

- **Source**: `summary.totalCost` + `summary.priceMeasurement` (`:135`).
- **Provenance**: `state` is `'partially measured'` — 1,276 of 2,911 sessions
  carry a priced token record (43.8%) — so it renders with `≥` and the
  "Partially measured" chip, exactly as `aggregateApiValuePresentation`
  (`report-value.ts:58`) and `aggregateApiPriceProvenance` (`:64–71`) already
  do everywhere else. **The recap gets no softer rule than the report.**
- **Privacy**: none. No name of any kind.
- **Thesis check**: the sentence is the app's thesis verbatim. It says
  explicitly this is not a bill and not a saving. No ROI, no break-even, no
  budget.

### 2.2 Rhythm **[keep]**

> **29 / 30 days** — "Work landed on all but one day, with a longest unbroken
> run of **27 days**. The busiest single day carried 588 sessions."

- **Source**: `view.heatmap` (`:329`; one `FocusedHeatDay` per local calendar
  day, each carrying `date`, `sessions`, `cost`, `level`, `priceMeasurement`),
  **filtered to the recap's own period and reduced by the recap**.
- **Do not use `view.records.streak`.** This was a first-draft error, caught
  in review. `buildFocusedRecordsFromAggregates` (`:1347–1359`) builds a set
  of active days from `timelineDays` — the **range-unfiltered** set — then
  counts backwards from the *latest* day until it hits a gap. That is a
  *trailing, all-history* streak, not the longest run inside a period. It
  happens to coincide for a recap of "the last 30 days ending today"; it is
  simply wrong for any historical or filtered period, which is exactly what
  a recap route invites. **Compute the maximum consecutive run over the
  period-filtered heatmap cells instead.**
- **Do not use `view.records.busiest` for "busiest day" either** without
  reading it carefully: it reduces `visibleDays` by **cost**, not sessions
  (`:1340–1346`), so it answers "the most expensive day". If the card says
  "sessions", take the max-sessions cell from the same period-filtered
  heatmap array.
- **Provenance**: (a) the card counts *sessions*, not value, so no `≥` is
  needed — say "sessions", never "$", here. (b) `buildHeatmap` is fed
  `timelineRows`, **not** the range-filtered `visible` set (`:1471`), and is
  capped at 730 days (`:1078–1080`) — which is precisely why both the streak
  and the busiest day must be recomputed over a filtered slice rather than
  taken from the array wholesale.
- **Privacy**: none.

### 2.3 The long one **[keep — reframed]**

> **53.2 hours** — "The longest *fully measured* session of the period ran
> more than two days end to end."

- **Source**: `view.sessionShape.harnessSummaries[].durationMax` (`:279–297`),
  maximised across harnesses.
- **The wording "fully measured" is load-bearing, not decoration.**
  `buildSessionShape` admits only items satisfying
  `costKnown && durationMs > 0 && costApprox > 0` (`:1186–1189`), so
  `durationMax` is the longest **priced** session, not the longest session.
  Here 61% of the period is excluded, so a longer unpriced session is
  entirely possible and would not appear. An unqualified "the longest session
  of the period" would be false. This was a first-draft error, caught in
  review; the card now carries the qualifier in the headline sentence and
  spells the consequence out in its provenance line.
- **Provenance**: Session Shape also returns `null` below 3 qualifying
  sessions (`:1190`), and `totalPoints` is session-weighted. The card states
  the 1,138 / 2,911 split.
- **Privacy**: none *as specified*. It must **not** name the session or its
  project: the longest session here sits in a named repository, and
  `view.records.longest.row` carries `projectLabel`.
- **Why reframed**: the first draft said "104 standouts", computed as a
  top-decile intersection. That number **is not in the payload** —
  `sessionShape.outliers` is hard-capped at **6** by construction
  (`:1246–1258`, `outliers.length < 6`), and `points` are binned
  representatives with an `aggregateCount`, not individual sessions. A
  "standouts" count would either always read 6 (a constant, not a finding) or
  require data the payload does not carry. A single superlative from
  `durationMax` is the honest version, and it keeps the
  `docs/future-work.md` framing — ambitious work, not runaway.

### 2.4 Which model took over **[keep — this is the one dimension slot]**

> **claude-fable-5 opened the period at 2.9% of measured value and closed it
> at 11.9%**, while gpt-5.5 fell out of the picture entirely. The workhorse
> did not change; the second seat did.

- **Source**: `timeline.buckets[].byKey` at `timeline.dimension === 'model'`
  (`:149–177`), comparing the **first and last buckets of the period**.
- **Why within-period rather than period-over-period**: `view.previousSummary`
  is a `FocusedReportSummary` with no per-model breakdown, and
  `view.executive.models` is current-period only and capped at 5. A
  cross-period model comparison is therefore **not** in the bounded payload.
  Comparing the period's own first and last buckets needs nothing extra,
  and it reads better anyway: a recap should describe its own period.
- **Provenance**: multi-model sessions are split across `modelSegments`
  (`:647–663`), so shares are value-weighted; buckets carry
  `priceMeasurement` (`:172`), so in a partially-measured period these are
  shares *of measured value* — the card states both. The timeline also
  collapses beyond `MAX_TIMELINE_SERIES = 12` into `Other` (`:408, :812`),
  which the recap must not mistake for a model.
- **Privacy**: **none, and that is this card's quiet advantage.** Model
  identifiers are vendor strings. It is simultaneously the most interesting
  and the least revealing statement available, which is a good reason to
  spend the single dimension slot here and to make it the visual centrepiece.

### 2.6 Killed candidates, with reasons

**Killed — top campaign by value** (privacy, plus a naming problem):

1. **The label is raw prompt-derived text.** This period's top five campaign
   labels, taken from `row.name`, include a first prompt beginning with an
   employer's Jira URL and a ticket ID, and another containing a GitHub
   handle. Printing that on a page designed to be screenshotted publishes a
   ticket number and an employer's Jira host. Label *overrides* exist
   (`campaign-label.ts:8–11`) but they are opt-in per campaign, fetched from
   a **separate** route (`web-contract/src/report.ts:437–442`) and applied
   client-side (`apps/web/src/campaign-label-overrides.ts:64–77`) — so the
   default is the unredacted prompt-derived title.
2. **"Campaign" is a misnomer here.** All five top campaigns by value in this
   period are **single-session**; only 257 of 1,152 campaign roots have more
   than one session. "Top campaign" would render as "top session".

   If wanted anyway, the only safe form is *"the biggest campaign ran N
   sessions over M days"* with **no label at all**.

**Killed — period-over-period delta** (the report's own rules forbid it):
`comparisonFor` (`executive-overview-model.ts:102–119`) **suppresses the
delta unless neither period is `'partially measured'`**. At 43.8% coverage
this period is. Measured for the record: the raw change is +51.2% (previous
period $9,176). **The recap must not print a number the report itself
refuses to show** — that would be the recap holding a lower evidentiary bar
than the page it summarises, which is the easiest way for this feature to
become dishonest.

**Killed — "where the work went" / projects** (not in the payload):
there is no per-project roll-up in Overview at all — `FocusedProjectGroup[]`
lives in `FocusedBreakdownResult.groups.projects` (`:337–347, :360`), a
different query. Project names reach Overview only through rows embedded in
`topSessions` (top 5), `records`, and `sessionShape.points` (binned
representatives), which are bounded subsets: they can neither count the
period's projects nor establish which one holds most of its value. Reaching
for the Breakdown payload would trip the plan's own STOP condition ("the
recap needs data outside the bounded Overview payload … report the gap
instead of widening the payload"). **Reported, not built.** This is also the
largest privacy exposure that could have been on the page — three of this
period's top five projects are employer repositories — so losing it is a
double win.

**Killed — a "standouts" count**: see §2.3. `outliers` is capped at 6 by
construction, so any count either reads 6 forever or is not in the payload.

**Killed — machines, entirely** (two independent reasons):

1. **The per-machine split needs the dimension slot.** The first draft
   claimed "2,573 / 338 sessions"; those totals require the timeline at
   `dimension: 'machine'`, which §2.4 has spent on models. Embedded Overview
   rows (`topSessions` top-5, `records`, binned `sessionShape.points`) are
   bounded subsets and cannot be summed into machine totals.
2. **Even the bare count is not range-scoped.** The obvious fallback —
   the length of `support.machineFreshness.machines[]` (`:50–54`) — lives in
   the sibling `FocusedSupportResult`, which is **revision-wide**, not
   filtered to the recap's period. It would happily count a machine that
   contributed nothing during the period, so "2 machines contributed to
   *these thirty days*" would be an unbacked claim. Caught in review after
   the first draft kept it as an optional fifth card.

   The card is dropped. If the maintainer wants it back, the honest form
   needs a second, range-scoped query — and then §4's exclusion control
   becomes mandatory, because machine labels are where the personal names
   are.

### 2.7 Net result: no payload widening, one parameter change

The surviving set needs exactly one thing the app does not do today: the
recap route requests the Overview it already requests, with
`timeline.dimension: 'model'`. Same procedure, same budgets
(`MAX_SERVED_BOOTSTRAP_BYTES` 512 KiB, `MAX_OVERVIEW_REFRESH_BYTES` 2 MiB in
`report-budgets.ts`), one parameter different. `includeAdvanced` must be
true for §2.3.

---

## 3. Step 3 — prototype and print results

**Prototype** (throwaway, scratchpad only, never in the repo):
`…/scratchpad/recap-prototype.html` — one A4 portrait page,
`@page { size: A4 portrait; margin: 0 }`, `break-inside: avoid` on every card.

| File | What |
|---|---|
| `…/scratchpad/recap-chromium.pdf` | Chromium print-to-PDF, **1 page** |
| *(removed)* `recap-chromium-redacted.pdf` | the exclusion-toggle variant; deleted once §2.6 removed the last card with anything to redact. Its findings survive in §4. |
| `…/scratchpad/recap-chromium-1.png` | page 1 rendered at 90 dpi |
| `…/scratchpad/recap-firefox-print.png` | Gecko under `emulateMedia({ media: 'print' })` |
| `…/scratchpad/recap-prototype-v1-buggy.html` | the pre-fix version, kept so §3.2 is reproducible |

### 3.1 Engine coverage — and the gap

| Engine | How | Verified |
|---|---|---|
| **Chromium** (system `google-chrome-stable`) | `--headless --print-to-pdf` | Real pagination, real PDF, page count, PDF text layer |
| **Gecko** (Playwright Firefox 151) | `emulateMedia({ media: 'print', colorScheme: 'dark' })` + geometry probe | Print stylesheet, forced light, layout geometry |

**A Firefox PDF could not be produced here, and the plan's "print it to PDF
in Chromium and Firefox" is therefore only half satisfied.** This is a real
gap, not a formality:

- neither reachable Firefox exposes a `--print` flag — checked directly on
  both the nixpkgs build (154.0) and the Playwright build (151); both list
  only `--screenshot`;
- Playwright's `page.pdf()` is Chromium-only;
- the Playwright Firefox would not launch at all until given a
  hand-assembled `LD_LIBRARY_PATH` across 29 nixpkgs libraries (it failed
  first on `libgtk-3.so.0`, then `libX11-xcb.so.1`); the `steam-run` FHS
  shortcut is unfree and was not enabled on the user's system.

So **Gecko's pagination and `@page` handling are unverified.** Geometry and
the print stylesheet were verified and agree with Chromium to **0.9 px**
(§3.3), which makes a pagination difference unlikely but does not exclude
one. Closing this properly is an environment task — a devshell carrying the
Gecko runtime deps — and should be scoped alongside §5's assertion rather
than assumed away.

### 3.2 The finding that justifies the exercise: print did **not** force light

The first prototype used the repo's own theming idiom — light tokens on bare
`:root`, dark tokens under `@media (prefers-color-scheme: dark)` guarded as
`:root:not([data-theme="light"])`, and a `@media print` block re-declaring
the tokens on plain `:root`. Measured under Chromium with print media and a
**dark** colour scheme:

```
bodyBg: rgb(255, 255, 255)      ← print override won (a direct declaration)
ink:    rgb(240, 237, 230)      ← dark token survived  →  near-white text on white paper
```

The cause is specificity, not order: `:root:not([data-theme="light"])`
(0,2,0) beats `:root` (0,1,0), so the dark token wins wherever the print
block sits. `body { background: #fff }` escaped only because it is a direct
declaration rather than a token.

**Gecko did not reproduce it** — it reported `ink: rgb(17,17,17)` on the same
buggy file, because its print emulation dropped `prefers-color-scheme: dark`.
So a Gecko-only check would have passed a page that prints as blank paper in
Chrome. That asymmetry is itself the argument for §5's assertion.

The fix is one line — repeat the dark selectors inside the print block:

```css
@media print {
  :root,
  :root:not([data-theme="light"]),
  :root[data-theme="dark"] { --ink: #111; --bg: #fff; /* … */ }
}
```

After the fix, both engines report `bg rgb(255,255,255)` / `ink rgb(17,17,17)`
under print + dark.

### 3.3 Page-break behaviour and geometry

| | first draft (6 statements) | after the token fix | **final (4 statements)** |
|---|---|---|---|
| Chromium PDF pages | **2** (page 2 held the footer alone) | 1 | **1** |
| `.page` height under print, Chromium | 1169 px | 1120 px | **932 px** |
| A4 at 96 dpi | 1123 px | 1123 px | 1123 px |
| Overflow | **+46 px** | −3 px | **−190 px (17% headroom)** |
| `.page` height under print, Gecko | 1267 px | 1120.3 px | **932.9 px** |

Three things worth recording:

- `break-inside: avoid` on `.card` behaved **correctly and unhelpfully**: it
  refused to split a card, which is right, and therefore pushed the last two
  cards plus the footer onto a second page rather than producing an ugly
  split. The widow page was the honest signal that six statements do not fit.
- **The intermediate −3 px "fit" was not a margin, it was a coincidence.**
  Trusting 3 px across font stacks and locales would have been a mistake —
  this prototype already relies on a serif fallback chain, and a machine
  without those faces reflows. The §2.6 cuts, made for payload-correctness
  reasons, incidentally bought a real **17%** margin. That is the version to
  build, and it leaves room for a fifth statement should a future plan make
  one honestly available.
- The two engines agree on total page height to **0.9 px**, strong evidence
  the print stylesheet itself is portable even though pagination was checked
  in only one.

### 3.4 Typography at print DPI

At 90 dpi raster the hero (40 pt serif), the 8 pt mono card headings, and the
7.5 pt mono bar labels are all legible; the 8 pt `--muted` provenance lines
are the floor and should not go smaller. One bug surfaced only in print: the
bar `%` fills rendered as full-width grey because `.bar-track` was an inline
`<span>` — percentage widths do not resolve against an inline box.
`display: block` fixed it. That class of bug is invisible on screen if the
chart is only ever inspected in dev tools, which is another argument for §5.

### 3.5 Would a person actually post this?

Yes. The page reads as a designed document rather than a screenshot of a
dashboard: one dominant figure, two supporting cards, one chart, a footnote
card, and a footer. The `≥` and the "Partially measured" chip sit *inside*
the composition rather than as an apologetic footnote, which keeps it honest
without making it look hedged.

The four-statement version is also a better artefact than the six-statement
one — the cuts removed the two cards that added least and risked most.

---

## 4. Privacy: what is in the frame, and the exclusion control

**In the frame, by surviving card — the answer is nothing:**

| Card | Identifying content |
|---|---|
| Hero value | none |
| Rhythm | none |
| The long one | none *as specified* — the duration only; it must **not** name the session or its project, and `view.records.longest.row` carries `projectLabel`, so this is a rule the build must hold, not a property it gets for free |
| Model migration | none — vendor model identifiers only |

**The four-statement recap contains no project name, no machine label, no
session title, and no prompt-derived text.** That is a genuinely strong
result for a page whose purpose is to be screenshotted, and it was not the
goal — every cut in §2.6 was made for payload-correctness reasons and the
privacy improvement fell out of it.

**What the killed candidates carried**, measured on this machine, so the cost
of ever re-adding them is on the record:

| Killed card | Exposure |
|---|---|
| Where the work went (projects) | 23 project names; **three of the top five by value are employer repositories** |
| Top campaign | **raw prompt-derived text** — one label begins with an employer's Jira URL and ticket id, another contains a GitHub handle |
| Machines | **machine labels** — one of the two here is `MacBook-Pro-de-Nathan`, the macOS default form |

**Consequence for the design: the exclusion control is a *precondition*, not
a shipped feature.** Nothing in the four-statement recap needs redacting, so
building the toggle now would be building a control with nothing to control.
It becomes mandatory the moment any of the three killed cards is
reconsidered. The rest of this section records what the prototype learned
about how to build it, so that a future plan starts from the answer.

**The control: a "hide names" toggle — but it must be a data decision, not a
CSS one.** The prototype implemented it in CSS (`visibility: hidden` plus a
`::after` replacement) specifically to test whether that shortcut is safe. It
is not:

1. **It broke the layout.** In the six-card draft the absolutely-positioned
   replacement text overlapped its neighbours ("Machine A" colliding with
   "carried"), visible in the rendered PDF.
2. **The real string stays in the DOM.** Anyone who views source, or any tool
   that re-renders without the stylesheet, sees it. *Chromium's* PDF export
   happened to omit the hidden text from the text layer — verified twice with
   `strings`/`pdftotext`, zero occurrences of the real labels — but that is
   an engine behaviour to be grateful for, not a guarantee to design against.

**Recommendation, for whenever it is needed:** the toggle sets a parameter
the *server-side load* reads, and identifying strings are replaced with
generic labels **before render**, so the real string never reaches the DOM.
Put it in the URL so a shared link carries the setting, and default it to
*hidden* — a recap is made to be shared, so the safe state is the default
state.

**The one privacy item worth acting on now, independent of this feature:**
the same control should apply to the *existing* print path. Printing the
Overview today already exposes machine labels and project names with no way
to suppress them, and that is true whether or not the recap ever ships. It is
a small plan of its own.

---

## 5. If it is built: two non-negotiables and an estimate

1. **A deterministic print-emulation assertion**, per the repo's presentation
   gate. §3.2 is the argument: a print-stylesheet regression is invisible in
   every normal test, and the two engines disagreed about it. The assertion
   must run `page.emulateMedia({ media: 'print', colorScheme: 'dark' })` and
   assert (a) dark ink on a light background — the exact bug that shipped in
   the first draft — and (b) rendered page height within the A4 content box.
   Geometry, not a screenshot diff.
2. **Recompute the two period-scoped statements rather than reading them off
   the payload** (§2.2, §2.3): the longest run and the busiest day must be
   derived from period-filtered heatmap cells, never from
   `view.records.streak` (trailing all-history) or `view.records.busiest`
   (reduced by cost); and the longest-session figure must carry the "fully
   measured" qualifier because `durationMax` only sees priced sessions. Both
   are one-line traps that produce plausible wrong numbers, which is the
   worst failure mode a shareable page can have.

*(Redaction in the load rather than the stylesheet, §4, is a precondition for
adding a killed card back — not work for this build, since nothing on the
four-statement page needs it.)*

**Estimate.** Build S–M:

- a route rendering the four cards from the Overview payload it already
  fetches, with `timeline.dimension: 'model'` — S;
- `@page` rules and the print token block with the corrected specificity — XS;
- the two period-scoped reductions above — XS;
- the print-emulation assertion — S;
- an entry point. **This is the open product question**: `Copy link` and
  `Export CSV` are the only two sharing actions today
  (`report-sharing-actions.svelte:43–46`), and the recap is a third. Whether
  it belongs there, in the period selector, or nowhere at all (a URL you
  learn about) is a call this memo does not make.

---

## 6. Constraints checked

- **No ROI, break-even, or budget framing.** The hero says explicitly that
  the figure is not a bill, not a saving, and not a claim about worth. The
  period delta was killed (§2.6) rather than reframed.
- **Per-metric provenance carried, never a global flag.** `≥` stays `≥`
  (§2.1); the heatmap's session-count basis and unfiltered source row set are
  stated on its card (§2.2); Session Shape's 61% exclusion and the "fully
  measured" qualifier on its own (§2.3); model shares labelled as shares of
  measured value (§2.4). No card borrows another's confidence, and there is
  no global quality badge.
- **No self-contained/static HTML export.** Nothing is inlined, generated, or
  downloaded by the app. §1.
- **No payload widening.** Five of the six killed candidates were killed
  rather than served by a second query (§2.6), which is what the plan's STOP
  condition asks for. The sixth (the period delta) was killed by the report's
  own suppression rule, not by data availability.

## 7. Where this memo is uncertain

- **The constraint ruling is an interpretation** of a plan that described its
  own implementation rather than defining a category (§1). It is the memo's
  weakest link and is presented for confirmation, not as settled.
- **Gecko pagination is unverified** and a Firefox PDF was not produced
  (§3.1). Geometry agreement to 0.9 px makes a difference unlikely; it does
  not exclude one. This is the one Done criterion not fully met.
- **Earlier drafts of this memo asserted five things the payload does not
  support**, all caught in adversarial review and all corrected in place: a
  standouts count (`outliers` is capped at 6), a per-machine split (needs the
  spent dimension slot), a machine *count* (`machineFreshness` is
  revision-wide, not range-scoped), a project card (roll-up lives in
  Breakdown), and an unqualified "longest session" (`durationMax` only sees
  priced sessions). They are recorded as killed in §2.6 rather than deleted,
  because "we tried to say this and the payload would not support it" is the
  useful part for whoever builds this — and because the pattern is
  informative: **every candidate that sounded good turned out to need data
  the Overview payload does not carry.** That is the real finding of Step 2.
- **One machine, one period.** 43.8% price coverage drives both the `≥` and
  the killed delta; a user with fuller pricing gets a plain `$` figure *and*
  a period delta, which changes the hero's composition. Only the
  partially-measured case was prototyped, and the design must handle both.
- **Four statements may be too few** to feel like a "Wrapped". That is a
  product judgement this memo cannot settle: the payload will not honestly
  support more without a second query, so the real choice is four honest
  statements or a decision to widen the payload in a follow-up plan.
