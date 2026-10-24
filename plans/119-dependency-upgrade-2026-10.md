# 119 — Dependency upgrade: Bun 1.4, Effect 4, SvelteKit 3, Panda 2, Ultracite 8

Status: IN PROGRESS, started 2026-10-22 in the dedicated worktree
`../ai-usage-dependency-upgrades` (branch `chore/upgrade-dependencies`).
Baseline: `main` at `3fde5ae6`, 2026-10-22. `bun run verify` green on Bun 1.3.13 under
`nix develop` (3,840 tests pass, 0 fail; Ultracite checks 1,510 files).
Depends on: nothing. Independent of the in-flight work-resume cockpit branches, which own
ADR numbers 0049–0054; this plan's ADRs start at 0055.
Authorization: local implementation and isolated verification in the dedicated worktree;
no real-store upgrade, commit, push or PR unless the operator asks.
Evidence: research reports and probes in the session scratchpad (2026-10-22); the facts
below cite primary sources (release notes, migration guides, registry metadata) and were
re-checked against the installed packages.

## Why

The last broad upgrade predates several majors. Bun's 1.4 line is the Rust port
(1.4.0 stable 2026-08-20, 1.4.3 on 2026-10-10). Effect 4.0 went GA on 2026-10-01.
SvelteKit 3 shipped, and the community `svelte-adapter-bun` this app runs on is now
deprecated and archived in favour of the official `@sveltejs/adapter-bun`, which needs
SvelteKit 3 and Bun ≥ 1.4. TypeScript 7 (native) is GA, Panda CSS 2 and Ultracite 8 are
out, and better-auth patches since 1.7.2 include security fixes.

## Decisions

| # | Area | Decision | Reason |
| --- | --- | --- | --- |
| D1 | Bun | 1.4.3, `packageManager` is the only version source (CI `setup-bun` reads it); `flake.nix` overrides nixpkgs' 1.4.2 until NixOS/nixpkgs#574334 lands | first Rust-ported line; 1.4.3 fixes spawn/pipe hangs, zstd, mimalloc RSS and a TLS CVE |
| D2 | Biome | 2.5.15, **not** 2.6.x | Biome 2.6 renamed `useSortedClasses`; both Ultracite 7.8.3 and 8.0.1 presets still set it, so every Biome 2.6 command fails on configuration. Revisit when Ultracite ships a 2.6 preset |
| D3 | Ultracite | 8.0.1 | entry names and CLI unchanged; ~45 new error rules, none auto-fixable. Rule policy decided in batch 9 from a repo-wide count |
| D4 | TypeScript | `typescript` 6.0.3 everywhere (web and fixture leave 5.9.3); TS 7.0.2 added as `@typescript/native` for plain `tsc` checks | TS 7.0 ships no JS API; `svelte-check`, `svelte-kit sync` and `tools/check-typescript-coverage.ts` need it. The dual install is svelte-check's documented layout. TS 7 found 0 errors on all 33 projects |
| D5 | SvelteKit | 3.1.0 with `@sveltejs/adapter-bun` 1.0.0 | the old adapter is Kit-2-only and archived. The origin/idle-timeout contract of ADR 0011 changes and gets a new ADR |
| D6 | Panda CSS | 2.3.0 with `panda lib` + `designSystem` | v2 drops buildinfo-in-`include` and `panda ship` |
| D7 | TanStack Table | 9.3.1 | contained to the Sessions table model |
| D8 | Effect | 4.0.5, one atomic bump | GA, LTS to 2029; types cross package boundaries, so no dual-version workspace |
| D9 | better-auth | 1.7.12 + a PostgreSQL migration | 1.7.3 reverted the account identity to `(providerId, accountId)` and validates the schema at startup; the `issuer NOT NULL` column would reject every insert |
| D10 | MCP SDK | v2 (`@modelcontextprotocol/server`/`client`) if it still negotiates the protocol versions current clients use; otherwise 1.32.1 | v1 only gets fixes for ≥ 6 months |
| D11 | drizzle-orm | 0.45.4 | 1.0 is still a release candidate |
| D12 | GitHub Actions | `checkout@v7`, `upload-artifact@v7`, `setup-bun@v2`, `install-nix-action@v31` | Node 24 runtimes; only `pull_request`/`workflow_dispatch` triggers |
| D13 | Claude Agent SDK | 0.3.308; quota read passes `{ skipBehaviors: true }` | the usage call now scans local transcripts by default |

