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
| B — Portable VCS contract and v3 migration | DONE | `5fb1464` | PASS — 103 focused tests; four package checks |
| C — Shared Claude facts, detail, and harness VCS | DONE | `af1c418` | PASS — 53 focused tests; collector check and lint |
| D — Exact-revision Claude wiring and explicit resolver | IN PROGRESS | pending | PASS — Claude exact-revision dispatch (13 focused tests) |
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
- Package B: `5fb1464`. VCS/domain and v3 tests first failed on the absent
  module and version-2 writers. The completed package passes 103 focused tests
  plus report-core, local-collectors, usage-store, and usage-merge checks.
  Snapshots and merge bundles now write v3, migrate v1/v2 without VCS, reject
  `source.vcs` under old versions, and preserve VCS through cache/store/manual
  merge. VCS changes source/content hashes and store generation but not the
  stable merge row key or `sessionRowIdentity`. CSV remains unchanged.
- Package C: `af1c418`. Claude facts/history tests first failed because
  the shared parser and exact reader did not exist; the Codex VCS test first
  failed because `session_meta.payload.git` was discarded. The collector now
  calls the same pure parser as local detail for prompts, deduplication,
  tokens, tools, model attribution, lineage, timing, branches, and recorded
  PRs. Claude detail proves match -> differs -> match, unsafe transcript
  symlinks fail through a typed boundary, and neither report rows nor caches
  receive the detail prompt collection. Codex selects Git metadata from the
  first identity-owning session meta, preserves repository/branch/commit, and
  ignores later metas. The package passes 53 focused tests, local-collectors
  type checking and lint, and `git diff --check`.
- Package D.1: pending commit. The dispatch test first returned `unsupported`
  for a Claude anchor. Claude is now a declared detail harness and the default
  server uses an exhaustive reader map after revision authority, provenance,
  and source-machine checks. Portable, wrong-machine, missing-provenance,
  missing-history, expired-revision, and Cursor cases remain unavailable before
  any local analysis read. The focused server/client/runner suite passes 13
  tests and the web package type check passes.
