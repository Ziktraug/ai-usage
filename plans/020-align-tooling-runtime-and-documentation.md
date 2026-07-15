# Plan 020: Align Commit Tooling, Bun Runtime, Dead CSV Claims, and Final Documentation

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans 009-019
- **Category**: developer experience / toolchain / dead code / documentation
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `chore/020-align-tooling-and-docs`

## Executor instructions

Read this plan completely and compare the final implemented architecture with
`17bcf28` and every completed dependency. This is the closing reconciliation
plan: document what actually shipped, not what earlier plans predicted.

Use separate commits for staged-only hooks, Bun alignment, dead CSV residue, and
docs/plan-index reconciliation. Do not mix opportunistic dependency upgrades
into the Bun patch-level alignment.

Create `plans/020-align-tooling-runtime-and-documentation-log.md`. Record the
starting/final SHA, commits, before/after Bun metadata, hook regression result,
every residue command/result, each final gate's elapsed time, and every
intentional platform skip with its exact test and reason.

## Why this matters

The pre-commit hook runs `ultracite fix` over a repository-wide glob with
`stage_fixed: true`, while a separate lint-staged config already describes a
staged-file workflow. A commit can therefore rewrite and stage unrelated local
work.

The repository declares Bun 1.3.11 in `packageManager` and CI, uses
`@types/bun ^1.3.14`, while the pinned Nix development shell resolves Bun
1.3.13. Contributors and CI do not share one runtime/type baseline.

Current docs and two dead symbols still describe web/focused CSV export even
though that surface was removed. After the remediation program, architecture,
interfaces, commands, and deferred product directions need one final truthful
state.

## Target outcome

1. Pre-commit formatting touches and stages only already-staged supported files.
2. Unstaged/untracked developer work is byte-for-byte untouched by the hook.
3. Package metadata, CI, types, and Nix shell agree on Bun 1.3.13 without a broad
   nixpkgs update.
4. Dead web CSV schema aliases/comments/tests disappear; CLI CSV and Cursor CSV
   ingestion remain supported.
5. README/domain/architecture/interface docs match the implemented post-plan
   code and commands.
6. `plans/README.md` records dependencies/statuses, superseded HTML constraints,
   rejected audit candidates, and deferred product choices.

## Current-state evidence

- `lefthook.yml` runs `bun x ultracite fix` with a repository glob and
  `stage_fixed: true`.
- `.lintstagedrc.json` separately maps supported staged extensions to Ultracite.
- root `package.json` declares `packageManager: bun@1.3.11` and
  `@types/bun: ^1.3.14`.
- `.github/workflows/pr-checks.yml` installs Bun 1.3.11.
- the current Nix lock/dev shell resolves Bun 1.3.13.
- `README.md` claims the interactive web report exports the current view to CSV.
- `apps/web/src/dashboard.tsx` says sorted rows are shared by CSV export despite
  no consumer.
- `apps/web/src/session-table-schema.ts` exports dead `sessionCsvColumns`, with a
  test that keeps it alive.
- report-data/interface/architecture docs describe focused CSV/HTML runners that
  no longer represent the final system.

## Scope

### In scope

- `lefthook.yml`, `.lintstagedrc.json`, and a staged-only regression check;
- Bun package metadata, types pin, lockfile, and CI version;
- dead web CSV alias/comment/test cleanup;
- root/package READMEs, `CONTEXT.md`, current architecture/interface/future-work
  docs, and `plans/README.md`;
- final active-code/docs residue and full verification matrix.

### Out of scope

- updating unrelated packages or all of nixpkgs;
- removing CLI `--csv`, report-core CSV utilities, or Cursor CSV ingestion;
- reformatting unstaged files;
- rewriting completed plans/logs or dated audits to erase history;
- implementing deferred product features;
- remediating the LOW esbuild development-server advisory without a supported
  upstream/version reason.

## Commands

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- \
  lefthook.yml .lintstagedrc.json tools package.json bun.lock \
  .github/workflows/pr-checks.yml README.md CONTEXT.md docs apps packages plans/README.md
git status --short -- \
  lefthook.yml .lintstagedrc.json tools package.json bun.lock \
  .github/workflows/pr-checks.yml README.md CONTEXT.md docs apps packages plans/README.md
