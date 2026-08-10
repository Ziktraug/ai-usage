# Plan 073 implementation decisions

This is the review ledger for implementation choices made while executing
Plan 073. It records decisions and trade-offs; measured results and completion
evidence remain authoritative in the plan's Execution log.

## D001 — Use the corrected implementation branch

- **Decision**: implement on `refactor/report-decision-first-ui-ux` at clean
  start SHA `edf7704c`.
- **Reason**: the originally supplied `agent/report-decision-first-ui-ux`
  branch does not exist. Commit `edf7704c` changes the committed plan to name
  the existing `refactor/` branch, while the code still matches base
  `1868b108` exactly.
- **Consequence**: no branch rename or history rewrite.

## D002 — Treat two omitted Report token files as trivial scope corrections

- **Decision**: allow `report-warnings.svelte` and `report-status.svelte` to be
  corrected during the final visual-language pass.
- **Reason**: both active Report files already contained
  `token(colors.border)` at the planned base, but the plan listed only three
  occurrences. `report-warnings.svelte` also used interaction copper for an
  anomaly. The operator explicitly authorized continuing through trivial STOP
  conditions and resolving the border issue at the end.
- **Consequence**: remove all five invalid Report token references and restore
  semantic warning colors before the final gate; do not broaden this exception
  beyond these two Report files.

## D003 — Keep the plan's public test seams

- **Decision**: test through focused-result validation, memory/SQLite parity,
  pure presentation models, composition props, the existing Drawer API, and
  browser-observable DOM/network behavior.
- **Reason**: these are the seams agreed in Plan 073 and required by the TDD
  workflow. Tests must not couple to private helpers or reproduce production
  formulas as their expected values.
- **Consequence**: each behavior slice starts red and becomes green in the same
  wave; database and browser boundaries are the only mocked or synthetic edges.

## D004 — Enforce exclusive multi-agent file ownership

- **Decision**: the contracts agent exclusively owns the six report-core/store
  analytics and focused-query files; the UI agent exclusively owns
  design-system, Analysis, navigation-label, and Session-drawer files; the
  principal agent owns plan/docs, URL/range, composition, Overview, fixtures,
  timeline Web models, and cross-cutting E2E. QA remains read-only.
- **Reason**: prevent concurrent edits to the same file while retaining
  independent review and smoke coverage.
- **Consequence**: agents do not modify plan status, make commits, or launch
  shared browser servers without coordination.

## D005 — Use the plan's named editorial style interface

- **Decision**: expose `executiveGrid`, `editorialSection`, `sectionDivider`,
  `metricStrip`, `containedInteractive`, and `numericDisplay` from the Report
  design-system entrypoint, adding narrow caption/label styles only when the
  composition needs them.
- **Reason**: these names are locked by Step 4 and provide a narrow interface
  between the design-system and Overview composition owners.
- **Consequence**: do not change global `panel` behavior or create wrapper-only
  components.

## D006 — Run server-owning gates outside the filesystem sandbox

- **Decision**: run production builds and Playwright commands with the normal
  host permissions when required.
- **Reason**: Panda stalled before generating output inside the restricted
  sandbox, and loopback Playwright servers could not start there. The exact
  commands completed successfully outside it.
- **Consequence**: command lines, fixtures, assertions, budgets, and reporters
  remain unchanged; this is execution-environment handling, not a relaxed gate.

## D007 — Keep lazy destinations behind a stable snippet boundary

- **Decision**: pass Breakdown/Analysis into the shared destination presenter as
  a stable Svelte snippet plus an explicit readiness flag, and keep the dynamic
  module, its props, and its retry state inside each destination owner.
- **Reason**: a nullable `{ component, props }` package left a compiled props
  getter alive briefly during history navigation; after the package became
  `null`, that getter caused the observed `null.props` page error. The snippet
  boundary removes that nullable cross-component getter without changing Query
  ownership or the existing `breakdown` URL identifiers.
- **Consequence**: never reintroduce a deferred spread or non-null assertion over
  a nullable destination package. Browser history, reload, deep-link, and Retry
  tests are the runtime authority for this seam.

## D008 — Inject the expected lazy-load failure before browser module import

- **Decision**: use a one-shot E2E import factory that rejects the first named
  destination load, then delegates the retry to the real dynamic import.
