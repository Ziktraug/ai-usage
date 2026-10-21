# 118 — Work as a resume space: native outcomes, external facts, qualified routing

Status: IN PROGRESS — integration branch `feat/work-resume-cockpit` on top of PR #66
(`65f7d5c4`), started 2026-10-21 22:05 Europe/Paris. This file is the execution record;
it is updated at each integrated milestone and never rewritten after the fact.
Authorization: local implementation, isolated verification and local commits only.
No push, no merge, no real-store migration, no harness execution, no account change.

## Why this slice exists

Plan 117 delivered an observed Work list and a pure routing simulation. Reviewed at
`d590d803`, `/work` showed a chronological session list with a constant "Known waits
unavailable" line; the real routing path built candidates that were all unqualified; the
request/proposal cases existed only as projection-boundary fixtures. This slice makes a
native source cross the production path to the screen, confronts declarations with
GitHub and local facts, and lets a Claude Code route be qualified from real or
explicitly declared information.

## Lots and ownership

| Lot | Scope | Branch | Status |
| --- | --- | --- | --- |
| Contract | `packages/report-core/src/work-attention.ts`: declarations, facts, interpretations, `WorkAttentionDataset`, row parsers | `feat/work-resume-cockpit` @ `78a11d52` | DONE |
| A | Claude Desktop session registry (`claude-code-sessions/**/local_*.json`) → collector → additive usage-store table → read-only reader → `report-data` read model → `work.attention` oRPC; representative native fixture (≥ 20 roots); chain integration test | `feat/work-resume-cockpit-a-native` | IN PROGRESS |
| B | Bounded engine-side `git status --porcelain=v2` and `gh pr view` observations for known checkouts and explicitly linked PRs; additive tables; pure external-fact interpretations | `feat/work-resume-cockpit-b-facts` | IN PROGRESS |
| C | `/work` recomposed around the dataset: needs-you / waiting-on-others / leads, folded children, search and filters in the URL, detail panel, local-time dates, routing simulation attached to one root | `feat/work-resume-cockpit-c-ui` | IN PROGRESS |
| R | Declared executors (`routing.executors[]`, home-only config), observed executor availability, per-field provenance, qualification actions, real/conditional recommendation | `feat/work-resume-cockpit-r-routing` | IN PROGRESS |
| E | First read-only review attempt launched from the product (Claude Code only, isolated checkout) | — | NOT STARTED (depends on A, C, R) |

## Decisions (short; durable ones get ADRs 0050–0052)

- Native outcome facts live in additive tables under usage schema 4 (table-presence
  migration, skill-observation precedent), outside served revisions, replication and
  export; never in `row_json`.
- Interpretations are computed server-side in `report-data`; the browser renders.
- A Desktop session is a child only through an attested `spawnedFrom`; shared checkout,
  branch, title or time never fold sessions.
- Authorization for routing comes only from a persisted operator declaration; quota and
  executor availability are observations; provenance is kept per field.
- Real quota heads carry no account suffix (`account_scope` NULL), so a declaration binds
  the bare provider stream of its family and machine instead of injecting an account into
  collection.

## Verification record

To be appended per integrated milestone: commit, commands, raw results, what was proven on
synthetic native fixtures, what was tried on isolated real data, what remains unverified.

### 2026-10-21 23:35 — lot C integrated (`9aece9ba`)

Merged `feat/work-resume-cockpit-c-ui` (`937553e6` joins roots to their served Session,
`b37d920c` recomposes `/work`). Verified on the integration branch:
`TZ=UTC bun run --cwd apps/web test` → 1498 pass, 0 fail (241 files). Worker-side evidence at
`b37d920c`: `work.spec.ts` 6/6 on the synthetic dataset (desktop arrival, search, detail, back
keeps filters and focus, keyboard, 390 px drawer, 768/1279 px), accessibility + navigation +
shell e2e 43/43, bundle budget 4/4, svelte-check 0 errors. Not verified: the live
`work.attention` path (contract lands with lot A; `resolveWorkAttentionClient` returns a typed
unavailable client until then), visual-regression suite (no `/work` snapshot exists),
`test:e2e-demo`, `test:web-production`.
