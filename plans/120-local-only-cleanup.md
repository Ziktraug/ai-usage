# 120 — Local-only cleanup: remove the connected platform and dead features, take the upgrade's opportunities

Status: PHASE A MERGED to `main` on 2026-10-25 (#68–#72); PHASE B DONE locally on 2026-10-27 on
`refactor/remove-memory-and-replication` (four commits on `main` `88b45743`, not pushed; ADR 0084).
Baseline: `chore/upgrade-dependencies` at `5b8bc4d4` (plan 119, Bun 1.4.3, Effect 4, SvelteKit 3,
Panda 2, Ultracite 8), not pushed.
Depends on: plan 119. Phase B waits for PR #67 (`feat/work-resume-cockpit`, which carries #66 and
ADR 0049) to land on `main`.
Authorization: local implementation, isolated verification and local commits on stacked branches;
no push, no PR, no real-store upgrade unless the operator asks.
Evidence: dead-feature inventory and critical ADR review of 2026-10-24 (kept as working notes in
`.agent-memory/plan-120-local-only-2026-10-24/`); feature surveys of the upgraded packages.

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

## Phase A outcome (2026-10-24)

Branches, each stacked on the previous one, all local and committed:

| Branch | What it carries |
| --- | --- |
| `chore/upgrade-dependencies` | plan 119, the ADR renumbering to 0070–0073, Panda token pruning that brought the bundle back under its ceiling |
| `refactor/remove-connected-platform` | the platform removal (95 files, 26.9k lines), the restored CLI Ctrl-C test, the pinned single-user decisions, the dead Device enrollment service, docs |
| `feat/upgrade-opportunities` | the web and engine opportunities, agent hooks, the review fixes (SSE restart ride-through, CLI engine process group, loopback bind, focus and forced-colours accessibility, Query guard, token scan) |
| `docs/adr-consolidation` | ADRs 0074–0076, retired and superseded ADRs, index |
| `fix/plan-120-review` | second-round review fixes, the Biome nursery promise and Svelte rules |

Opportunities taken: all of the list above except two, with reasons. Panda source transforms need a
new dependency (`@pandacss/vite`) and would not remove the `css()` runtime because 11 merges stay
dynamic. WebP screenshot baselines need references generated in CI. Measured gains: engine CPU on
cold start 3.3–3.7 s → 2.0 s and warm idle 0.21–0.31 s → 0.08–0.11 s per 10 s (Bun 1.4.3 + Effect 4
against `main`), Codex archive decoding peak 716 → 86 MB, first-load stylesheet 23,768 → 19,082 B
gzip, four package suites about twice as fast with `--parallel`.

Pre-existing defects fixed on the way: the dev engine-restart SSE closure (7 of 20 runs on every
branch), stale locks after a terminal Ctrl-C, the built server binding every interface when started
directly, invisible checkbox focus, focus lost after "Custom", forced-colours selection and focus
indicators, heatmap contrast under forced colours, the Sessions row ring painted over by its last
cell, a production e2e helper race (also on `main`).

Adversarial review: two rounds over every branch; every confirmed finding fixed with a test; no
security-boundary regression found.

Final evidence on the stack tip `47fd690b`, fresh worktree, frozen lockfile install, `nix develop`
(Bun 1.4.3): `verify` with the turbo cache bypassed 3,686 pass / 0 fail, Ultracite 0 diagnostics
over 1,449 files; `test:web-production`, `test:web-dev-build-isolation`, `test:web-bundle`,
`test:web-client-manifest`, the SvelteKit lifecycle test green; `test:e2e` 301, `test:e2e-demo` 2,
`test:e2e-production` 13 + 8 + 32, `test:e2e-memory` 3, `benchmark:session-scroll` 4.

Not done and why:
- Phase B (below) waits for PR #67.
- Keyboard behaviours that match `main` and were left as they are: ticking a filter option closes
  its popover; period presets move focus to the page.
- Forced colours not yet checked on the activity timeline, segment bars, breakdown row bars and model
  swatches; a focused pressed toggle shows only its focus ring in forced colours.
- The 20 Panda overrides that never rendered (plan 119) remain an operator design decision.

## STOP conditions

- Anything that opens or migrates a real local store.
- A deletion that removes a capability the operator kept (Sync/manual transfer, Cursor import,
  project groups and aliases, quota feed, Skills, Sources, Campaigns, MCP `work.context` on #67).
- A phase A change that edits files PR #67 changes heavily (control contract, engine runtime command
  executor, usage store writer, web request policy) beyond a line-level touch.

## Phase B outcome (2026-10-27)

The operator confirmed the scope at the start: decision rows 1 and 5, the usage store dropping its
outbox at schema 5, and the browser-boundary refactor included; the real stores stay untouched.
Recorded by ADR 0084, which retires ADRs 0024, 0026, 0028, 0029, 0038 and 0044.

Branch `refactor/remove-memory-and-replication`, local, on `main` `88b45743`:

| Commit | What it carries |
| --- | --- |
| `18235aa2` | Memory, `/projects`, Checkout observation and replication removed: 11 packages (106 files, 28.5k lines), the engine's Memory service, lease and rendezvous, CLI `memory search` and `replication status`, MCP `memory.*` tools, rail 11 → 9, Sources replication panel, residual Session-distillation lot, control protocol 3 → 4, usage schema 4 → 5 dropping the outbox; docs, CONTEXT.md, ADR headers |
| `76e0c06b` | Review fix: stale-lock recovery reads only the owner of a rendezvous of any protocol, so a crashed protocol-3 engine no longer blocks every start; dead ADR evidence links |
| `d66ba652` | ADR 0076 "Derive once": `rpcProcedure` declarations, request policy and browser GET table derived from the contract, SSR through an in-process router client, subrequest normalization and `handleFetch` deleted; a missed Projects link in a campaign scale test; Linux desktop baselines with the nine-entry rail |
| `e5befd95` | Review fix: the in-process client refuses mutations, so SSR stays read-only |

Whole branch (before this record): 365 files, +4.0k / −45.9k lines. Initial closure 303,572 → 303,126 B gzip after the
removal and the derivation (304,123 B recorded, 305,000 B ceiling).

Not done, and why:
- The real stores were not opened (operator decision). The first engine start with this branch
  migrates the usage store to schema 5 and cannot be undone: back up the usage store and
  `memory.sqlite` as one pair first (`docs/local-store-upgrade.md`, "Usage schema 5").
- The MCP registered server name stays `ai-usage-memory`: renaming it would orphan existing
  operator registrations. The MCP handshake now reports `ai-usage`.
- The darwin visual baselines still show the eleven-entry rail; CI runs Linux only (as for #73).
- The two Linux baselines were regenerated with local Chrome, not taken from a CI artifact; their
  only difference from the old references is the rail.
- The stale branch `feat/retire-session-distillation` (superseded by #67) is left in place.