- **Reason**: aborting a Chromium `script` request would conflict with the strict
  browser failure gate and can poison the browser module map, so it would not
  prove that the product retry state works. A deterministic pre-import rejection
  exercises the same owner state machine while every unrelated console, page,
  request, and reload failure remains fatal.
- **Consequence**: the seam is inert outside E2E, the retry must keep the same
  document and workspace, and the second attempt must load the real Analysis
  module without adding an Overview or Breakdown business request.

## D009 — Allow the narrow Step 5 composition scope expansion

- **Decision**: include `report-destination-owner.svelte`,
  `report-status.svelte`, `lazy-module-loader.ts`, and
  `lazy-module-e2e-fixture.ts` in the Step 5 implementation surface.
- **Reason**: these four direct seams are required to provide the existing-state
  Models link, a retryable first/lazy failure, and deterministic coverage of that
  behavior. They were omitted from the plan's literal production allowlist, but
  do not add a route, Query owner, fetch, library, or unrelated behavior. The
  operator explicitly authorized autonomous handling of trivial stop/scope
  inconsistencies.
- **Consequence**: record this as a deliberate plan deviation. The temporary
  edit to `source-control-summary.svelte` was reverted, so frozen Sources action
  labels remain unchanged.

## D010 — Change the visible destination language, not its contracts

- **Decision**: present `Analysis` in navigation and accessible labels while
  preserving every internal `breakdown` URL, search key, tab identifier, RPC,
  and historical sort contract.
- **Reason**: Plan 073 asks for decision-oriented product language but explicitly
  freezes the existing deep-state and transport identifiers. The Models
  `Tokens` sort therefore continues to use fresh tokens as defined by the
  earlier contract, even though the new evidence column reports processed
  tokens (`cache read + cache write + input + output`).
- **Consequence**: table and mobile cards share one pure presentation model;
  desktop exposes the semantic six-column table, mobile exposes the equivalent
  card list, and CSS makes exactly one representation available at each
  breakpoint without adding a request or hydration branch.

## D011 — Retain one responsive Drawer machine after its first opening

- **Decision**: lazy-load one `SessionDrawer`, retain that single component and
  its last presented row after close, and drive its Ark machine with an explicit
  responsive `open` state. Re-enter the same machine when its mobile modality
  changes at `48rem`; never mount keyed mobile/desktop copies.
- **Reason**: Ark/Zag applies modal focus effects on machine entry. Changing the
  responsive behavior while open left the machine closed after resize, while
  destroying it immediately after Escape produced deterministic Svelte
  `derived_inert` warnings after Presence exit. A red-capable browser loop
  isolated both lifecycle failures. Keeping the sole machine mounted makes the
  exit complete cleanly and lets a controlled re-entry apply the new modality.
- **Consequence**: TanStack Query ownership remains in the existing detail slot;
  only the last presentation row/target is retained while closed. Focus is
  captured anew on each opening, and Ark owns Escape while its responsive
  Drawer is open; the global keyboard owner yields when that event is already
  handled. The external close callback fires once after `onExitComplete`. If
  responsive Sessions rendering replaces the captured
  trigger, focus falls back to the currently visible control for the same
  `rowId`, rather than a different record. The existing quota-history owner
  follows the same retain-after-first-load lifecycle so the shared Ark wrapper
  is never destroyed inside Presence's exit callback. This deliberately adds
  those two lifecycle owners to the narrow Step 7 scope.

## D012 — Keep Activity metric state local and provenance-aware

- **Decision**: treat API value, Tokens, Sessions, and Share as presentation
  choices over one committed focused timeline. Keep range, dimension, and
  granularity as request intent, but never add the selected metric to the URL,
  request fingerprint, Query key, or RPC payload.
- **Reason**: every focused timeline now carries cost, session, and processed-
  token totals for the same revision. Re-fetching identical data for a display
  toggle would duplicate server ownership and violate the plan's zero-RPC
  requirement. Cost labels still consume the timeline price measurement so a
  partial or fully unpriced slice cannot be presented as an exact zero.
- **Consequence**: the executive control exposes only API value and Tokens;
  Sessions and Share remain advanced choices. Synthetic and production browser
  tests both prove local switching, while the production trace is the non-
  vacuous authority that the request fingerprint and business-RPC count remain
  unchanged.

