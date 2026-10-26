# Architecture Decision Records

One decision per file, numbered in acceptance order. A superseded ADR is never
deleted or rewritten beyond its status header; the superseding record names the
exact clauses it replaces.

`Accepted` means the architecture decision is settled. It does not mean the
corresponding runtime implementation is available on `main`; implementation
status is tracked independently in [`plans/README.md`](../../plans/README.md).

On 2026-08-25 two number collisions were resolved: the direct-Rhythm ADR
(formerly 0009) became 0013 and the effect-runtime ADR (formerly 0002) became
0014. Historical plans reference the old numbers; each renumbered file carries
a **Formerly** note.

ADR 0022 belongs to the concurrent Skill observation decision work. The
platform series therefore begins at 0023, preserving both accepted decisions
without a numbering collision.

ADR 0047 belongs to the concurrent Codex compressed-rollout discovery work. The
publication settle window therefore takes 0048.

ADRs 0049–0069 are left to the concurrent work-resume and work-continuity
branches, which held 0049–0062 on 2026-10-24. The dependency upgrade of plan 119
therefore takes 0070–0073, and the follow-up local-only programme starts at 0074.
References to ADRs 0049–0059 in this table and in the records mean those on
`feat/work-resume-cockpit`, which land with PR #67.

On 2026-10-24 the set was reviewed critically for plan 120. A record is
**Superseded** when a newer ADR replaces it, **Retired** when its rule no
longer earns a place and nothing replaces it (the file's header says why), and
**amended** when a clause changes in a dated note. Three records now carry one
current statement for a topic and point at their predecessors: 0013 (compact
visual accessibility), 0014 (wide events) and 0076 (browser boundary). No file
was deleted.

| ADR | Decision | Date | Status |
| --- | --- | --- | --- |
| [0001](0001-boundary-scoped-observability-on-bounded-workers.md) | Bounded workers; observability isolated per execution | 2026-07-21 | Accepted, amended by 0009 and 0071; wide-event rules consolidated in 0014 |
| [0002](0002-immutable-focused-report-revisions.md) | Read immutable focused report revisions | 2026-07-22 | Accepted, amended by 0009 |
| [0003](0003-isolated-synthetic-runtime.md) | Isolate the synthetic (demo) runtime | 2026-07-22 | Accepted, amended 2026-10-24 (unavailable capabilities) |
| [0004](0004-bounded-continuous-session-scrolling.md) | Page data and window continuous session scrolling | 2026-07-22 | Accepted; amended by 0039; paging ownership in 0076 (formerly 0012) |
| [0005](0005-compact-accessible-visualizations.md) | Compact visuals with equivalent controls | 2026-07-22 | Superseded by 0013 (consolidated 2026-10-24) |
| [0006](0006-one-browser-regression-stack.md) | One browser regression stack (Playwright) | 2026-07-22 | Accepted, amended 2026-10-24 (design-system fixture exception) |
| [0007](0007-server-render-report-bootstrap.md) | Server-render the report bootstrap and initial destination | 2026-07-22 | Accepted, amended 2026-08-08, 2026-10-24 and by 0009 and 0076 |
| [0008](0008-wide-event-presentation-provenance-and-delivery.md) | Wide-event presentation, provenance, delivery diagnostics | 2026-07-22 | Accepted; supersedes clauses of 0014; consolidated in 0014's current statement |
| [0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md) | Sole-writer usage engine, direct SQLite readers | 2026-07-31 | Accepted; amends 0001, 0002, 0007, 0008, 0014; amended by 0024 and 2026-10-24; extended by 0075 |
| [0010](0010-sveltekit-contract-first-browser-boundary.md) | SvelteKit with a contract-first oRPC browser boundary | 2026-08-02 | Superseded by 0076 (2026-10-24) |
| [0011](0011-sveltekit-bun-runtime.md) | Run SvelteKit with svelte-adapter-bun | 2026-08-09 | Superseded by 0072 (2026-10-24) |
| [0012](0012-tanstack-query-browser-server-state-ownership.md) | TanStack Query owns browser server state | 2026-08-08 | Superseded by 0076 (2026-10-24) |
| [0013](0013-direct-rhythm-day-controls.md) | Direct Rhythm day controls and compact-visual accessibility | 2026-08-01 | Accepted (formerly 0009); supersedes 0005 |
| [0014](0014-effect-runtime-package-for-wide-events.md) | `@ai-usage/effect-runtime` owns wide-event primitives | 2026-07-21 | Accepted (formerly 0002); amended by 0008 and 0009; holds the consolidated wide-event statement |
| [0015](0015-api-value-is-a-legibility-proxy.md) | The API value is a legibility proxy, not a money claim | 2026-08-25 | Accepted |
| [0016](0016-collect-everything-present-faithfully.md) | Collect everything, present partial data faithfully | 2026-08-25 | Accepted |
| [0017](0017-absence-is-a-gap-not-a-category.md) | Absence is a gap, not a category; defaults never hide it | 2026-08-25 | Accepted |
| [0018](0018-one-canonical-number-per-concept.md) | One canonical number per concept | 2026-08-25 | Accepted |
| [0019](0019-inclusive-period-semantics-and-readable-range-urls.md) | Inclusive period semantics and readable range URLs | 2026-08-25 | Accepted |
| [0020](0020-bundle-ceiling-and-drift-guard.md) | Bundle ceiling and drift guard, no per-feature ledger | 2026-08-25 | Accepted, amended 2026-10-24 (305,000 B ceiling, headroom expectation) |
| [0021](0021-design-system-promotion-policy.md) | Design-system promotion requires a second consumer | 2026-08-25 | Retired 2026-10-24 |
| [0022](0022-skill-observation-tiers-and-observability.md) | Skill observations carry a tier; an unobservable harness is never a zero | 2026-08-28 | Accepted; amended by 0037 |
| [0023](0023-one-product-local-and-shared-compositions.md) | One product with local and shared compositions | 2026-08-29 | Superseded by 0074 |
| [0024](0024-separate-usage-memory-and-shared-data-authorities.md) | Separate usage, Memory, and shared data authorities | 2026-08-29 | Accepted; amends 0009; amended by 0074; retires with Memory (plan 120 phase B) |
| [0025](0025-trusted-capabilities-before-public-plugins.md) | Trusted capabilities before public plugins | 2026-08-29 | Retired 2026-10-24; guardrail carried by 0074 |
| [0026](0026-db-native-agent-memory-with-file-adapters.md) | DB-native Agent Memory with file adapters | 2026-08-29 | Accepted; amended by 0074; retires with Memory (plan 120 phase B) |
| [0027](0027-mcp-is-an-edge-adapter.md) | MCP is an edge adapter | 2026-08-29 | Accepted; amended by 0074 |
| [0028](0028-stable-project-identity-and-repository-locators.md) | Stable Project identity and Repository locators | 2026-08-29 | Accepted; amended by 0074; retires with Memory and `/projects` (plan 120 phase B) |
| [0029](0029-application-owned-authorizer.md) | Application-owned Authorizer | 2026-08-29 | Accepted; amended by 0074; retires with Memory (plan 120 phase B) |
| [0030](0030-postgresql-domain-authorization-before-openfga.md) | PostgreSQL domain authorization before OpenFGA | 2026-08-29 | Superseded by 0074 |
| [0031](0031-outbound-only-device-replication.md) | Outbound-only Device replication | 2026-08-29 | Superseded by 0074; code removed in plan 120 phase B |
| [0032](0032-work-handoffs-before-native-session-conversion.md) | Work handoffs before native session conversion | 2026-08-29 | Retired 2026-10-24 (never built); guardrail carried by 0074 |
| [0033](0033-separate-person-auth-scm-and-device-identities.md) | Separate Person, authentication, SCM, and Device identities | 2026-08-29 | Superseded by 0074 |
| [0034](0034-authorize-complete-search-scope-before-ranking.md) | Authorize the complete search scope before ranking | 2026-08-29 | Superseded by 0074; local ordering rule carried by 0029 |
| [0035](0035-opt-in-normalized-session-archives.md) | Opt-in normalized session archives with envelope encryption | 2026-08-29 | Superseded by 0074 (never implemented) |
| [0036](0036-github-authentication-and-hmac-device-credentials.md) | GitHub authentication and HMAC Device credentials | 2026-08-29 | Superseded by 0074 |
| [0037](0037-current-producers-and-durable-skill-invocations.md) | Absence proof requires current producers and durable skill invocations | 2026-08-31 | Accepted; amends 0012 (carried by 0076) and 0022 |
| [0038](0038-local-memory-store-writer-lease-and-startup-coupling.md) | Local Memory store writer lease and fail-closed startup coupling | 2026-09-07 | Accepted; extends 0009 and 0024; amended by 0074; retires with Memory (plan 120 phase B) |
| [0039](0039-continuous-campaign-exploration.md) | Preserve context during continuous campaign exploration | 2026-10-04 | Accepted; amends 0004 and 0012; amended by 0041 |
| [0040](0040-rounds-are-derived-once-from-native-turns.md) | Rounds are derived once from native turns; child links carry their evidence | 2026-09-09 | Accepted; applies 0017 and 0018 to session detail |
| [0041](0041-exact-detail-selection-with-continuous-exploration.md) | Resolve exact detail identity independently from bounded scroll restoration | 2026-10-04 | Accepted; amends 0039 |
| [0042](0042-local-session-distillation.md) | Keep generated session accounts local and distinct from accepted Memory | 2026-10-04 | Accepted; feature superseded by 0049; preservation rule in 0075 |
| [0043](0043-memory-library-and-explicit-local-promotion.md) | Browse Session accounts and explicitly promote local knowledge | 2026-10-06 | Accepted; feature superseded by 0049; publication restrictions remain; preservation rule in 0075 |
| [0044](0044-local-checkout-observation.md) | Observe local Checkouts and bind them to Projects without review | 2026-10-07 | Accepted; amends 0024, 0042; amended 2026-10-24; Memory-kernel half retires in plan 120 phase B |
| [0045](0045-desktop-quota-feed-through-the-cli.md) | Desktop consumers read quota through the CLI JSON feed | 2026-10-12 | Accepted; extends 0009 |
| [0046](0046-hourly-fleet-freshness-heartbeat.md) | Row freshness heartbeats are recorded at hour granularity | 2026-10-17 | Accepted; extends 0009 |
| [0047](0047-codex-compressed-rollout-discovery.md) | Discover Codex rollouts in their compressed and archived forms | 2026-10-17 | Accepted; extends 0009, 0016; amended 2026-10-24 |
| [0048](0048-publication-settle-window.md) | Source-woken publications settle behind the collection burst | 2026-10-20 | Accepted; extends 0009 |
| [0049](0049-retire-session-distillation.md) | Retire Session distillation while preserving Memory and stored evidence | 2026-10-21 | Accepted; supersedes feature clauses of 0042 and 0043; preserves 0044 |
| [0050](0050-work-attention-facts-outside-the-served-revision.md) | Work attention facts stay outside the served revision | 2026-10-21 | Accepted; extends 0009, 0016, 0017; amended by 0056 |
| [0051](0051-engine-read-only-github-and-checkout-observation.md) | Engine-side read-only GitHub and checkout status observation | 2026-10-21 | Accepted; extends 0009, 0044; amended 2026-10-25 by 0077 (stderr classification) |
| [0052](0052-review-routing-qualification.md) | Review routing qualification: declared executors, observed availability, observed quota | 2026-10-21 | Accepted; extends 0009, 0016, 0017, 0045 |
| [0053](0053-first-read-only-review-attempt-launched-by-the-engine.md) | First read-only review attempt launched by the engine | 2026-10-22 | Accepted; extends 0009, 0050, 0052; amended by 0055 |
| [0054](0054-jira-issue-facts-explicit-keys-read-only.md) | Jira issue facts: explicit keys only, read through the operator's CLI session, never written | 2026-10-22 | Accepted; extends 0009, 0050, 0051 |
| [0055](0055-review-attempt-reservation-scope-and-harness-guarantee.md) | Review attempt reservation, reviewed scope and harness guarantee | 2026-10-22 | Accepted; amends 0053 |
| [0056](0056-native-records-may-settle-a-derived-wait.md) | A dated native record may settle a derived wait; an inference may not | 2026-10-22 | Accepted; amends 0050 |
| [0057](0057-observed-account-identity-and-on-demand-routing-qualification.md) | Observed account identity, models of one account, on-demand routing qualification | 2026-10-22 | Accepted; extends 0009, 0052, 0053 |
| [0058](0058-harness-sessions-read-work-context-through-one-bounded-projection.md) | Harness sessions read Work context through one bounded, read-only projection (CLI and local MCP) | 2026-10-22 | Accepted; extends 0009, 0027, 0050, 0056 |
| [0059](0059-work-roots-for-harnesses-that-declare-no-wait.md) | Work shows sessions of a harness that declares no wait, with their attention not observable | 2026-10-22 | Accepted; extends 0016, 0050, 0056 |
| [0060](0060-attribute-work-responses-to-their-requests.md) | Attribute Work responses to their requests | 2026-10-22 | Accepted; amends 0056 |
| [0061](0061-local-codex-request-observations.md) | Keep native Codex request observations local and attributable | 2026-10-22 | Accepted; amends 0059; extends 0050, 0060 |
| [0062](0062-owned-codex-review-through-app-server.md) | Run owned Codex reviews through the subscription app-server | 2026-10-22 | Accepted; amends 0053, 0055; extends 0057 |
| [0063](0063-durable-work-threads-and-personal-follow-up.md) | Durable Work threads carry the operator's follow-up | 2026-10-24 | Accepted; extends 0050, 0051, 0054 |
| [0070](0070-bun-1-4-runtime.md) | Run on the Bun 1.4 line, pinned once in `packageManager` | 2026-10-22 | Accepted; extends 0011; amended 2026-10-24 |
| [0071](0071-effect-4.md) | Run every Effect surface on Effect 4 | 2026-10-22 | Accepted; amends 0001; amended 2026-10-24 |
| [0072](0072-sveltekit-3-official-bun-adapter.md) | Run SvelteKit 3 on the official `@sveltejs/adapter-bun` | 2026-10-22 | Accepted; amends 0011; amended 2026-10-24 |
| [0073](0073-ultracite-8-rule-policy.md) | Ultracite 8 rule policy: rules that churn style, misread the code or change behaviour stay off | 2026-10-22 | Accepted, amended 2026-10-24 (platform-only text removed; nursery promise and Svelte rules on) |
| [0074](0074-local-only-single-operator-product.md) | Local-only, single-operator product; manual transfer bundles are the only cross-machine path | 2026-10-24 | Accepted; supersedes 0023, 0030, 0031, 0033–0036; amends 0024, 0026–0029, 0038 |
| [0075](0075-local-store-schema-evolution.md) | Local store schema evolution: forward-only, additive where possible, widen-only reads | 2026-10-24 | Accepted; extends 0009; amended 2026-10-25 (nullable columns) |
| [0076](0076-browser-boundary-orpc-contract-and-tanstack-query.md) | Browser boundary: oRPC contract + TanStack Query, derived once | 2026-10-24 | Accepted; supersedes 0010 and 0012 |
| [0077](0077-delegation-independent-of-the-calling-harness.md) | Delegation owned by AI Usage, independent of the calling harness (read-only reviews, Claude Code and Codex executors) | 2026-10-25 | Accepted; extends 0009, 0052, 0053, 0055, 0057, 0058, 0074, 0075; amends 0051 (stderr classification) |

ADRs 0015–0021 were recorded on 2026-08-25 by extracting standing decisions
from executed plans (048/049, 053, 064, 088, 089), merged PRs (#41), and the
product guardrails in `docs/future-work.md`. Their **Date** is the recording
date; each names its original decision context.

## Writing a new ADR

Take the next free number. Use the shared header — title `# ADR NNNN: …`, then
a bold list with **Status** and **Date**, plus **Amends**/**Supersedes**/
**Amended by**/**Superseded by** when relationships exist. Keep Context/Decision/Consequences
short, name one rejected alternative, and link Evidence to living code or
plans. Update the table above in the same change.
