# Plan 070 — Retire Completed Web Migration Guardrails and Clarify Lasting Safety Gates

**Status:** DONE
**Priority:** P1
**Effort:** M
**Risk:** MED
**Planned against:** `f5b26a95` (2026-08-08)
**Depends on:** Plan 068 migration integrated; Plan 069 browser-state ownership integrated

## Outcome

Remove the temporary machinery that proved the Solid/TanStack Start to SvelteKit
migration, without weakening the permanent browser/server, request-security, demo
isolation, or SSR secret boundaries.

After this cleanup:

- no source, CI job, package script, or active documentation scans for Solid,
  TanStack Start/Router, Nitro, TSX, `createServerFn`, or migration evidence;
- the parity ledger and its commit/evidence bookkeeping are gone;
- request-policy coverage derives from the live oRPC/request-routing boundary;
- the client-manifest gate only rejects capabilities that must never enter the
  browser bundle;
- “privacy” coverage is named precisely as demo isolation and SSR secret sentinels;
- historical ADRs/plans retain the migration record without imposing maintenance.

## Why now

The migration has landed, and Plan 069's TanStack Query/oRPC ownership work is
committed at this baseline. These are acceptance scaffolds, not lasting architecture:

- `apps/web/migration-parity/**` records one-time statuses, evidence and commit SHAs;
- `tools/check-web-migration-parity.ts` validates that historical record;
- `tools/check-web-retired-stack.ts` searches continuously for removed technology;
- `tools/check-web-client-manifest.ts` duplicates parts of that retired-stack list.

The lasting boundary is capability based: browser code must not import server,
SQLite, process, filesystem, Bun/Node, or `@orpc/server` capabilities. Private and
mutating endpoints must retain trusted-local, demo, CSRF and size policies.

## What “confidentiality” currently means

There is no broad confidentiality test. There are two useful, narrow contracts:

1. `apps/web/e2e/demo-privacy.spec.ts` proves **demo isolation**. It renders synthetic
   data, emits no report-management request, returns `404` for local
   control/RPC/manual-merge endpoints, and redirects management pages. This prevents
   demo mode from reaching real local data or control capabilities.
2. `apps/web/e2e/production-report.spec.ts` proves **SSR secret minimization** for four
   sentinels: a private prompt body, credential-bearing remote, dangerous URL and
   provider stderr must not enter initial HTML.

The second contract does not prohibit useful bounded report/query data in the initial
SSR payload. Keep both behaviours and rename/document them accordingly.

## Scope

### Delete

- `apps/web/migration-parity/**`
- `tools/check-web-migration-parity.ts` and its test
- `tools/check-web-retired-stack.ts` and its test

### Change

- `package.json`, `apps/web/package.json`, `.github/workflows/pr-checks.yml`
- `tools/check-typescript-coverage.ts` and its test
- `tools/check-web-client-manifest.ts` and its test
- `apps/web/src/lib/server/rpc/request-policy.test.ts`
- if a live typed seam must be exposed: `request-policy.ts`,
  `request-policy-handler.ts`, and focused `packages/web-contract` contract tests
- rename `apps/web/e2e/demo-privacy.spec.ts` to `demo-isolation.spec.ts`
- current README, integration, ADR and performance-baseline guidance
- Plan 068/069 reconciliation notes and `plans/README.md`

### Out of scope

- data-loading, TanStack Query cache policy, SSR payload size and navigation;
- sidebar, presentation, routes and runtime response semantics;
- trusted-local/demo/CSRF/size/error/manual-merge protections;
- the generic client/server capability checker;
- rewriting historical performance results;
- concurrent provider-quota/local-collector worktree changes.

## Ownership after cleanup

| Concern | Owner | Permanent gate |
| --- | --- | --- |
| Browser server state | TanStack Query + oRPC Query utilities | Plan 069 query/unit/E2E tests |
| Route/request policy | live oRPC path and policy mapping | request-policy unit tests |
| Browser capability boundary | client-manifest checker | source and emitted-build checks |
| Demo isolation | synthetic runtime + route policy | renamed demo-isolation E2E |
| Initial HTML secrets | production SSR boundary | four explicit sentinels |
| Migration evidence | historical ADRs/plans | no executable gate |

Do not replace the ledger with another test-only inventory. A durable test must read
the current production contract, path map, or policy table.

## Implementation gates

### Gate 0 — Baseline and drift

1. Record `git status --short` and preserve all unrelated dirty paths.
2. Run focused request-policy, client-manifest, type-coverage, demo and production SSR
   tests before deletion.
3. Confirm the known suite failure in this area is the parity inventory demanding new
   evidence. Stop for any other focused regression.
4. Compare in-scope drift against `f5b26a95`. Reconcile it without absorbing sidebar,
   presentation, provider or collector work.

### Gate 1 — Decouple request security from migration history

`request-policy.test.ts` currently imports parity types/shards to construct a frozen
operation list. Remove that dependency before deleting the ledger.

1. Consume the production policy/path seam used by `request-policy-handler.ts`.
   Export the smallest typed view needed.
2. Assert set equality between all live RPC paths, the explicit manual-merge file
   operation, and all request-policy entries. Missing/extra entries must fail by name.
3. Preserve transport, trusted-local, demo denial, CSRF, request-size, public-error
   and manual-merge assertions.
4. Add focused contract composition coverage only if needed. Do not introspect
   undocumented oRPC internals or duplicate statuses, evidence SHAs, Playwright
   titles or migration targets.