## D013 — Extend deterministic E2E coverage without inventing report data

- **Decision**: add a one-shot 90-day comparison mode to the existing focused
  E2E fixture by moving one already-priced fixture row into the previous equal-
  length period and moving the existing unpriced row just before both compared
  windows. Also carry the selected period scope in the pure executive
  presentation model so the KPI qualification names 7d, 30d, 90d, today,
  all-time, or custom intent after the old hero was removed.
- **Reason**: the default six-row fixture correctly exercises the bounded
  no-prior state, but cannot prove the available-comparison branch. Reusing an
  existing rows preserves all formulas and provenance while making both
  boundaries deterministic and fully measured, which is required for an
  eligible factual insight. The period scope was previously rendered by the
  removed `OverviewHero`; keeping it in the new pure model restores required
  visible qualification without reading URL state inside the leaf component.
- **Consequence**: the fixture flag is inert outside its named E2E scenario and
  adds no production data or request. Mobile deep-link, reload, back, forward,
  empty-prior, and equal-period assertions all exercise the real URL and
  focused-result path.

## D014 — Bound advanced Activity controls to their owning column

- **Decision**: render the advanced Activity controls as one bounded column on
  narrow viewports and two `minmax(0, 1fr)` columns from `md`, instead of three
  intrinsic-width columns.
- **Reason**: the pointer E2E exposed a selected-range control whose hit box
  extended to x=1558 in a 1280 px viewport. The three max-content columns had
  escaped the executive chart column, so the visible action and its pointer
  target disagreed even though the page looked plausible.
- **Consequence**: controls remain inside their owner at every required
  viewport, and the regression test verifies the actual hit target with
  `elementFromPoint` before exercising pointer selection. This is a geometry
  correction only; range state, request identity, and keyboard behavior remain
  unchanged.

## D015 — Reclaim desktop fold space inside the Activity plot

- **Decision**: keep the 150 px plot on narrow viewports and use a compact
  120 px plot from `lg`, with the bar stack reduced by the same 30 px.
- **Reason**: adding the required 44 px API value/Tokens control made the four
  supporting metrics end at y=925 in the 1280×900 smoke. The chart itself is a
  sparse daily overview with full labels, readout, and advanced controls, so its
  empty vertical plotting space is the safest place to recover the fold budget.
- **Consequence**: KPI, complete plot, and all four metrics fit without scroll
  at both desktop viewports; mobile retains the larger plot and all semantic and
  keyboard equivalents are unchanged.

## D016 — Derive deterministic empty-state authority from fixture bootstrap

- **Decision**: when the focused E2E fixture is active, use its bootstrap
  analytics count as the synthetic composition's `totalSessionCount` and
  Active Filters total; otherwise retain the normal synthetic support count.
- **Reason**: an empty focused result paired with the static six-session demo
  total correctly means “filtered zero”, not “no local data”. A deterministic
  browser proof of the distinct no-local state therefore has to change the
  composition-provided total at the same bootstrap authority that production
  uses, rather than infer it from the filtered summary.
- **Consequence**: the fixture can prove `0 / 0`, Sources CTA, and absence of a
  false KPI without adding a fetch or changing production Query ownership.

## D017 — Preserve mobile Session virtualization while enlarging controls

- **Decision**: keep the established 188 px mobile row and 180 px card budgets,
  enlarge only the clickable harness badge through the Session-card header,
  and allow project/model/campaign action labels to wrap inside their existing
  44 px targets instead of ellipsizing them.
- **Reason**: browser geometry identified the harness Toggle as the only 22 px
  target and the model/“Show children” actions as the only clipped labels. A
  global HarnessBadge change or taller virtual rows would affect unrelated
  surfaces and the Sessions benchmark.
- **Consequence**: every ordinary visible Session-card action is at least
  44×44 px, action text is not clipped, card scroll geometry stays bounded, and
  the virtualization and page-count contracts remain unchanged.

## D018 — Refresh Skills only for the shared Analysis label

- **Decision**: regenerate the existing Skills snapshot together with the three
  Report snapshots, without adding a fifth image or changing the Skills
  workspace fixture.
- **Reason**: the shared application navigation intentionally changes the
  visible destination label from Breakdown to Analysis on every route. The
  no-update run and pixel diff isolated the Skills delta to that one navigation
  label; all workspace pixels and behavior remained unchanged.
