# LAN Merge Pairing Progress

This file tracks implementation progress for `docs/lan-merge-pairing-plan.md`.

## Slice 0: Rename And Package READMEs

Status: completed

Picked on: 2026-06-19
Stable on: 2026-06-19

Goal:

- Rename the existing core/reporting/web package boundaries.
- Add package ownership READMEs using the required structure.
- Keep runtime behavior unchanged.

Difficulties:

- `rg` is not installed in this environment, so inventory used `find` and `grep`.
- A first mechanical replacement overmatched `@ai-usage/report-core` and `@ai-usage/report-data` because `report` was treated as a word boundary before `-core` and `-data`; this was corrected before checks.
- The source plan itself was accidentally rewritten during the broad replacement pass and was restored so it still documents the original old-to-new names.
- Full `bun run check` initially failed because `tools/check-public-package-exports.ts` assumed every `packages/*` directory had a `package.json`; README-only future package directories exposed that assumption.

Decisions:

- Rename the app package from `@ai-usage/report` to `@ai-usage/web` to match `apps/web`.
- Keep future `usage-store`, `lan-pairing`, and `usage-merge` as README-only directories in this slice; package manifests and code belong to Slice 1.
- Update active architecture/tooling docs to the new names while leaving historical migration logs as historical unless checks require changes.
- Update the public export checker to skip directories that are not packages yet.

File changes:

- Moved `packages/usage-core` to `packages/report-core`.
- Moved `packages/reporting` to `packages/report-data`.
- Moved `apps/report` to `apps/web`.
- Updated workspace package names, imports, scripts, and active docs from the old names to `@ai-usage/report-core`, `@ai-usage/report-data`, and `apps/web`.
- Added required boundary READMEs for `apps/web`, `apps/cli`, `packages/report-core`, `packages/report-data`, `packages/local-collectors`, `packages/usage-store`, `packages/lan-pairing`, `packages/usage-merge`, and `packages/design-system`.
- Updated `tools/check-public-package-exports.ts` so workspace package discovery ignores directories without `package.json`.
- Regenerated `bun.lock`.

Checks:

- `bun run --cwd packages/report-core check`: passed.
- `bun run --cwd packages/report-data check`: passed.
- `bun run --cwd apps/cli check`: passed.
- `bun run --cwd apps/web check`: passed.
- `bun run check`: passed. Biome reported non-failing max-size warnings for large files under `/nix/store`.
- `bun run test`: passed.
- Exact stale-name search across active code/config found no `@ai-usage/core`, `@ai-usage/reporting`, `@ai-usage/report`, `packages/usage-core`, `packages/reporting`, or `apps/report` hits. Remaining old-name hits are in the source plan and this progress note.

Commit:

- Pending.