bun --version
nix develop --command bun --version
bun -e 'const p = await Bun.file("package.json").json(); console.log(JSON.stringify({ packageManager: p.packageManager, bunTypes: p.devDependencies?.["@types/bun"] }))'
rg -n 'bun-version:' .github/workflows/pr-checks.yml
bun install --frozen-lockfile
```

If either scoped drift command contains changes beyond completed plans 009-019,
STOP, preserve them, and reconcile the final code/docs/tooling state after
rebasing rather than overwriting it.

At `17bcf28`, both runtime commands already print `1.3.13`; the mismatch is in
package metadata, CI, and Bun types. STOP if the Nix lock/current runtime has
moved and no longer resolves 1.3.13; choose one evidence-backed version before
editing metadata.

## Implementation steps

### Step 1 - Make lint-staged the single pre-commit owner

Use the existing `.lintstagedrc.json` as the one file-pattern/command source.
Change its task to the local-bin command `ultracite fix`. Change Lefthook to run
`bun x --no-install lint-staged` and remove the repository glob plus
`stage_fixed` behavior. The `--no-install` and direct `ultracite` binary are
required: a commit hook must never download an unpinned executable.

Review supported extensions against Ultracite. Keep Markdown/SCSS only if the
installed Ultracite command supports them; do not silently omit a currently
formatted staged type.

Add `tools/precommit-staged-only.test.ts`. It creates an initialized temporary
Git repository with a baseline commit and four deterministic fixtures:

1. one fully staged misformatted supported file;
2. one tracked but fully unstaged misformatted file;
3. one untracked file;
4. one tracked file with a misformatted staged change and a distinct unstaged
   hunk in that **same file**.

Before the hook, capture the complete `git status --porcelain=v1`, bytes of the
unstaged/untracked fixtures, the partial file's staged blob via
`git show :<partial-file>`, and its distinct append-only unstaged suffix bytes.
Use a deterministic well-formatted marker block for that suffix so its exact
intent is separable from the staged blob. From the real repository root, run
exactly

```sh
bun x --no-install lint-staged \
  --config <absolute-repo>/.lintstagedrc.json \
  --cwd <temporary-repo>
```

Prepend the real repository's `node_modules/.bin` to `PATH`. This uses the
checked-in config and installed lockfile binaries while operating only on the
fixture; no temp-repo install or network fallback is allowed.

After the hook, assert the fully staged file and staged index version of the
partial file are formatted and re-staged; the same-file unstaged hunk is still
present by proving the worktree bytes equal the newly formatted index blob
plus the exact saved suffix bytes; the fully unstaged/untracked bytes and path
status remain unchanged; and no unexpected file is staged or created. Do not
compare raw `git diff --binary` bytes: reformatting the staged blob legitimately
changes its `index` header and hunk coordinates. Run the test once with the
fixture and once against a clean temporary index/no staged files.

Do not stage/modify files in the real worktree to test the hook.

Verify:

```sh
bun test tools/precommit-staged-only.test.ts
if test -z "$(git diff --cached --name-only)"; then
  bun x --no-install lefthook run pre-commit
else
  echo 'SKIP real-worktree hook smoke: index is not empty'
