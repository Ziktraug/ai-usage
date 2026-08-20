# Plan 085: Spike — a Printable Period Recap on the Existing Print Path

> **Executor instructions**: This is a **design/spike plan** — its
> deliverable is a design decision memo plus a throwaway visual prototype,
> not shipped code. Follow it step by step; if anything in the "STOP
> conditions" section occurs, stop and report — do not improvise. When
> done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- packages/design-system/src/components/ apps/web/src/lib/features/report/actions/ apps/web/src/lib/features/shell/`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P3
- **Effort**: M (spike S–M; build M if approved)
- **Risk**: LOW–MED (product-decision risk, not technical risk)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

`docs/future-work.md:56–58` wants a "'Wrapped'-style shareable report: a
celebratory PNG/PDF recap of a period", framed around the app's thesis —
"if I had to pay API rates, how impossible would it be" — explicitly *not*
ROI optimization. The self-contained-HTML form was rejected with the whole
HTML-export stack (plan 009), and plans/README.md records: "A future
non-HTML recap needs its own product design, privacy rules, and bounded
output contract." Meanwhile the app already maintains a working print
path nobody points the user at: chrome, buttons, and overlays hide under
`_print`, tables expand, and browser print-to-PDF produces a paginated
document with zero new dependencies. This spike decides whether a
print-optimized recap route satisfies the rejected-form constraints, and
prototypes what it would say.

## Current state (verified)

- **Sharing surface today**: exactly two actions — "Copy link" and
  "Export CSV" (`apps/web/src/lib/features/report/actions/report-sharing-actions.svelte:43–46`,
  `sharing.ts:17–36`). No PNG/PDF/canvas code exists in `apps/web/src/lib`.
- **The latent print path** (all verified):
  - `packages/design-system/src/components/layout.ts:51,130` —
    `_print: { display: 'none' }` on chrome slots;
  - `packages/design-system/src/components/table.ts:91–110` — tables
    expand (`maxH: 'none'`, `overflow: 'visible'`, virtualized wrappers
    become `display: block`);
  - `apps/web/src/lib/features/shell/app-navigation.svelte` (rail),
    `app-shell.svelte` (margin reset `_print: { ml: 0, pb: 0 }`),
    `provider-quota-rail.svelte`, and
    `report-sharing-actions.svelte:20` all carry `_print` rules.
- **Data**: every candidate recap number already exists in the bounded
  Overview payload (executive metrics, period comparison for total value,
  records, timeline, top sessions) — no new queries are inherently needed.
- **Constraints that bind the design** (settled; do not violate):
  - Thesis framing only — no ROI, break-even, or budget statements
    (plan 045's locked decisions; memory of the product thesis: the $ figure
    is a legibility proxy for work volume, not a money claim).
  - Per-metric provenance carries into the recap (a `≥` lower bound stays
    `≥`; partial pricing is labeled) — no global quality flag.
  - Privacy: a recap is made to be screenshotted/shared; it contains
    project names and machine labels. The design must state what is in the
    frame and offer exclusion (e.g. a "hide project names" toggle) before
    it is promoted as shareable.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Dev server | `bun run dev` | app on 127.0.0.1 |
| Print check | Chromium + Firefox → print preview / save as PDF on the prototype | readable multi-page PDF |
| Typecheck | `bun run typecheck` | exit 0 |

## Scope

**In scope**:
- A decision memo at `plans/085-recap-design.md` (new file)
- A throwaway prototype (scratchpad HTML mock, or a dev-only route behind
  an explicit query flag that is never linked from the UI) — deleted or
  clearly marked non-shipping at the end of the spike

**Out of scope**:
- Shipping any recap UI, route, or button.
- Reintroducing any self-contained/static HTML export machinery (plan 009
  deletion is final).
- PNG generation (canvas/screenshot libs) — evaluate print-to-PDF first;
  PNG is a follow-up question only if PDF fails the sharing use case.

## Steps

### Step 1: Rule on the constraint question

In the memo, answer explicitly: does a *print-optimized route rendered by
the live app* fall under the plan-009 rejection ("self-contained static
HTML export") or outside it? Evidence to weigh: plan 009 removed a
*generated artifact pipeline* (asset inlining, build constraints, a second
render target that rotted); a print stylesheet on a normal SSR route has
none of those properties and is already maintained today. Recommended
answer: outside the rejection — but write the argument and let the
maintainer confirm, because plans/README.md explicitly reserves this
decision.

### Step 2: Draft the recap content (the hard part)

Design 4–6 leverage-framed statements from existing Overview data, in the
thesis's voice. Candidates to evaluate (pick, reword, or replace):

- the period's API-equivalent value with its provenance qualifier;
- sessions/day rhythm and the streak (heatmap-derived);
- the top campaign by value, named by its (possibly overridden) label;
- model migration over the period (which model took over);
- the "ambitious work" standouts count (long+expensive sessions);
- machines contributing, when >1.

For each: the exact source field in the Overview payload, the provenance
caveat it must carry, and the privacy exposure (project names? machine
labels?). Kill anything that needs a new query — the recap must live
inside the bounded payload or say why one addition is worth it.

### Step 3: Prototype and print

Build the one-page (A4 portrait) prototype with real numbers from the dev
server (hand-copied into a scratchpad mock is fine — this is visual
design, not integration). Print it to PDF in Chromium and Firefox. Record
in the memo: page-break behavior, dark-mode handling (`print` should force
light), typography at print DPI, and whether the result is something a
person would actually post.

### Step 4: STOP — present the memo

Present `plans/085-recap-design.md` with the constraint ruling, the chosen
statements, the privacy in-frame list + exclusion toggle design, both PDFs
(paths), and a build estimate. Stop; the build is a follow-up plan after
the maintainer's call.

## Done criteria

- [ ] `plans/085-recap-design.md` exists with the constraint ruling, the
      statement set with per-statement provenance + privacy notes, and
      print results from two engines
- [ ] No shipped route, button, or nav change (`git status`: only the memo)
- [ ] `plans/README.md` row updated to `DESIGN READY — awaiting decision`

## STOP conditions

- The constraint ruling comes out "inside the plan-009 rejection" — stop
  after Step 1 and report; do not prototype around a settled decision.
- A statement cannot be expressed without an ROI/break-even framing —
  drop it rather than bend the thesis.
- The recap needs data outside the bounded Overview payload for its core
  statements — report the gap instead of widening the payload in a spike.

## Maintenance notes

- If built, the recap route becomes the third consumer of the `_print`
  rules — print styles rot silently, so the build plan must include a
  deterministic print-emulation assertion
  (`page.emulateMedia({ media: 'print' })` + geometry checks), per the
  repo's presentation gate.
- The "hide project names" toggle, if adopted, should also benefit the
  existing print path (printing the Overview today exposes the same
  names).
