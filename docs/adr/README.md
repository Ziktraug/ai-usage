# Architecture Decision Records

One decision per file, numbered in acceptance order. A superseded ADR is never
deleted or rewritten beyond its status header; the superseding record names the
exact clauses it replaces.

On 2026-08-25 two number collisions were resolved: the direct-Rhythm ADR
(formerly 0009) became 0013 and the effect-runtime ADR (formerly 0002) became
0014. Historical plans reference the old numbers; each renumbered file carries
a **Formerly** note.

| ADR | Decision | Date | Status |
| --- | --- | --- | --- |
| [0001](0001-boundary-scoped-observability-on-bounded-workers.md) | Bounded workers; observability isolated per execution | 2026-07-21 | Accepted, amended by 0009 |
| [0002](0002-immutable-focused-report-revisions.md) | Read immutable focused report revisions | 2026-07-22 | Accepted, amended by 0009 |
| [0003](0003-isolated-synthetic-runtime.md) | Isolate the synthetic (demo) runtime | 2026-07-22 | Accepted |
| [0004](0004-bounded-continuous-session-scrolling.md) | Page data and window continuous session scrolling | 2026-07-22 | Accepted; paging ownership moved to Query by 0012 |
| [0005](0005-compact-accessible-visualizations.md) | Compact visuals with equivalent controls | 2026-07-22 | Accepted, partially superseded by 0013 |
| [0006](0006-one-browser-regression-stack.md) | One browser regression stack (Playwright) | 2026-07-22 | Accepted |
| [0007](0007-server-render-report-bootstrap.md) | Server-render the report bootstrap and initial destination | 2026-07-22 | Accepted, amended 2026-08-08 and by 0009 |
| [0008](0008-wide-event-presentation-provenance-and-delivery.md) | Wide-event presentation, provenance, delivery diagnostics | 2026-07-22 | Accepted; supersedes clauses of 0014 |
| [0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md) | Sole-writer usage engine, direct SQLite readers | 2026-07-31 | Accepted; amends 0001, 0002, 0007, 0008, 0014 |
| [0010](0010-sveltekit-contract-first-browser-boundary.md) | SvelteKit with a contract-first oRPC browser boundary | 2026-08-02 | Accepted, superseded in part by 0012 |
| [0011](0011-sveltekit-bun-runtime.md) | Run SvelteKit with svelte-adapter-bun | 2026-08-09 | Accepted |
| [0012](0012-tanstack-query-browser-server-state-ownership.md) | TanStack Query owns browser server state | 2026-08-08 | Accepted; supersedes lifecycle clauses of 0010 |
| [0013](0013-direct-rhythm-day-controls.md) | Direct Rhythm day controls | 2026-08-01 | Accepted (formerly 0009); supersedes a clause of 0005 |
| [0014](0014-effect-runtime-package-for-wide-events.md) | `@ai-usage/effect-runtime` owns wide-event primitives | 2026-07-21 | Accepted (formerly 0002); amended by 0008 and 0009 |
| [0015](0015-api-value-is-a-legibility-proxy.md) | The API value is a legibility proxy, not a money claim | 2026-08-25 | Accepted |
| [0016](0016-collect-everything-present-faithfully.md) | Collect everything, present partial data faithfully | 2026-08-25 | Accepted |
| [0017](0017-absence-is-a-gap-not-a-category.md) | Absence is a gap, not a category; defaults never hide it | 2026-08-25 | Accepted |
| [0018](0018-one-canonical-number-per-concept.md) | One canonical number per concept | 2026-08-25 | Accepted |
| [0019](0019-inclusive-period-semantics-and-readable-range-urls.md) | Inclusive period semantics and readable range URLs | 2026-08-25 | Accepted |
| [0020](0020-bundle-ceiling-and-drift-guard.md) | Bundle ceiling and drift guard, no per-feature ledger | 2026-08-25 | Accepted |
| [0021](0021-design-system-promotion-policy.md) | Design-system promotion requires a second consumer | 2026-08-25 | Accepted |
| [0022](0022-skill-observation-tiers-and-observability.md) | Skill observations carry a tier; an unobservable harness is never a zero | 2026-08-28 | Accepted |

ADRs 0015–0021 were recorded on 2026-08-25 by extracting standing decisions
from executed plans (048/049, 053, 064, 088, 089), merged PRs (#41), and the
product guardrails in `docs/future-work.md`. Their **Date** is the recording
date; each names its original decision context.

## Writing a new ADR

Take the next free number. Use the shared header — title `# ADR NNNN: …`, then
a bold list with **Status** and **Date**, plus **Amends**/**Supersedes**/
**Amended by** when relationships exist. Keep Context/Decision/Consequences
short, name one rejected alternative, and link Evidence to living code or
plans. Update the table above in the same change.