fi
bun x ultracite check
```

The temporary-repository test is the proof with staged fixtures. Run the guarded
real-worktree smoke only when its index is empty; if the guard fails, skip it
rather than modifying the user's staged work.

### Step 2 - Pin one Bun 1.3.13 baseline

Use Bun 1.3.13 because it is already supplied by the pinned Nix shell:

1. set root `packageManager` to exact `bun@1.3.13`;
2. set CI `bun-version` to `1.3.13`;
3. pin `@types/bun` exactly to `1.3.13` without a caret;
4. regenerate `bun.lock` using Bun 1.3.13;
5. do not update `flake.lock` or nixpkgs generally;
6. run install/type/tests in both the current shell and `nix develop` where
   practical.

If `@types/bun@1.3.13` is unavailable or introduces a real missing type needed by
the code, STOP. Do not upgrade nixpkgs broadly to win one patch version; record a
separate explicit toolchain decision.

Verify:

```sh
bun --version
nix develop --command bun --version
bun -e 'const p = await Bun.file("package.json").json(); if (p.packageManager !== "bun@1.3.13" || p.devDependencies?.["@types/bun"] !== "1.3.13") throw new Error("Bun package metadata is not exactly 1.3.13")'
bun -e 'const workflow = await Bun.file(".github/workflows/pr-checks.yml").text(); const versions = [...workflow.matchAll(/bun-version:\s*[^0-9]*([0-9]+\.[0-9]+\.[0-9]+)/g)].map((match) => match[1]); if (versions.length === 0 || versions.some((version) => version !== "1.3.13")) throw new Error(`Unexpected CI Bun versions: ${versions.join(",")}`)'
bun install --frozen-lockfile
bun run typecheck
bun run test
```

Both version commands must print `1.3.13`.

### Step 3 - Remove only dead web/focused CSV residue

1. Remove `sessionCsvColumns` from
   `apps/web/src/session-table-schema.ts`, its now-unused import, and its test.
2. Update the `dashboard.tsx` sorted-row comment to describe drawer/navigation
   only.
3. Remove claims of a web "export current view to CSV", focused CSV query, or
   complete CSV/HTML revision query from current docs.
4. Confirm no actual web CSV export consumer exists before deletion.

Keep:

- CLI `--csv` and its renderer/tests/docs;
- `@ai-usage/report-core/csv` if still consumed;
- Cursor CSV collection/import;
- historical audit facts and project-grouping references that truly concern
  CLI/ingestion rather than web export.

Verify:

```sh
rg -n -i \
  'focused.*csv|csv.*focused|export the current view to csv|complete csv/html' \
  README.md CONTEXT.md apps/web/README.md packages/report-data/README.md \
  docs/architecture.md docs/public-package-interfaces.md docs/future-work.md