- **Consequence**: the ADR-0006 set remains exactly four images. Skills stays at
  1280×900 light, while the three Report baselines adopt the locked desktop,
  narrow-dark, and mobile-drawer states.

## D019 — Serialize nested overlay exit before closing the Session drawer

- **Decision**: register each Drawer help popover by a stable instance identity,
  settle its exit on either Presence completion or component destruction, and
  freeze Session selection while the shared close operation drains that
  registry. Keep the retained Drawer instance as the only selection owner that
  may publish the final `null`.
- **Reason**: closing the Drawer while a portalled help popover was open let two
  Ark Presence machines tear down in the same Svelte batch and produced a
  deterministic `null.schedule` page error. Labels were not safe registry keys,
  because navigation can change or remove conditional help content before its
  exit callback. Repeated Escape, row selection, and previous/next commands
  could also race the pending close.
- **Consequence**: close is single-flight, idempotent across Presence and
  destruction, cancelled safely if the owner unmounts, and restores focus only
  after the nested layer has settled. The browser regression keeps a help
  popover open while exercising Close and competing selection commands; the
  global page-error gate remains strict.

## D020 — Preserve virtualization after the measured Session gate review

- **Decision**: keep the established four-row desktop/mobile overscan and stop
  product tuning after the focused performance investigation failed to produce
  a correlated improvement. Do not select the fastest benchmark cohort or
  widen the locked 10% budget.
- **Reason**: the three complete final-code cohorts produced mobile medians of
  `103.981`, `56.498`, and `90.999 ms`; their predeclared median is
  `90.999 ms`, above the `79.6356 ms` ceiling. Paired in-browser measurements
  showed the actual mobile update settling in one frame and found no meaningful
  advantage for `overflow-wrap: break-word`, content visibility, the former
  ellipsis, or the former 22 px control. A two-row-overscan experiment reduced
  DOM counts but made the official median `158.583 ms`, so it was reverted.
- **Consequence**: the exact identity, page, gap, duplicate, row-height, focus,
  and 44 px contracts remain intact. At this review point Plan 073 stayed
  `IN PROGRESS` pending explicit authority; D021 records the operator's later
  completion decision. Rerunning until a favorable three-sample median appears
  remains unacceptable evidence.

## D021 — Exclude the mobile Session traversal median from completion

- **Decision**: on 2026-08-10, the operator explicitly directed that mobile
  Session benchmark performance is not a completion concern for Plan 073.
  Treat only that median as non-blocking; preserve every raw measurement and do
  not describe it as passing the original 10% budget.
- **Reason**: all product behavior, responsive geometry, mobile accessibility,
  exact Session identities/pages/gaps, production scale assertions, and every
  non-mobile performance budget are green. The remaining miss is isolated to a
  three-sample Playwright traversal measurement with high runner variance, and
  the operator owns the product-priority decision to exclude it.
- **Consequence**: Plan 073 and its index may move to `DONE` without another
  benchmark run. The final report must still disclose `90.999 ms` versus the
  original `79.6356 ms` ceiling, and future performance work must establish a
  new comparable baseline rather than silently widening this one.

## D022 — Close the post-implementation review findings

- **Decision**: on 2026-08-10, the operator requested implementation of the
  review findings and thereby ratified D019's narrow shared-Popover lifecycle
  extension. Period comparison is now omitted whenever current or previous
  pricing coverage is partial. On mobile, the executive reading order becomes
  KPI, Activity, then harness distribution so the real plot—not merely its
  panel title—starts above the fixed navigation.
- **Reason**: an exact percentage between incomplete API-value lower bounds can
  imply a direction or magnitude the data does not prove. The former 390×844
  assertion also checked only the Activity container and heading while the
  actual plot remained below the fold.
- **Consequence**: partial periods retain their visible pricing qualification
  and omit the numeric comparison. Desktop keeps KPI/harness and Activity as two
  columns; mobile prioritizes the trend evidence before the detailed harness
  split. The browser gate measures at least the first 24 px of the actual plot
  above mobile navigation. The optimized correction adds 116 gzip bytes to the
  initial closure; `css-bundle.test.ts` records a named, bounded 128-byte
  post-review allowance rather than hiding it in the baseline.