Everything else moves to its latest release within its major: svelte 5.57.2, vite 8.3.5,
vite-plugin-svelte 7.3.1, svelte-check 4.7.7, Ark UI 5.24.3, svelte-query 6.3.5, oRPC
1.16.0 (all four in lockstep), valibot 1.5.0, Playwright 1.64.1, axe-core/playwright
4.14.0, pg 8.23.1, zod 4.6.7, turbo 2.11.10 (first to read Bun lockfile v2), lefthook
2.2.2, lint-staged 17.6.0, nixpkgs (postgresql 17.11, biome 2.5.15).

## Batches

Each batch ends with its own gates and a cumulative diff snapshot so the branch can be
split into one commit per batch. Batches 6, 7 and 8 touch disjoint packages and run in
parallel in detached worktrees beside the repository (`../ai-usage-effect4-upgrade`,
`../ai-usage-upgrade-auth`, `../ai-usage-upgrade-mcp`) from the same baseline; their
diffs are applied to the upgrade worktree and re-verified there on Bun 1.4.3.

1. **Runtime and toolchain** — Bun 1.4.3, turbo, lefthook, lint-staged, Actions, flake;
   comments that call 1.3.13 "the pinned Bun" become measurements; ADR 0055. Gates:
   `verify`, production/lifecycle smokes, `test:local-platform`, `test:postgres`, e2e and
   demo e2e, ten isolated `bun run dev` cold starts (the 1.4.0 hang topology).
2. **In-major bumps** — the web, test and Agent SDK entries of the list above, Biome
   2.5.15 formatting, `typescript` 6.0.3 in web and fixture, missing declared
   dependencies in `apps/web` (`@orpc/contract`, `valibot`), Agent SDK `skipBehaviors`.
   Effect, better-auth/drizzle/pg and MCP/zod move in their own batches. Gates:
   `verify`, e2e (Chromium 156 and axe 4.14 may move screenshots and accessibility
   results).
3. **SvelteKit 3 + official Bun adapter** — config into `sveltekit({...})`, `$lib` →
   `#lib`, `$app/environment` → `$app/env`, `goto` `reset`/`replace`,
   `@sveltejs/kit/hooks` types, tsconfig `extends: "$app/tsconfig"`, generated build
   paths in bundle tests, `CONNECTION_IDLE_TIMEOUT`, the origin contract (no `ORIGIN`
   env; CSRF self-origin), fixture re-pin, ADR superseding the adapter part of 0011.
4. **Panda 2** — presets explicit, `panda lib` + `designSystem`, CLI flags, `.js` export,
   media-query pattern in the bundle test, bundle budget re-measured.
5. **TanStack Table 9** — `constructTable` + `tableFeatures`, generics.
6. **Effect 4** — in a separate worktree in parallel with batches 3–5, dependency order
   effect-runtime → usage-store → local-machine → local-collectors → report-data,
   usage-merge → usage-engine-runtime → apps → tools. Structural points: services
   (`Context.Service`), `FiberRef` → `Context.Reference`, `Either` → `Result`,
   `TestContext` → `TestClock.layer()`, the best-effort wide-event sink without
   `Effect.disconnect`, no `FiberFailure` at `runPromise` boundaries, `Fiber.interrupt`
   now waits, `yieldNow` is a value, scheduler yields through `setImmediate`.
7. **better-auth 1.7.12** — migration, mapping, adapter filter, tests (`test:postgres`).
8. **MCP SDK** — v2 or 1.32.1 per D10.
9. **TypeScript 7 binary, then Ultracite 8** — repo-wide rule count, fix the rules that
   find defects, record any rule turned off with its reason.
10. **Final** — full gates, e2e variants, adversarial review, plan status.

## STOP conditions

- Any gate needs a real local store, real history or a real home directory.
- Batch 1 reproduces the dev-server hang under `turbo watch dev` in ≥ 2 of 10 starts:
  stop the Bun bump and every batch that needs Bun ≥ 1.4 (3, and D5's adapter).
- The new adapter cannot keep the loopback trust boundary (trusted-local hook, CSRF on
  mutating requests, SSE lifetime, `Request.signal`, process exit) proven by
  `tools/check-sveltekit-runtime-lifecycle.ts` and the production smoke.
- Effect 4 changes observable engine behaviour that tests cannot pin down (scan cadence,
  interruption, shutdown): stop and report rather than adjusting expectations.

## Not covered

- CI-only evidence: the Linux screenshot references come from CI artifacts, and the
  dev-server stress workflow runs on runners. Both need a pushed branch.
- Opening the real stores with the upgraded code: none of these batches changes a local
  SQLite schema; the operator's next real start still follows
  `docs/local-store-upgrade.md`.