rg -n 'sessionCsvColumns' apps/web/src
```

Expected: no match. Historical plans/audits are deliberately absent from this
closed current-document list.

### Step 4 - Reconcile current documentation to implemented code

Update, as applicable after all earlier plans:

- `README.md`: supported CLI/web commands, test matrix, and file-only `/sync`
  preview, without naming removed export surfaces as current features;
- `CONTEXT.md`: report payload, local/portable source authority, semantic store
  generation, capture fingerprint, and Skills application terminology;
- `docs/architecture.md`: collector trust/limits, storage permissions, exact
  revision runner/session owner, semantic no-op refresh, transfer preview, and
  Skills application boundary;
- `docs/public-package-interfaces.md`: actual public entries only;
- `docs/future-work.md`: remove constraints tied to HTML/static asset closure and
  separate product ideas from corrective work;
- package READMEs for report-data, local-collectors, usage-store, usage-merge,
  Skills, CLI, and web where their contracts changed;
- current Skills spec where ownership/safety changed.

Prefer links to one canonical architecture section over duplicating detailed
contracts in many READMEs. Do not mention an internal helper as a public API.

### Step 5 - Close the plan index and audit decision record

Update `plans/README.md` with plans 009-020, exact dependencies, and the actual
status of each implementation. Record:

- plan 009 supersedes completed plans 007/008 only for the static HTML
  compatibility constraint; historical files stay unchanged;
- static asset closure/HTML renderer repair: `REJECTED`, because the product
  surface was removed;
- LOW esbuild dev-server advisory: no corrective action unless severity/scope or
  upstream support changes;
- "Adopt unmanaged skill into source": deferred product decision after plan 019,
  not smuggled into security refactoring;
- campaigns-by-intention/privacy analytics: deferred product decision;
- Wrapped/shareable recap based on HTML export: rejected in that form; a future
  non-HTML feature needs a new product/design plan;
- duplicate explicit CI tool-test wiring: retain unless measurement proves it is
  harmful; it is not a correctness finding.

Do not mark a plan DONE until its own done criteria and gates actually pass.

### Step 6 - Run final residue and full matrix

Run these machine-checkable residue gates. They intentionally scan active code,
CI, and an explicit list of current documentation. Historical `plans/**`,
execution logs, and `docs/audits/**` are excluded rather than rewritten.

```sh
if rg -n \
  'html-payload|FocusedHtmlPayloadResult|projectFocusedHtmlPayload|getFocusedReportHtmlPayload|fetchFocusedHtmlPayload|inlineReportHTML|inlineAssetsIntoHTML|renderReportAppHTML|toExportReportPayload|downloadCompleteHtml|downloadHTML|isStaticReportRuntime|createHashHistory|__AI_USAGE_REPORT__|__AI_USAGE_REPORT_STATIC__|__AI_USAGE_REPORT_EXPORT_PAYLOAD__|AI_USAGE_REPORT_APP_DIR|RUN_HTML_EXPORT_INTEGRATION|playwright\.static' \
  apps packages tools .github package.json; then exit 1; fi

test ! -e apps/web/src/server/focused-report-query-runner.server.ts
test ! -e apps/web/src/server/session-query-runner.server.ts
test ! -e packages/report-data/src/focused-report-query-runner.ts
test ! -e packages/report-data/src/session-query-runner.ts
if rg -n \
  'runFocusedReportQueryForServer|runSessionQueryForServer|focused-report-query-runner\.server|session-query-runner\.server' \
  apps/web/src packages/report-data/src; then exit 1; fi

test "$(rg -n 'export const MAX_PORTABLE_USAGE_ROWS\s*=' packages/report-core/src --glob '*.ts' | wc -l | tr -d ' ')" = 1
test "$(rg -n 'export const MAX_PORTABLE_USAGE_BYTES\s*=' packages/report-core/src --glob '*.ts' | wc -l | tr -d ' ')" = 1
if rg -n \
  'MAX_USAGE_SNAPSHOT_(ROWS|BYTES)|MAX_MANUAL_MERGE_UPLOAD_(ROWS|BYTES)' \
  apps packages; then exit 1; fi

if rg -n 'sessionCsvColumns' apps/web/src; then exit 1; fi

ACTIVE_DOCS=(
  README.md CONTEXT.md apps/cli/README.md apps/web/README.md
  docs/architecture.md docs/future-work.md docs/public-package-interfaces.md
  docs/skills-management-spec.md docs/skills-management.md
  packages/local-collectors/README.md packages/report-core/README.md
  packages/report-data/README.md packages/skills/README.md
  packages/usage-merge/README.md packages/usage-store/README.md
)
if rg -n -i \
  'export the current view to csv|complete csv/html|focused (csv|html) (query|export)|self-contained html (file|export)|web report exports?.*csv' \
  "${ACTIVE_DOCS[@]}"; then exit 1; fi

bun -e 'const root = await Bun.file("package.json").json(); const web = await Bun.file("apps/web/package.json").json(); const forbidden = [[root,"html"],[root,"test:html-export"],[root,"test:html-file"],[web,"test:html-file"]]; for (const [manifest,key] of forbidden) if (key in (manifest.scripts ?? {})) throw new Error(`Removed script remains: ${key}`)'
```

Every `if rg ...; then exit 1; fi` must produce no match. The two portable-budget
declaration counts must each be exactly one; imports/usages may be many. If a
renamed canonical symbol is intentionally chosen in plan 014, update only the
two declaration assertions and record that name in the execution log—do not
weaken the one-owner check.

Then run:

```sh
bun test tools/precommit-staged-only.test.ts
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:web-production
bun run test:setup-loopback
CI=1 bun run test:e2e
CI=1 bun run test:e2e-production
bun install --frozen-lockfile
git diff --check
git status --short
```

Record durations and any intentional platform skips in
`plans/020-align-tooling-runtime-and-documentation-log.md`.

## Done criteria

- Pre-commit touches only staged supported files and has a temp-repo regression.
- Bun runtime/types/package/CI/Nix all resolve to 1.3.13.
- No dead web/focused CSV alias or current-doc claim remains.
- CLI/Cursor CSV functionality remains tested and documented.
- Current docs match the code that actually shipped across plans 009-019.
- The plan index contains status, dependencies, superseded constraints, rejected
  findings, and deferred product decisions.
- The complete supported verification matrix passes.

## STOP conditions

- Hook testing would modify/stage real unrelated worktree files.
- The staged-only tool cannot preserve unstaged changes byte-for-byte.
- Nix no longer supplies 1.3.13, or matching Bun types are unavailable.
- Aligning Bun requires a broad nixpkgs/dependency upgrade.
- CSV cleanup reaches CLI CSV or Cursor CSV ingestion.
- Documentation describes intended architecture that was not implemented.
- Historical plans/logs would need rewriting to make residue searches pass.
- A deferred product feature is being implemented as incidental cleanup.

## Maintenance note

Keep one declared Bun version, one staged-file hook owner, and one canonical
architecture source. Current docs describe supported code; historical plans
remain honest history, and product ideas stay separate from corrective work.
