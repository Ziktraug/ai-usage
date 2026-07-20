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
| 0 — Baseline, fixtures, and portable-format proof | DONE | pending | PASS — 4 fixture tests |
| A — Honest recorded/partial/unavailable timing | PENDING | — | — |
| B — Portable VCS contract and v3 migration | PENDING | — | — |
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

- Package 0: pending commit. Fixture test first failed because the required
  Claude paths and records were absent, then passed after the literal fixture
  was extended. `git diff --check` passed.