5. Run:

   ```sh
   bun test apps/web/src/lib/server/rpc/request-policy.test.ts
   bun test packages/web-contract/src/contract.test.ts
   ```

**STOP:** do not delete the ledger while security coverage still reads it or can
silently omit a live route.

### Gate 2 — Delete parity infrastructure

1. Delete the parity directory and checker/test.
2. Remove `test:web-migration-parity` from scripts and CI.
3. Remove migration-parity exports from `apps/web/package.json`.
4. Remove its supplemental TypeScript coverage prefix and dedicated expectation.
5. Rename migration-era CI wording such as “Static, Types, Parity.”
6. Remove active executable references; historical prose may remain with a retirement
   note.

**Gate:** changing a Playwright title must no longer require an evidence commit.

### Gate 3 — Delete retired-stack policing, retain capability boundaries

1. Delete the retired-stack checker/test, lint invocation, build script and CI step.
2. Remove client-manifest rules/tests specific to Solid, TanStack Start/Router,
   Nitro/nitropack/nitro-loopback, TSX, `createServerFn`, `_serverFn`, `warmup` and
   `NITRO_`.
3. Keep client-manifest rejection of Node/Bun built-ins, `@orpc/server`,
   `$lib/server`, `.server` modules, and private/server workspace packages.
4. Keep `test:web-client-manifest` locally and in CI, including emitted-build checks.

**STOP:** do not weaken protection against filesystem/process, SQLite or private
server code entering a browser entry.

### Gate 4 — Clarify isolation and SSR intent

1. Rename the demo spec and test titles to “synthetic demo isolation.”
2. Preserve no-business-request assertions, endpoint `404`s and management redirects.
3. Keep and label the four production sentinels as the “initial HTML secret
   boundary.”
4. Document explicitly that bounded report/query data is allowed in initial HTML.
5. Keep demo denial and trusted-local validation for every private operation.

### Gate 5 — Reconcile documentation and plan state

1. Replace live parity/retired-stack instructions in root/web READMEs and the
   breakdown integration guide with permanent gates.
2. In ADR 0010 and the migration performance baseline, preserve the historical role
   of the ledger/scanner, mark them retired, and remove broken live instructions.
3. Add retirement notes to Plans 068/069 without rewriting their history.
4. Mark Plan 069 DONE only when its own final gates and this cleanup pass. Do not mark
   Plan 068 DONE merely because migration scaffolding was removed; its reopened
   presentation acceptance remains separate.

### Gate 6 — Validate

```sh
bun test apps/web/src/lib/server/rpc/request-policy.test.ts
bun test packages/web-contract/src/contract.test.ts
bun test tools/check-web-client-manifest.test.ts tools/check-typescript-coverage.test.ts
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:web-client-manifest
bun run test:e2e-demo
bun run test:e2e-production
bun run test:e2e
git diff --check
```

Also verify:

- scripts/CI have no parity or retired-stack command;
- active source/config has no `migration-parity` import;
- active checkers have no Solid/Start/Nitro/TSX migration blocklist;
- generic browser/server capability checks remain;
- omitting a live RPC policy still fails;
- demo cannot reach real local state;
- useful initial report data is allowed while the four secrets stay out of SSR HTML.

## Done when

- all listed migration-only files and executable references are gone;
- permanent safety tests have live production owners, not historical evidence;
- the full validation matrix is green;
- documentation distinguishes migration history from current safety boundaries;
- no unrelated sidebar, presentation, provider or collector changes are included;
- each remaining gate's name explains its purpose without migration context.

## Implementation record

- 2026-08-08 — Deleted the complete migration-parity ledger/checker and the
  retired Solid/TanStack Start/Nitro scanner, including scripts, CI steps,
  package exports and supplemental typecheck plumbing.
- 2026-08-08 — Request-policy coverage now reads the live RPC path map. The
  permanent client-manifest gate retains only capability-based server/browser
  exclusions.
- 2026-08-08 — Renamed the demo browser gate to synthetic demo isolation and
  named the production SSR boundary as four explicit secret sentinels. Useful
  bounded report/query data remains intentionally allowed in initial HTML.
- 2026-08-08 — Green scoped gates: lint; Web typecheck; tools TypeScript check;
  Web production build; client manifest; 118/118 tool tests; all package tests;
  focused request-policy tests; demo isolation 1/1; production SSR/report 10/11,
  including the initial HTML secret boundary. Repository-wide typecheck/build
  remain blocked by the concurrent `apps/cli/src/app.ts` use of a nonexistent
  `CliSourceExecutionOutcome.id`. The remaining production failure expects seven
  provider sources after concurrent provider work introduced an eighth; the
  ordinary browser suite is 110/112 with two aborted route-data requests in
  concurrent sidebar/history scenarios. None is in Plan 070's changed surface.
- 2026-08-09 — Second-review scope audit traced the Anthropic collector and
  multi-provider quota expansion to mixed commit `373544f6`. Plan 021 authorizes
  Codex quota history only; the earlier provider research describes Claude as a
  future feature-flagged experiment, but the implementation was enabled by
  auto-detection without that flag. The collector, dependency, source-control
  entry, quota model/UI expansion, CLI multi-provider behavior, and related tests
  were therefore removed from this branch. They are not Plan 070 work and Plan 070
  makes no ownership claim over them.
