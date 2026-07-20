# Plan 027 execution log

- Started: 2026-07-20
- Starting commit: `e59ae83`
- Branch: `feat/027-claude-session-insight-vcs`
- Plan 026 baseline: `9545fb8`
- Pre-existing user changes: none; worktree was clean
- Drift check: no scoped changes from `9545fb8` to the starting commit
- Cursor decision: **REJECTED for Cursor in plan 027**; see evidence below

| Work package | Status | Commit | Verification |
| --- | --- | --- | --- |
| 0 — Baseline, fixtures, and portable-format proof | DONE | `76d1212` | PASS — 4 fixture tests |
| A — Honest recorded/partial/unavailable timing | DONE | `3e08ba6` | PASS — 40 focused tests; 31 collector regressions |
| B — Portable VCS contract and v3 migration | DONE | `5fb1464` | PASS — 103 focused tests; four package checks |
| C — Shared Claude facts, detail, and harness VCS | DONE | `af1c418` | PASS — 53 focused tests; collector check and lint |
| D — Exact-revision Claude wiring and explicit resolver | DONE | `e74bee3`, `d5176c4` | PASS — 21 focused tests; web/report checks and lint |
| E — Claude chronology and VCS UI | DONE | `dcedbb6` | PASS — 67 UI tests, 4 Claude-fact tests, 6 production E2E tests, web check |
| F — OpenCode VCS and Cursor decision | DONE | pending | PASS — 30 focused tests |
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

- Package E adds `lucide-solid@1.25.0` as a web runtime dependency because
  Plan 027 requires the standard Lucide external-link icon and the repository
  did not already contain Lucide. Work stopped at that condition; the user
  explicitly approved `lucide-solid` on 2026-07-20 before installation.
- The production Playwright script previously launched its Bun-only fixture
  import under Node, so the exact package-E command failed before test
  discovery with an unsupported `bun:sqlite` URL. The script now pins
  Playwright to the repository's required Bun runtime via `bun --bun`; after a
  fresh production build the unchanged six scenarios pass. No assertion or
  production boundary was weakened.

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
- Package D.1: `e74bee3`. The dispatch test first returned `unsupported`
  for a Claude anchor. Claude is now a declared detail harness and the default
  server uses an exhaustive reader map after revision authority, provenance,
  and source-machine checks. Portable, wrong-machine, missing-provenance,
  missing-history, expired-revision, and Cursor cases remain unavailable before
  any local analysis read. The focused server/client/runner suite passes 13
  tests and the web package type check passes.
- Package D.2: `d5176c4`. Client/server tests first failed because the
  explicit resolution modules did not exist. The immutable anchor now carries
  strictly parsed VCS from `source_row_json`; the browser still submits only
  revision and row ID. Portable, wrong-machine, missing-VCS, and unsupported-
  forge anchors perform zero resolver calls. The GitHub adapter locates `gh`
  without a shell, invokes one structured final-branch query with a 5-second
  timeout and 256 KiB stdout limit, caps results at 16, validates repository-
  matching HTTPS PR URLs, drains but never retains stderr, and returns only
  sanitized typed failures. Pending client calls deduplicate, completed values
  are not cached or persisted, and retry/row changes issue distinct requests.
  The 21-test package gate, web/report checks and web lint pass; tests use fake
  provider ports and a local subprocess only, never real GitHub.
- Package E: `dcedbb6`. The VCS component test first failed because the
  component was absent; the Claude render test then failed because an untimed
  turn had no point marker. The unified drawer now renders strict portable VCS
  facts without a new surface, truncates long values, discloses branch spans,
  abbreviates commits with the full hash in its title, and uses accessible
  Lucide external-link affordances only for validated HTTPS URLs. Missing
  links stay text. GitHub resolution is invoked only by the explicit button,
  keeps pending/success/typed-failure state in memory, retries safely, and
  resets stale state on row change or cleanup. Claude uses its own chronology
  wording, unavailable effort, zero-based turn labels, and point markers for
  untimed events without claiming `0s` active time. The exact focused UI suite
  passes 67 tests; the Claude semantic regression file passes 4 tests; a fresh
  build and the production Playwright suite pass all 6 scenarios; the web
  check, focused Biome check, and `git diff --check` pass.
- Package F: pending commit. The OpenCode integration test first failed with
  absent VCS and a cache hit from version 8. OpenCode now derives only a
  repository from the session's recorded absolute `directory`, through the
  existing bounded no-follow local Git reader. It memoizes directories per
  database collection and deliberately emits no branch, commit, or PR; the
  current checkout's `HEAD` in the fixture therefore never becomes session
  history. The row-changing cache version is 9.

## Cursor decision evidence

**REJECTED for Cursor in plan 027.** No Cursor row or cache changed.

- A read-only schema/count audit on 2026-07-20 observed 342 `composerData`
  keys (338 valid JSON). Only 5 records had `workspaceIdentifier`; only 2 had
  `activeBranch`, 15 had `createdOnBranch`, and none had `commitHash` or a
  repository field. No record had both `workspaceIdentifier` and either
  recorded branch field. The 9 `trackedGitRepos` fields were empty arrays.
- The sparse `workspaceIdentifier` shape was `{ id: text, uri: object }`, but
  its 5/342 coverage cannot deterministically map the other composers to a
  recorded workspace/worktree. Joining current workspace storage would
  substitute present checkout authority for session-time evidence.
- The separate AI tracking database had 369 `scored_commits` over 12 branch
  names. Its schema has `commitHash` and `branchName` but no `composerId` or
  `conversationId`. The only table with a `composerId`, `ai_deleted_files`,
  had zero rows and contains neither repository nor commit authority.
- Consequently composer-to-workspace is not generally deterministic,
  recorded workspace/branch evidence does not overlap, and commit attribution
  would require the prohibited global branch/time proximity join. Cursor
  remains VCS-unavailable. The focused suite proves its fixture row still has
  no `source.vcs`.
- The package gate passes 30 tests across OpenCode facts/detail and real/in-
  memory DB collectors; no test or collector invokes GitHub.
