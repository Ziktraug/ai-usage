# 117 — Work view and read-only review routing simulation

Status: PARTIAL — assembled gates passed outside the sandbox; fix batch 2 corrects
mobile navigation geometry, with browser verification and visual refresh pending.
Base: `1db32b86`, 2026-10-21.
Assembled checkpoint: `2bdabfe8` (L3, fix batch 1 and visual references committed by supervisor).
Branch: `feat/work-view-routing-simulation`.
Authorization: implementation and isolated verification; supervisor owns local commits.
No real-store migration, harness execution, external publication or account changes.

## Delivery

| Lot | Status | Evidence / remaining work |
| --- | --- | --- |
| L0 | DONE | Clean base, current reader/collector audit, baseline checks and L3 scope in local journal |
| L1 | PARTIAL | Work browser flow and fix-batch-1 regressions pass; mobile navigation geometry correction awaits browser verification |
| L2 | DONE | Pure routing tests and both preference choices pass in the supervisor's demo walkthrough; no executor |
| L3 | DONE | `0e914ce3`, `97deefce`, `b63d6f2f`; retained Memory/detail and accessibility suites pass outside the sandbox |
| Validation | PARTIAL | Assembled verify, full E2E, demo, bundle and production gates pass at checkpoint; navigation correction needs new browser and visual checks |
| Documentation | DONE | This plan, README row, local audit/journal, pending commits and result handoff |

## Scope and decisions

Work reads the existing served usage revision through existing oRPC readers and
TanStack Query policies. Session roots are observed execution groupings, not inferred
business topics. Shared checkout, branch, title or time never merges distinct work.
Native evidence, its observation date and incomplete coverage remain separate from
interpretations. Details and children load on demand; no render recollects history.

Mobile navigation keeps Work, Overview, Sessions and Analysis primary; Campaigns joins the existing Manage overflow, including in demo while business destinations remain hidden.

The one collection enrichment uses Claude's explicit spawn declarations to resolve a
missing child parent. Messages to an existing agent do not prove parentage. Ambiguous
or conflicting parents remain visible; a cache hit must preserve the same evidence.
No database schema change or second scanner is needed.

Routing simulates a read-only review linked to a selected Session. It checks target
authorization, verified subscription path, declared capability/quality, availability
and fresh quota before preferences. Claude Code preference is configurable; eligible
Codex can win by the explicit policy. Different offers' percentages are not compared.
Reference time and policy are inputs; reset proximity never grants permission.
Missing identities or qualification cannot be invented from session activity.
Real quota heads deliberately leave permission, subscription access, availability and
review capability unqualified: live mode can inspect them but cannot choose a route
from those observations alone. No configuration pretends to observe missing facts.
The reset preference orders eligible candidates by earliest future reset within the
declared horizon, then harness preference, then stable identity; there are no weights.
Routing does not estimate review cost or promise that remaining capacity is sufficient.

## Superseded direction

This delivery expands [plan 045](045-valorize-the-report-dimensions.md), decision 9's
Report/Manage navigation, with a first-class Work destination. It supersedes
[plan 108](108-cross-harness-handoffs-work-threads.md)'s "Product value and phase
order" only insofar as the first Work workflow required an accepted handoff:
observing native Sessions and simulating assignment now comes first. Durable Work
threads, handoffs, semantic grouping and native conversion remain unimplemented.
[ADR 0032](../docs/adr/0032-work-handoffs-before-native-session-conversion.md)'s
handoff-before-native-conversion constraint and evidence protections are preserved;
existing Campaign/Session identities retain their meaning.

The mission retires the generated-account product direction in
[ADR 0042](../docs/adr/0042-local-session-distillation.md) and the generated-account
library/promotion clauses of [ADR 0043](../docs/adr/0043-memory-library-and-explicit-local-promotion.md).
L3 depublication is integrated at `b63d6f2f`; its durable boundary is
[ADR 0049](../docs/adr/0049-retire-session-distillation.md).
Native history, accepted Memory, provenance safeguards and
[ADR 0044](../docs/adr/0044-local-checkout-observation.md) Checkout observation remain.
Historical plans and migration history are preserved.

## Verification and handoff

Local execution records live in `.agent-memory/work-loop/` (not tracked):
`L0-audit.md`, `L3-scope.md`, `journal.md`, `PENDING-COMMITS.md` and check logs.
No source reports or professional context are copied into tracked fixtures.

