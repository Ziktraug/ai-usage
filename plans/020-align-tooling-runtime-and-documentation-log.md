# Plan 020 execution log

- Starting SHA: `fd000b0`
- Branch: `codex/execute-untracked-plans`
- Runtime before metadata alignment: Bun `1.3.13`; package/CI declared `1.3.11`, Bun types declared `^1.3.14`.
- Runtime after alignment: local and `nix develop` Bun `1.3.13`; package manager, CI, and Bun types exactly `1.3.13`.

## Changes

- Lefthook delegates only to the installed `lint-staged`; repository-wide glob
  formatting and `stage_fixed` were removed.
- The temporary-repository regression proves staged formatting while preserving
  fully unstaged, untracked, and same-file unstaged suffix bytes. It also covers
  an empty staged set.
- Dead `sessionCsvColumns`, its test, and the stale dashboard CSV comment were
  removed. CLI CSV and Cursor CSV ingestion remain.
- Current architecture, package interfaces, ownership READMEs, context, and the
  plan index were reconciled to the shipped architecture.

## Residue and gates

- Four legacy exact-revision runners: absent.
- Old exact-runner symbols/imports: absent.
- Canonical portable row/byte declarations: one each.
- Superseded portable budget names and `sessionCsvColumns`: absent.
- Active current-document web/focused CSV and removed HTML-export claims: absent.
- Bun install with the updated lockfile: passed.
- No platform skip: Nix and loopback tooling were available on this Linux host.

Final command durations and the closing SHA are recorded in the repository-wide
execution log after the full validation matrix.
