# 117 — Work view and read-only review routing simulation

Status: PARTIAL — implemented; browser and full build validation blocked by the environment.
Base: `1db32b86`, 2026-10-21.
Branch: `feat/work-view-routing-simulation`.
Authorization: implementation and isolated verification; supervisor owns local commits.
No real-store migration, harness execution, external publication or account changes.

## Delivery

| Lot | Status | Evidence / remaining work |
| --- | --- | --- |
| L0 | DONE | Clean base, current reader/collector audit, baseline checks and L3 scope in local journal |
| L1 | PARTIAL | Work and explicit Claude spawn lineage implemented and tested; browser/visual validation pending |
| L2 | PARTIAL | Pure routing and UI implemented and tested; browser interaction validation pending; no executor |
| L3 | EXTERNAL WORKER | `feat/retire-session-distillation`; supervisor owns cherry-pick and assembled validation |
| Validation | PARTIAL | Targeted and stored-query tests pass; review corrections verified; verify/build/E2E stop at pre-existing Panda failure |
| Documentation | DONE | This plan, README row, local audit/journal, pending commits and result handoff |

## Scope and decisions

Work reads the existing served usage revision through existing oRPC readers and
TanStack Query policies. Session roots are observed execution groupings, not inferred
business topics. Shared checkout, branch, title or time never merges distinct work.
Native evidence, its observation date and incomplete coverage remain separate from
interpretations. Details and children load on demand; no render recollects history.

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
L3 owns depublication; this plan does not claim that code is already removed.
Native history, accepted Memory, provenance safeguards and
[ADR 0044](../docs/adr/0044-local-checkout-observation.md) Checkout observation remain.
Historical plans and migration history are preserved.

## Verification and handoff

Local execution records live in `.agent-memory/work-loop/` (not tracked):
`L0-audit.md`, `L3-scope.md`, `journal.md`, `PENDING-COMMITS.md` and check logs.
No source reports or professional context are copied into tracked fixtures.

Initial checks: `bun run check`, `bun run lint` pass; targeted quota, Claude parser/
collector, session contract and quota Query suites pass (82 tests, 317 assertions).
Initial `bun run typecheck` fails before edits in Panda with `The service was stopped`;
a standalone esbuild transform reproduces it under Bun 1.4.2. The installed Node
24.21.0 executes the same transform and Panda generation successfully. Offline Nix
cannot reach its daemon in this sandbox. A loopback listen probe fails `EPERM`.
These are recorded separately from mission regressions.

Final `bun run verify`: check and lint pass (1528 files; zero unconsumed design
exports), then typecheck stops at the same Panda failure (47/54 tasks successful).
`bun run build` stops there too (26/29 tasks successful). The integrated gate does
not reach the full test suite; production bundle size is unverified. No budget changed.
Direct Node 24.21.0 Svelte check reports zero errors/warnings; E2E TypeScript passes.
Three assembled test runs pass: foundation/routing/collector/contracts (176 tests,
713 assertions), Session projections/disposable SQLite/Query (92 tests, 637 assertions),
Work/navigation/Query after review fixes (46 tests, 250 assertions; overlaps Query
coverage in the preceding run). Exact commands and logs are in `RESULT.md` locally.
Affected package checks for report-core, local-collectors and CLI pass separately.
The browser command fails preparation before running tests; Playwright lists 29 tests
across the Work/accessibility files. A separate Node loopback probe confirms `EPERM`.
Visual, keyboard and axe results therefore remain unverified. A review scratch script
briefly failed the workspace import lint; moving that disposable script outside the
checkout restored the unmodified checker. All tracked diff checks pass.

Safe opening path: from this worktree use `bun run demo`, then open
`http://127.0.0.1:4176/work`. The existing runner uses a disposable home and synthetic
runtime. Do not use `dev`, `start`, or the engine defaults against personal stores.
Browser verification remains pending; compilation alone is not visual evidence.

## Acceptance coverage and remaining limits

| Mandate case | Evidence level |
| --- | --- |
| 1: explicit PR fulfillment elsewhere | Synthetic projection: exact request link, qualified host/repository/PR and later timestamp; both facts displayed in demo |
| 2: local changes without validation claim | Synthetic projection and demo copy; no live VCS outcome collection added |
| 3: unanswered/dismissed proposal | Synthetic projection; neither state grants authority or invents a reason |
| 4: distinct work on one checkout | Existing exact Session identities; 70-root pagination fixture; qualified PR evidence rejects another host/repository |
| 5: child/review and missing parent | Native-format synthetic JSONL through real collector/cache, lineage normalization and Session projection; cold/warm/removal/conflict tests. Browser expansion authored, not run |
| 6: ineligible routes and missing quota | Pure routing tests with two candidates: forbidden preference/override, stale/missing quota, all forbidden, API billing, duplicates and reset crossing |
| 7: simulation does not execute | Pure module with no I/O; live/demo candidate separation and SSR transport isolation tests. Browser no-POST assertion authored, not run |
| 8: bounded reads and reporting | One 25-root page, lazy children, hydration without reacquisition, retained revision tests, existing disposable SQLite/query regressions. L3 depublication not included |

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

Supervisor handoff: commit the explicit ordered blocks in `PENDING-COMMITS.md`, run
`bun run verify` in the supported environment, then from `apps/web` run
`bun run test:e2e e2e/work.spec.ts e2e/accessibility.spec.ts`. Check desktop/mobile
navigation, keyboard details/source disclosure, retained errors and both routing
choices using `bun run demo`. The bundle budget is unchanged and remains a required
build check. Integrate L3 only on this mission branch and rerun assembled validation;
no commit, publication or L3 integration was performed by this integrator.
