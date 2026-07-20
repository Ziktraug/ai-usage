# Plan 027 execution log

- Started: 2026-07-20
- Starting commit: `e59ae83`
- Branch: `feat/027-claude-session-insight-vcs`
- Plan 026 baseline: `9545fb8`
- Pre-existing user changes: none; worktree was clean
- Drift check: no scoped changes from `9545fb8` to the starting commit
- Cursor decision: pending Package F evidence audit

| Work package | Status | Commit | Verification |
| --- | --- | --- | --- |
| 0 — Baseline, fixtures, and portable-format proof | DONE | `76d1212` | PASS — 4 fixture tests |
| A — Honest recorded/partial/unavailable timing | DONE | `3e08ba6` | PASS — 40 focused tests; 31 collector regressions |
| B — Portable VCS contract and v3 migration | DONE | pending | PASS — 103 focused tests; four package checks |
| C — Shared Claude facts, detail, and harness VCS | PENDING | — | — |
| D — Exact-revision Claude wiring and explicit resolver | PENDING | — | — |
| E — Claude chronology and VCS UI | PENDING | — | — |
| F — OpenCode VCS and Cursor decision | PENDING | — | — |
| G — Vertical proof, docs, measurements, and closure | PENDING | — | — |

## Baseline

- `git status --short --branch`: PASS — clean `main` at `e59ae83`, one commit ahead of `origin/main`.
- `git diff --check`: PASS.
- Requested branch did not exist and was created locally.
- Exact Plan 027 drift check from `9545fb8`: PASS — no scoped diff.
- Report-core baseline: PASS — 42 tests, 0 failures.
- Collector/fixture baseline: PASS — 46 tests, 0 failures.
- Web baseline: PASS — 66 tests, 0 failures.
- `bun run typecheck`: PASS — 16 tasks.

## Deviations

- None.

## Measurements

- Pending Package G. Measurements will retain only counts, durations, and artifact sizes.

## Commits

- Package 0: `76d1212`. Fixture test first failed because the required
  Claude paths and records were absent, then passed after the literal fixture
  was extended. `git diff --check` passed.
- Package A: `3e08ba6`. Parser/model tests first failed on the missing
  timing discriminants and span-only presentation. The completed contract
  passes 40 focused tests, 31 Codex/OpenCode regression tests, report-core and
  web checks, and `git diff --check`. Existing replay ambiguity remains report
  coverage rather than being mislabeled as timing coverage; open OpenCode
  assistant turns now carry unavailable timing instead of a zero sentinel.
- Package B: pending commit. VCS/domain and v3 tests first failed on the absent
  module and version-2 writers. The completed package passes 103 focused tests
  plus report-core, local-collectors, usage-store, and usage-merge checks.
  Snapshots and merge bundles now write v3, migrate v1/v2 without VCS, reject
  `source.vcs` under old versions, and preserve VCS through cache/store/manual
  merge. VCS changes source/content hashes and store generation but not the
  stable merge row key or `sessionRowIdentity`. CSV remains unchanged.
