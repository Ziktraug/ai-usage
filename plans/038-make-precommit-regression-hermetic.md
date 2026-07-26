# Plan 038: Make the staged-only pre-commit regression hermetic

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 96b3dff..HEAD -- .lintstagedrc.json lefthook.yml tools/precommit-staged-only.test.ts`
> If an in-scope file changed, compare the current-state excerpts below with the
> live code. Any semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `96b3dff`, 2026-07-26

## Why this matters

The regression that is meant to prove staged-only formatting launches
`lint-staged` from the real repository while pointing it at a temporary
repository. In a prior controlled run, that test formatted an unrelated tracked
plan in the real worktree; the implementation is unchanged at this baseline.
A tooling test must be safe to run in a dirty contributor checkout before it
can serve as a commit-hook guarantee.

## Current state

- `.lintstagedrc.json:2` maps supported staged files to `ultracite fix`.
- `lefthook.yml:1-3` correctly delegates the hook to
  `bun x --no-install lint-staged`; do not replace it with a repository-wide
  formatter.
- `tools/precommit-staged-only.test.ts:53-60` resolves the installed
  `lint-staged` binary and config from the real repository, but calls
  `run(repositoryRoot, [..., "--cwd", fixture])`.
- `tools/precommit-staged-only.test.ts:70-78` repeats the same real-root process
  working directory for the no-staged-files case.
- The intended guarantee is recorded in
  `plans/020-align-tooling-runtime-and-documentation.md`: use installed
  repository binaries with a temporary Git fixture, and never stage or modify
  the real worktree.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Targeted test | `bun test tools/precommit-staged-only.test.ts` | exit 0; 1 test passes |
| Tool tests | `bun run test:tools` | exit 0 |
| Format check | `bun run check` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Diff safety | `git diff --check` | exit 0, no output |

Do **not** run the current targeted test in the primary worktree before applying
the hermetic fix. Its unsafe behavior has already been reproduced.

## Scope

**In scope** (the only files you may modify):

- `tools/precommit-staged-only.test.ts`
- `.lintstagedrc.json` — only if the isolated fixture proves the installed
  Ultracite command ignores lint-staged's explicit file arguments
- `lefthook.yml` — only if needed to preserve the same no-install invocation

**Out of scope**:

- application or package source code;
- dependency upgrades or lockfile changes;
- removing supported Markdown, SCSS, or other staged extensions to hide a
  formatter problem;
- staging, formatting, or restoring unrelated user files.

## Git workflow

- Branch: `fix/038-hermetic-precommit-test`
- Use one focused commit with an imperative message, for example
  `Make the pre-commit regression hermetic`.
- Do not push or open a pull request unless explicitly requested.

## Steps

### Step 1: Run lint-staged from the temporary repository

In `tools/precommit-staged-only.test.ts`, keep absolute paths to the checked-in
config and installed `lint-staged` binary, but launch both invocations with
`fixture` as the process `cwd`. Build the child environment explicitly so the
real repository's `node_modules/.bin` is prepended to `PATH`; retain
`--no-install` behavior at the hook boundary.

Before invoking lint-staged, capture the real repository's:

- `git status --porcelain=v1 -z`;
- `git diff --binary`;
- `git diff --cached --binary`.

After both fixture invocations, assert those three values are byte-for-byte
unchanged. This guard must tolerate a checkout that was already dirty; it is
not a clean-worktree assertion.

**Verify**: inspect the diff and run
`grep -En "run\\(repositoryRoot" tools/precommit-staged-only.test.ts` → no matches.

### Step 2: Preserve staged and partially staged semantics

Keep the existing assertions for the formatted staged blob, the partial file's
unstaged suffix, and untouched unstaged/untracked files. Strengthen the final
empty-index invocation by asserting that it creates no new fixture status
entries. Do not run `git add .` merely to reach the empty-index case; commit
only the intended fixture files and leave the untracked sentinel available for
the preservation assertion.

If the isolated fixture still causes Ultracite to inspect the real repository,
first prove whether the issue is child `cwd`, `PATH`, or the command in
`.lintstagedrc.json`. Only then make the smallest in-scope config adjustment,
while continuing to pass lint-staged's file list explicitly.

**Verify**: `bun test tools/precommit-staged-only.test.ts` → exit 0 and the real
repository baseline assertions pass.

### Step 3: Run repository gates without invoking a mutating hook smoke

Run the tool suite and static checks. Do not run `bun run fix`, the real
pre-commit hook, or any command that formats the entire checkout as part of
verification.

**Verify**:

```sh
bun run test:tools
bun run check
bun run typecheck
git diff --check
```

All commands exit 0.

## Test plan

- Modify `tools/precommit-staged-only.test.ts`; do not create a second harness.
- Cover:
  - a fully staged supported file;
  - a partially staged file whose unstaged suffix survives;
  - fully unstaged and untracked files;
  - an empty staged index;
  - a pre-existing real-worktree state that is identical before and after.
- Use the existing temporary Git repository as the structural pattern.

## Done criteria

- [ ] Both lint-staged child processes run with the temporary repository as
      their process working directory.
- [ ] The test proves real worktree, index, and status state are unchanged.
- [ ] Staged and partially staged fixture behavior remains covered.
- [ ] `bun run test:tools`, `bun run check`, and `bun run typecheck` exit 0.
- [ ] No file outside the in-scope list is modified.
- [ ] This plan's row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- an in-scope file no longer matches the current-state description;
- verification changes any unrelated real-worktree file;
- the fix would require a network install or an unpinned executable;
- Ultracite ignores explicit file arguments even with the fixture `cwd`, and no
  supported staged-file invocation can be proven;
- a verification command fails twice after one reasonable correction.

## Maintenance notes

The regression must remain safe in dirty worktrees because that is where commit
tooling is used. Review future changes to lint-staged, Ultracite, or the test
runner for both Git-target selection and the child process working directory.