Initial checks: `bun run check`, `bun run lint` pass; targeted quota, Claude parser/
collector, session contract and quota Query suites pass (82 tests, 317 assertions).
Initial `bun run typecheck` fails inside the sandbox before edits in Panda with `The service was stopped`;
a standalone esbuild transform reproduces it under Bun 1.4.2. The installed Node
24.21.0 executes the same transform and Panda generation successfully. Offline Nix
cannot reach its daemon in this sandbox. A loopback listen probe fails `EPERM`.
The supervisor subsequently proved that Panda and typecheck pass outside the sandbox:
the service failure is a sandbox artifact, not a repository baseline defect. Full
typecheck and E2E are recorded as not run (sandbox) for the resumed batch.

Initial-delivery sandbox `bun run verify`: check and lint pass (1528 files; zero unconsumed design
exports), then typecheck stops at the same Panda failure (47/54 tasks successful).
`bun run build` stops there too (26/29 tasks successful). The integrated gate does
not reach the full test suite; production bundle size is unverified. No budget changed.
Direct Node 24.21.0 Svelte check reports zero errors/warnings; E2E TypeScript passes.
Three assembled test runs pass: foundation/routing/collector/contracts (176 tests,
713 assertions), Session projections/disposable SQLite/Query (92 tests, 637 assertions),
Work/navigation/Query after review fixes (46 tests, 250 assertions; overlaps Query
coverage in the preceding run). Exact commands and logs are in `RESULT-initial-loop.md` locally.
Affected package checks for report-core, local-collectors and CLI pass separately.
The browser command fails preparation before running tests; Playwright lists 29 tests
across the Work/accessibility files. A separate Node loopback probe confirms `EPERM`.
That initial run provided no visual, keyboard or axe evidence. A review scratch script
briefly failed the workspace import lint; moving that disposable script outside the
checkout restored the unmodified checker. All tracked diff checks pass.

Safe opening path: from this worktree use `bun run demo`, then open
`http://127.0.0.1:4176/work`. The existing runner uses a disposable home and synthetic
runtime. Do not use `dev`, `start`, or the engine defaults against personal stores.
Supervisor validation at `b63d6f2f`: `bun run typecheck` passes (58/58 tasks).
`bun run verify` reaches web tests and fails the ownership boundary at
`server-state-ownership.test.ts:59`: three imperative SSR reads and two pagination
calls in Work are outside Query ownership. Work/accessibility E2E has 27 passes and
two deterministic failures (mobile child disclosure and the retired Memory landing
heading). Memory/session-detail-stability/session-anchor E2E has 8 passes. These are
outside-sandbox observations from the supervisor's assembled gate logs, not claims
that the integrator executed a browser. Build/bundle validation remains pending.

## Acceptance coverage and remaining limits

| Mandate case | Evidence level |
| --- | --- |
| 1: explicit PR fulfillment elsewhere | Synthetic projection: exact request link, qualified host/repository/PR and later timestamp; both facts displayed in demo |
| 2: local changes without validation claim | Synthetic projection and demo copy; no live VCS outcome collection added |
| 3: unanswered/dismissed proposal | Synthetic projection; neither state grants authority or invents a reason |
| 4: distinct work on one checkout | Existing exact Session identities; 70-root pagination fixture; qualified PR evidence rejects another host/repository |
| 5: child/review and missing parent | Native-format synthetic JSONL collector/cache and projection coverage; five actual Svelte-render cases expose unavailable parent evidence. Native pre-hydration disclosure browser regression passes outside the sandbox |
| 6: ineligible routes and missing quota | Pure routing tests with two candidates: forbidden preference/override, stale/missing quota, all forbidden, API billing, duplicates and reset crossing |
| 7: simulation does not execute | Pure module with no I/O; live/demo separation and SSR transport isolation tests. Desktop no-POST browser assertion passes outside sandbox |
| 8: bounded reads and reporting | One 25-root page, lazy children, hydration/retained revision and disposable SQLite/query tests. L3 integrated; retained Memory/detail browser suites pass outside sandbox |

The new lineage case does not prove a complete collector → persisted store → browser
journey; its final projection boundary is explicit. Existing SQLite reader tests use
disposable fixtures. No live-store compatibility or upgrade claim follows from them.
Known waits, PR outcomes and native proposals remain unavailable in real mode.
Demo examples never populate real candidates or data; detail links use existing demo
Session identities. The existing detail drawer belongs to Report and closes there.
No paid API, real subscription qualification, live Mac collection, GitHub/Jira mutation
or real review run is part of this delivery.

Independent adversarial review found two defects: direct SSR errors bypassed the
Work unavailable state, and an aggregate activity timestamp was attributed to the
root Session. Both were corrected and independently rechecked; focused regressions
cover expired/failed reads, transport failure and later child activity. Concerns about
demo qualification leaking into live mode, preference bypass, duplicated quotas,
SendMessage parentage, recollection and checkout-based merging were rejected against
the implementation and tests. Review evidence is in the local journal directory.

