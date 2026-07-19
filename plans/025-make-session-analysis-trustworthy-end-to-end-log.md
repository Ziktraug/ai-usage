# Plan 025 Execution Log

- Starting commit: `cb9bc22`
- Started: 2026-07-19
- Drift check: clean for all scoped implementation files

| Lot | Status | Commit | Verification |
| --- | --- | --- | --- |
| A — Fixtures and vertical golden | DONE | uncommitted | PASS — 9 tests; golden repeated twice |
| B — Shared projection facts | DONE | uncommitted | PASS — 58 tests |
| C — Exact-revision contract | DONE | uncommitted | PASS — 33 focused tests; full checks green |
| D — Target and UI presentation | DONE | uncommitted | PASS — 54 tests |
| E — Integration, docs, and gates | DONE | uncommitted | PASS — all final gates |

## Baseline

- Command: `bun test packages/report-core/src/session-detail.test.ts packages/local-collectors/src/codex-history.test.ts packages/local-collectors/src/opencode-history.test.ts packages/local-collectors/src/db-collectors.test.ts packages/report-data/src/source-adapters.test.ts packages/report-data/src/session-query-runner.test.ts apps/web/src/session-analysis.test.ts apps/web/src/session-detail-client.test.ts apps/web/src/server/session-detail.server.test.ts`
- Duration: 4.04s
- Result: PASS — 77 tests, 0 failures

## Golden differences

- Lot A: no semantic divergence. JavaScript represented one expected cost as
  `0.00024555000000000003`; floating costs are asserted with `toBeCloseTo`
  while tokens, models, and quality flags remain literal.

## Lot A

- Commands: focused fixture, real SQLite collector, and vertical pipeline test
  commands from the plan; the fixture + golden command passed twice.
- Result: PASS — 9 combined tests, 0 failures; targeted Ultracite and
  `git diff --check` clean.
- Note: repository typecheck reached the web tail without diagnostics and all
  child processes exited, but the PTY did not return an exit code. This will be
  rerun during final gates.

## Lot B

- Commands: focused report-core, Codex, OpenCode, real database, and Lot A
  regression tests.
- Result: PASS — 58 tests, 0 failures, 418 assertions; targeted Ultracite and
  diff checks clean.
- Cache: `OPENCODE_DB_CACHE_VERSION` remains 7 because the real database parity
  test and vertical golden are unchanged.
- Note: the characterization test was finalized alongside extraction rather
  than preserved as a separately committed pre-extraction state. The completed
  interface characterization remains in the suite.

## Lot C

- Result: PASS — core 10 tests, runner/SQLite 16 tests, server/client 7 tests,
  and dedicated web revision-runner coverage; combined focused run 33 tests.
- Gates: `bun run check`, `bun run lint`, and `bun run typecheck` exit 0;
  `git diff --check` clean.
- Contract: browser request is `{ revision, rowId }`; exact-revision anchor,
  strict fingerprint/result parsing, lease expiry, `QueryFailed`, provenance,
  and comparison mappings are directly tested.

## Lot D

- Result: PASS — 54 integrated web tests, including 11 SSR rendering cases.
- Gates: check, lint, typecheck, and whitespace checks pass.
- UI: campaign/session targets are explicit; match, scope, and privacy are
  neutral; only divergence and metric-specific limitations use warning tone
  and `role="status"`.
- Styles: existing design-system styles were sufficient.

## Lot E

- Added the mutable Codex append/recollect integration sequence, shared the
  harness-home fixture with the production server, strengthened production
  smoke assertions, and updated the architecture, package-interface, and
  session-analysis source documentation.
- Result: the pipeline moves from match to a difference of exactly duration,
  model attribution, and tokens, then returns to match after recollection.
- Production E2E: PASS — 6 tests, 0 failures.
- Development E2E: PASS — 36 tests, 0 failures.
- Deviation: the shared fixture collapses the root and child into one campaign,
  so 205 atomic sessions produce 204 top-level rows. Production assertions were
  aligned with that intentional campaign model.
- Adjacent correction: two stale development E2E expectations were updated to
  match the existing dynamic API-value copy and the current `Time` column name.
- Environment: loopback/subprocess suites and production builds required the
  approved non-sandbox execution path; no production behavior was changed for
  that constraint.

## Final gates

- `bun install --frozen-lockfile`: PASS — lockfile unchanged.
- `bun run build`: PASS — 9 tasks.
- `bun run typecheck`: PASS — 16 tasks.
- `bun run check`: PASS — 433 files.
- `bun run lint`: PASS — Ultracite and package-boundary checks.
- `bun run test`: PASS — 15 package tasks plus tools tests.
- `bun run test:web-production`: PASS.
- `bun run test:e2e-production`: PASS — 6 tests.
- `bun run test:e2e`: PASS — 36 tests.
- `git diff --check`: PASS; no lockfile or generated-output drift.
- No commit was created because the user did not request repository history
  changes; all five lots remain available as one reviewed worktree change.
