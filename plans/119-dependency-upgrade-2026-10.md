# 119 — Dependency upgrade: Bun 1.4, Effect 4, SvelteKit 3, Panda 2, Ultracite 8

Status: DONE locally on 2026-10-22 in the dedicated worktree
`../ai-usage-dependency-upgrades` (branch `chore/upgrade-dependencies`, uncommitted). Open:
the operator's `nix flake update nixpkgs`, commit/PR, and the CI-only evidence listed under
"Not covered".
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
| D3 | Ultracite | 8.0.1; seven rules off (ADR 0058), the rest fixed | entry names and CLI unchanged; 1,844 new diagnostics, none auto-fixable. Off: `noAwaitInLoops`, `useDestructuring`, `noIncrementDecrement`, `noEqualsToNull`, `noReturnAssign`, `noUnnecessaryConditions` (style churn or behaviour change) and `useErrorCause` (Biome 2.5 only sees `{ cause }` as the second constructor argument; 53 of its 61 hits were correct code). Property-style signatures exposed `unknown` SQLite bindings, now `SqliteQueryBinding` |
| D4 | TypeScript | `typescript` 6.0.3 everywhere (web and fixture leave 5.9.3); TS 7 deferred to 7.1 | TS 7.0 ships no JS API; `svelte-check`, `svelte-kit sync` and `tools/check-typescript-coverage.ts` need it. The dual install svelte-check documents (`@typescript/native@npm:typescript@7`) makes `node_modules/.bin/tsc` depend on link order, which is not a contract. TS 7.0.2 found 0 errors on all 33 projects (7–8× faster), so the move is mechanical once 7.1 ships its API and Svelte content mappers |
| D5 | SvelteKit | 3.1.0 with `@sveltejs/adapter-bun` 1.0.0 (ADR 0057) | the old adapter is Kit-2-only and archived. The new adapter reads no `ORIGIN`; `apps/web/sveltekit-loopback-adapter.ts` binds the request origin to the loopback listener (build fails if the adapter's hand-off module changes shape), so Kit 3's stricter CSRF keeps the ADR 0011 contract. Deprecated `replaceState` kept on purpose (shallow `goto` runs navigation hooks) |
| D6 | Panda CSS | 2.3.0 with `panda lib` + `designSystem`, rendering identical to Panda 1 | v2 drops buildinfo-in-`include` and `panda ship`, sorts atoms and condition groups differently and drops `screen` from breakpoints. Same-property `cx()` compositions became ordered `css()` merges; Panda 1 output is cleaned file by file before codegen; generated breakpoints are re-scoped to `screen` (`packages/design-system/src/screen-breakpoints.ts`) so print keeps the Panda 1 layout |
| D7 | TanStack Table | 9.3.1 | contained to the Sessions table model |
| D8 | Effect | 4.0.5, one atomic bump | GA, LTS to 2029; types cross package boundaries, so no dual-version workspace |
| D9 | better-auth | 1.7.12 + PostgreSQL migration `0011_provider_key_account_identity` | 1.7.3 reverted the account identity to `(providerId, accountId)` and validates the schema; the `issuer NOT NULL` column would reject every insert. The migration relaxes `issuer`, keys on `(provider_id, account_id)` and refuses with `IA003` on duplicates; the schema check is carried through the repo's adapter wrappers (it was silently skipped) and a missing check fails construction |
| D10 | MCP SDK | 1.32.1 (v1), not v2 | v2.3.1 accepts the same five protocol versions, but changes what clients see: every `inputSchema` moves from draft-07 to draft 2020-12, `execution.taskSupport` disappears from `tools/list`, validation error text changes; the Claude Agent SDK peers on v1 anyway. On 1.32.1 the stdio answers and `tools/list` are byte-identical to 1.30.0 |
| D11 | drizzle-orm | 0.45.4 | 1.0 is still a release candidate |
| D12 | GitHub Actions | `checkout@v7`, `upload-artifact@v7`, `setup-bun@v2`, `install-nix-action@v31` | Node 24 runtimes; only `pull_request`/`workflow_dispatch` triggers |
| D13 | Claude Agent SDK | 0.3.308; quota read passes `{ skipBehaviors: true }` | the usage call now scans local transcripts by default |

Everything else moves to its latest release within its major: svelte 5.57.2, vite 8.3.5,
vite-plugin-svelte 7.3.1, svelte-check 4.7.7, Ark UI 5.24.3, svelte-query 6.3.5, oRPC
1.16.0 (all four in lockstep), valibot 1.5.0, Playwright 1.64.1, axe-core/playwright
4.14.0, pg 8.23.1, zod 4.6.7, turbo 2.11.10 (first to read Bun lockfile v2), lefthook
2.2.2, lint-staged 17.5.1 (17.6.0 would stage peer sessions' edits; ADR 0055), nixpkgs
(postgresql 17.11, biome 2.5.15).

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
9. **Ultracite 8** — repo-wide rule count, fix the rules that find defects, record any
   rule turned off with its reason.
10. **Final** — full gates, e2e variants, adversarial review, plan status.

## Outcome

All batches applied; batches 4 (Panda 2) and 9 (Ultracite 8) also ran in detached worktrees
and were merged. Final evidence, on a fresh worktree from `origin/main` plus the full diff
with a frozen lockfile install, under `nix develop` with Bun 1.4.3:

- `bun run verify` with the turbo cache bypassed (`TURBO_FORCE=true`, 0 cached): 3,916 pass /
  0 fail, Ultracite 0 diagnostics, typecheck 58/58, build 31/31.
- `test:postgres` 72 / 0; `test:local-platform`, `test:setup-loopback`,
  `test:web-client-manifest`, `test:web-bundle`, `test:web-production`,
  `test:web-dev-build-isolation`, the SvelteKit runtime lifecycle test: green.
- Browser: `test:e2e` 246 passed (no retry), `test:e2e-demo` 2, `test:e2e-production`
  13 + 8 + 31, `test:e2e-memory` 3, `benchmark:session-scroll` 4.
- Ten isolated `bun run dev` cold starts on Bun 1.4.3 reached Vite ready (4.7–5.7 s); the
  1.4.0 `turbo watch dev` hang does not reproduce.
- Initial gzip closure 304,465 B (recorded value moved, 305,000 B ceiling unchanged).

Adversarial review: four parallel reviews (Effect, SvelteKit/origin, auth/toolchain/lint,
Panda/web) found no security-boundary regression, and a second round on the fixes found two
low findings, also fixed; every confirmed finding was fixed with a test, among them a `replaceState` loop on a missing skill, Kit 3 CSRF 403s on bodyless
mutations (perf benchmark, `localhost` tabs), Back/Forward focus no longer resetting, the
schema-check carry failing open, Panda 2 breakpoints applying in print, and a latent
abandoned-transport leak in the wide-event sink. A production e2e flake seen during final
verification was proven pre-existing on `main` (1/10, same signature; a timing
perturbation reproduces it) and fixed in the e2e helper.

Behaviour changes kept on purpose:
- Effect 4 delivers typed errors to the engine's command coordinator (Effect 3 wrapped them
  in `FiberFailure`, so its classification was dead code): an invalid-JSON merge now reports
  `merge-invalid-json` (HTTP 400), a stale selection `command-rejected`, and a
  fatal-consistency failure degrades the engine; `engine check` reports the store's real
  reason (ADR 0056).
- Accessible names follow axe 4.14 `label-content-name-mismatch`: content-named campaign,
  timeline and round buttons; "Collection status: …", "Filter by …: …".
- Panda 2: when hover and focus-visible set the same property, focus-visible wins.

## Follow-ups (not done here)

- Operator: `nix flake update nixpkgs` in the worktree (agents are blocked from it), then
  check `nix develop -c bun --version` = 1.4.3 and PostgreSQL 17.11; delete the flake's bun
  override once NixOS/nixpkgs#574334 lands.
- Twenty authored overrides never rendered under Panda 1 and were removed to keep rendering
  identical (e.g. danger/ok banner backgrounds, warning/danger pills, warning notes, the
  active navigation weight 550, stale quota muting). Applying the original intent is a
  design decision. Paths are under `apps/web/src/lib/features/` unless stated:

  | Original location | Property | Authored | Rendered (kept) |
  | --- | --- | --- | --- |
  | shell/app-navigation.svelte (`navigationLinkActive`) | fontWeight | 550 | 450 |
  | shell/provider-quota-rail.svelte (`providerValueStale`) | color | muted | ink |
  | report/actions/report-sharing-actions.svelte (`errorNoticeText`) | color | status.danger | muted |
  | report/overview/executive-overview.svelte (`emptyState`) | gap | 8px | 16px, 20px from md |
  | sessions/detail/rounds-reader.svelte (`noteWarning`) | color | status.warn | muted |
  | sessions/detail/session-analysis.svelte (`warningNotice`) | bg | status.warnSoft | accentTint |
  | skills/editor/discard-confirmation-dialog.svelte | bg / color | status.dangerSoft / status.danger | ink / canvas |
  | skills/management/styles.ts (`warningPill`) | bg / color | status.warnSoft / status.warn | surfaceMuted / muted |
  | skills/management/styles.ts (`dangerPill`) | bg / color | status.dangerSoft / status.danger | surfaceMuted / muted |
  | skills/management/styles.ts (`errorNotice`) | bg | status.dangerSoft | accentTint |
  | skills/management/skills-health-slot.svelte (`planSkippedList`) | color | muted | ink |
  | skills/observations/skill-observations.svelte (`stack`) | gap | 12px | 14px |
  | skills/observations/skill-observations.svelte (meta over panelSub) | fontSize | 13px | 12px |
  | sources/source-control-summary.svelte (`activeDot`) | bg | accent | status.ok |
  | sources/styles.ts (`bannerError`) | bg | status.dangerSoft | surface |
  | sync/manual-transfer.svelte (`errorPanel`) | bg | status.dangerSoft | surface |
  | design-system `components/status.ts` (`bannerError`) | bg | status.dangerSoft | surface |
  | design-system `components/status.ts` (`bannerOk`) | bg | status.okSoft | surface |
  | `routes/skills/+layout.svelte` (`primaryHeaderButton` hover) | borderColor | inkHover | accent |
  | shell/error-shell.svelte (`statusPanel`) | gap | 12px | 14px |
- Bundle headroom is 535 B under the 305,000 B ceiling (SvelteKit 3 runtime + Panda 2).
- TypeScript 7.1 (API + Svelte content mappers), Biome 2.6 once Ultracite ships a matching
  preset, MCP SDK v2 when clients are ready for draft 2020-12 schemas, drizzle-orm 1.0 at GA.
- Web project-group save maps the engine's new `command-rejected` to "temporarily
  unavailable"; a conflict-style message would surface the engine's "reload" hint.
- `turbo watch dev` stopped with SIGTERM to its process group orphans the detached engine
  (also on 1.3.13; Ctrl-C is clean).

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