Fix batch 1 follows the supervisor's assembled gate and separate review. Imperative
Work reads now live in Query prefetch/options modules; pagination uses the existing
Query action, with no ownership-guard or frozen-allowlist changes. The mobile trace
showed a native disclosure opened before hydration, whose toggle was missed by the
component. Work now reconciles `details.open` on mount; the E2E regression holds real
application scripts until after the keyboard gesture, then requires child links to
appear without another gesture. A delegated singleton with no parent identifier now
renders an explicit unavailable relation without restoring a stale identifier.
Memory's axe test targets Knowledge by default and still covers Pending review and
return to Knowledge. The test sweep found no other stale positive UI expectation;
retirement/provenance assertions and native Session analysis tests remain intentional.

Local fix-batch results: 57 Work/ownership/Query/navigation tests (293 assertions),
14 Query integration tests (105 assertions), 22 retained L3 contract/policy/URL tests
(791 assertions), and 17 Memory render/handler tests (158 assertions) pass. Some
Query/Memory coverage overlaps between runs. `bun run check` and `bun run lint` pass
on 1500 files; direct Node Svelte check has zero errors/warnings and E2E TypeScript
passes. Independent different-model review reports no actionable findings, with 49
Work/Query tests and 8 Memory tests passing. Full typecheck/build and runtime E2E are
not run (sandbox) for this diff. The earlier outside 58-task typecheck is checkpoint
evidence, not validation of this fix batch. Exact commands and test-reference audit
are in the local `RESULT-fix-batch-1.md` and `fix-batch-1-*.md` handoffs.

The supervisor subsequently committed fix batch 1 as `06bf8d86`, `75246dd0` and
`c18aaedb`, then refreshed four visual references in `2bdabfe8`. Outside the sandbox,
`bun run verify` passes at `c18aaedb`; after the visual refresh full `test:e2e`
passes 236/236, `test:e2e-demo` passes 2/2, and `test:web-bundle` and
`test:web-production` pass under `nix develop`. The demo Work walkthrough passes
list, source limits, related sessions, both routing preferences and detail opening.
These results are supervisor-provided checkpoint evidence, not checks executed by
the integrator or proof of the following navigation correction.

Fix batch 2 addresses a confirmed visual regression missed by those gates: six mobile
slots join adjacent labels at 390px. The accepted narrow reference is not evidence of
legibility. Campaigns moves to the existing overflow, keeping five primary slots;
the 56px icon rail also needs 44px navigation targets in the 768–1279px band.
Browser geometry assertions must check text containment and adjacent rectangles at
320/375/390px, in addition to document overflow. PNG updates and browser execution
remain the supervisor's responsibility; the integrator does not change references.

Local fix-batch-2 checks pass: 15 navigation/ownership tests (71 assertions),
`bun run check` and `bun run lint` (1501 files), direct Node Svelte check (zero
errors/warnings) and E2E TypeScript. Playwright discovery lists 43 tests across
navigation-layout/accessibility/svelte-shell and three demo tests; none ran here.
The new regressions measure rendered text against its target and label container,
adjacent label/target intersections, 44px targets, rail focus/hover labels, and
Campaigns overflow navigation with preserved filters and demo isolation.
The rail keeps its 56px width and existing tooltips; smaller noninteractive spacing
compensates for taller targets when the live quota panel is visible. Its fit with
quotas at 844px high is derived from declared dimensions, not browser proof; the
normal E2E fixture has no quota panel. Wide desktop sizing remains unchanged.
Independent adversarial review confirmed that height risk and verified the 38px
spacing correction; no confirmed defect remains. Its separate navigation/ownership
run passes 21 tests (84 assertions). The initial 900px overflow concern was withdrawn
after correcting its arithmetic; actual painted geometry remains browser-pending.

Supervisor handoff from repo root, with system Chrome configured:
`bun run --cwd apps/web test:e2e e2e/navigation-layout.spec.ts e2e/accessibility.spec.ts e2e/svelte-shell.spec.ts e2e/work.spec.ts --workers=1 --retries=0`,
then `bun run --cwd apps/web test:e2e-demo --workers=1 --retries=0`.
Regenerate and inspect affected narrow references outside the sandbox using
`bun run --cwd apps/web test:e2e e2e/visual-regression.spec.ts --grep 'initial narrow dark Overview|mobile light session drawer' --update-snapshots --workers=1 --retries=0`,
then run `bun run --cwd apps/web test:e2e e2e/visual-regression.spec.ts --workers=1 --retries=0`.
Check the 768–1279px rail with a visible quota panel at 844px high as well. Commit
the explicit new blocks in the local ledger; the supervisor owns git writes and
visual acceptance. No PNG, budget, store or routing-policy change belongs to this batch.
