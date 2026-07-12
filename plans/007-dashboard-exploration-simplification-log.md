# Plan 007 Implementation Log

## 2026-07-12 — Slice 1

- Created `feat/dashboard-ui-simplification` from `main`.
- Made Sessions identity-first with Work, Tokens, and Reliability presets while
  preserving legacy URL column state through an explicit baseline codec.
- Moved the selected analysis before secondary report status, compacted provider
  status, and kept full provider cards in a collapsed disclosure.
- Made exact filters reversible, added Clear all, preserved Overview when a
  session drawer opens, and removed unnecessary Work-table overflow at 1024px.
- Changed Rhythm intensity to session activity so unpriced active days remain
  visible, added keyboard graph-view adjustment, and improved chart-label
  contrast.
- Independent Standards and Spec reviews found one URL round-trip edge case and
  two product-copy/status gaps; all were fixed before commit.
- Verification passed: Ultracite, all 18 typecheck tasks, full workspace tests,
  production build, and 24 Playwright scenarios.
- Commit: `20ad558 feat(web): simplify dashboard exploration`.

## 2026-07-12 — Slice 2 and 3

- Reduced primary navigation to Overview, Sessions, and Breakdown. Breakdown
  owns Models, Providers, Harnesses, Projects, and Cursor AI as a secondary
  tablist. Existing `?tab=projects`-style links select the corresponding nested
  destination without URL migration.
- Added the text query to active filter pills with direct removal.
- Renamed the filtered interval to Report range, promoted its presets, labelled
  visual-only zoom as Chart view, and moved Group/Bucket/Metric behind a closed
  Chart options disclosure with a live summary.
- Kept Hero, Rhythm, Token anatomy, records, and Top sessions primary. Session
  shape and Punchcard now live in a data-aware Advanced analysis disclosure.
- Model colors now derive from stable series keys rather than value rank.
- Verified 29 focused unit tests, 15 dashboard/time Playwright scenarios,
  Ultracite, all typecheck tasks, and desktop/mobile screenshots.
- Commit: `6478f4f feat(web): streamline dashboard analysis`.

## 2026-07-12 — Slice 4

- Enabled automatic component splitting for server-only `/skills` and `/sync`
  routes while explicitly keeping `/` in the entry chunk for static HTML export.
- The final report entry is 661,858 bytes; Skills and Sync UI are emitted as
  separate 112,730-byte and 6,799-byte chunks. The build test enforces more than
  two JavaScript assets and a report entry below 720,000 bytes.
- Ran all six HTML-export integration scenarios, including a real generated
  self-contained report with no external asset references.
- Commit: `4c8477a perf(web): split server-only route UI`.

## 2026-07-12 — Cold-start regression and final review

- A full fresh-server E2E run exposed an SSR hydration race on `/skills`: a
  native disclosure could open before the split route had attached button
  handlers. The page is now inert and `aria-busy` only until client mounting,
  so early input waits instead of disappearing silently.
- Commit: `abaf7b2 fix(web): guard skills until hydration`.
- The final Standards review found forced narrowing, duplicated session-column
  metadata, and dead API/model fields. The final Spec review found the missing
  additive `Other` aggregation. All findings were resolved.
- Timeline charts now retain the 11 dominant categories and combine a denser
  tail into a non-filterable `Other` series. Model tests verify that both cost
  and session totals remain unchanged by the aggregation.
- Commit: `abaa689 fix(web): close dashboard review findings`.
- Final verification passed: Ultracite, 18/18 typecheck tasks, 17/17 workspace
  test tasks (169 web tests), production build, 6/6 real HTML-export integration
  scenarios, and 27/27 Playwright scenarios on a fresh server.

## Deliberate follow-ups

- Do not aggregate inspectable Session-shape harness marks into `Other` without
  a drill-down/filter contract for aggregate categories.
- Keep saved views deferred until URL sharing proves insufficient.
- Further report-entry splitting requires teaching the single-file exporter to
  rewrite and inline dynamic imports; route splitting alone is not safe.
