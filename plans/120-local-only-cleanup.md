# 120 — Local-only cleanup: remove the connected platform and dead features, take the upgrade's opportunities

Status: IN PROGRESS, started 2026-10-24.
Baseline: `chore/upgrade-dependencies` at `5b8bc4d4` (plan 119, Bun 1.4.3, Effect 4, SvelteKit 3,
Panda 2, Ultracite 8), not pushed.
Depends on: plan 119. Phase B waits for PR #67 (`feat/work-resume-cockpit`, which carries #66 and
ADR 0049) to land on `main`.
Authorization: local implementation, isolated verification and local commits on stacked branches;
no push, no PR, no real-store upgrade unless the operator asks.
Evidence: dead-feature inventory and critical ADR review of 2026-10-24 (session scratchpad
`dead-feature-inventory.md`, `adr-critical-review.md`); feature surveys of the upgraded packages.

## Operator decisions (2026-10-24)

| # | Area | Decision |
| --- | --- | --- |
| 0 | Connected platform (`apps/server`, PostgreSQL, GitHub login via better-auth, Device enrollment, outbound replication) | Delete |
| 1 | Accepted Memory (`/memory`, `memory search`, MCP memory tools, Memory store) and the `/projects` checkout resolution review | Delete (phase B). Session grouping is unaffected: it comes from the report projection (`packages/report-data/src/project-projection.ts`: linked worktrees under their parent repository, project aliases, project groups edited in Analysis) and never reads the Memory store |
| 2 | Sync / manual transfer (`/sync`, `snapshot`, `merge`, `machine`, `cursor import`) | Keep |
| 3 | CLI `setup` loopback UI | Delete |
| 4 | One-off performance tooling | Clean up: delete plan 072 tooling and the dev-server stress workflow; keep `tools/measure-*` (used for the 2026-10 scan work) and `docs/performance/*.md` |
| 5 | Replication outbox tables in the local stores | Delete (phase B, store schema change with backup) |
| 6 | Work that overlaps PR #67 | Not now: replication strip, Memory removal and the table drop wait for #67 |
| 7 | Plan-like docs at the root of `docs/` (`project-grouping-plan.md`, `provider-status-windows-plan.md`, `skills-management-spec.md`, `app-audit-2026-07-10.md`, `model-pricing-audit-2026-07-15.md`) | Delete (git keeps them) |

The operator also asked to take every opportunity found in the upgraded packages' release notes and
to treat ADRs critically: an ADR that no longer earns its place is retired, merged or rewritten.

## Phase A — now, on stacked branches

1. `refactor/remove-connected-platform`: delete `apps/server`, `packages/postgres-store`,
   `packages/project-application`, the PostgreSQL tools and tests, the local-platform independence
   check, both CI jobs, `postgresql_17` in the flake, the platform scripts and dependencies; strip
   better-auth from `packages/identity` (its Device token and credential modules stay until phase B,
   because the dormant replication client still imports them) and the organization half of
   `packages/authorization`; delete CLI `setup`, the plan 072 tooling, the dev-server stress
   workflow and the plan-like docs.
2. `feat/upgrade-opportunities`: every opportunity from the surveys that does not touch phase B code
   (list below).
3. `docs/adr-consolidation`: the critical ADR review applied to the text — retire or supersede the
   platform ADRs, merge duplicates, fix stale statements, write the missing ADRs (local-only product,
   store schema evolution).

## Phase B — after PR #67 lands

- Remove replication end to end: engine runtime, usage store and Memory store writers, the
  `replication-status` command (control protocol v4), CLI `replication status`, the Sources
  replication panel and RPC, `packages/replication-*`, what remains of `packages/identity`.
- Drop the usage store's outbox tables (usage schema v5) following `docs/local-store-upgrade.md`:
  backup, row counts on a copy, forward-only migration, disposable-store tests.
- Remove accepted Memory and `/projects`: memory-service, memory-sqlite, memory-search, the Memory
  listener and lease (ADR 0038), MCP memory tools (MCP stays for `work.context`), checkout
  observation, `project-registry`, the authorization package if nothing else needs it.
- Browser boundary (critical review): derive the request policy and HTTP method from the oRPC
  contract instead of registering each procedure in several places, and serve SSR through an
  in-process router client instead of forged `/rpc` subrequests.

## Opportunities (phase A)

Panda 2 unused-token/keyframe removal; streamed zstd decoding of Codex archives on Bun 1.4.3
(re-qualified with the 40-run parallel stress); Bun `--no-orphans` for engine children; Ultracite
`fix --hook` in the agent hooks; TanStack Query `query()`/`infiniteQuery()` with the ADR guard
updated and the swallowed `prefetchQuery` error fixed; `bun:sqlite` query-cache sizing measured on
the usage store; Playwright `forcedColors`/`contrast` accessibility runs and `locator.visible()`;
adapter-bun `envPrefix`; Claude Agent SDK `startup_failure_reason` and CLI version on the wide event;
Biome `noFloatingPromises`/`noMisusedPromises` and the Svelte nursery guards; Kit 3 `snapshot()`;
Svelte `createContext`; MCP `maxToolInputElements`; turbo cache limits; TanStack Table 9 unregistered
features; ES2025 lib (`Map.getOrInsertComputed`, `RegExp.escape`); Bun test-runner parallelism where
tests allow it; runtime measurements on Bun 1.4.3 + Effect 4 recorded in ADRs 0070/0071.
Panda source transforms and WebP screenshot baselines need a spike or CI-generated references and
are decided inside the batch.

## STOP conditions

- Anything that opens or migrates a real local store.
- A deletion that removes a capability the operator kept (Sync/manual transfer, Cursor import,
  project groups and aliases, quota feed, Skills, Sources, Campaigns, MCP `work.context` on #67).
- A phase A change that edits files PR #67 changes heavily (control contract, engine runtime command
  executor, usage store writer, web request policy) beyond a line-level touch.
