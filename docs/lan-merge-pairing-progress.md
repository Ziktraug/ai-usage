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

- `46cc44e refactor: rename report packages`

## Slice 1: Domain Boundaries

Status: completed

Picked on: 2026-06-19
Stable on: 2026-06-19

Goal:

- Add typed domain boundaries for merge bundles, LAN pairing, usage merge, and usage-store.
- Define the `lan-peers.json` storage boundary.
- Avoid UI behavior changes.

Difficulties:

- The new interface-only packages still need test files because `bun test` exits non-zero when a package has a `test` script but no tests.
- Parsed JSON validators in TypeScript needed constructed return values rather than direct `Record<string, unknown>` casts.

Decisions:

- Put `UsageMergeBundle`, `SerializedMergeRow`, row status, stable row key, source fingerprint, content hash, and parse/create helpers in `@ai-usage/report-core/merge-bundle`.
- Use deterministic SHA-256 hashes over stable JSON for row identity/content change detection.
- Keep `@ai-usage/lan-pairing` project-agnostic: it imports only `effect` and exposes generic LAN identity, discovery, pairing, and service interfaces.
- Put the ai-usage-specific `TrustedLanPeer`, `LanMergeState`, service commands, and machine-to-LAN identity adapter in `@ai-usage/usage-merge`.
- Put the first `lan-peers.json` parse/path boundary in `@ai-usage/local-collectors/lan-peers`; no read/write mutation workflow yet.
- Define `@ai-usage/usage-store` as an Effect-shaped interface package only; SQLite implementation starts in Slice 3.

File changes:

- Added `packages/report-core/src/merge-bundle.ts` and focused tests.
- Added `packages/local-collectors/src/lan-peers.ts` and focused tests.
- Added package manifests, tsconfigs, public interfaces, and boundary tests for `packages/lan-pairing`, `packages/usage-store`, and `packages/usage-merge`.
- Added public exports for `@ai-usage/report-core/merge-bundle` and `@ai-usage/local-collectors/lan-peers`.
- Regenerated `bun.lock`.

Checks:

- `bun test packages/report-core/src/merge-bundle.test.ts packages/local-collectors/src/lan-peers.test.ts`: passed.
- `bun test packages/lan-pairing/src/index.test.ts packages/usage-store/src/index.test.ts packages/usage-merge/src/index.test.ts`: passed.
- `bun run --cwd packages/lan-pairing check`: passed.
- `bun run --cwd packages/usage-store check`: passed.
- `bun run --cwd packages/usage-merge check`: passed.
- Boundary search: `packages/lan-pairing` has no `@ai-usage/*` imports.
- Boundary search: no package imports `@ai-usage/web`; the only `apps/web` package hit is an RTK test fixture path.
- `bun run test`: passed.
- `bun run check`: passed. Biome reported the same non-failing `/nix/store` max-size warnings.

Commit:

- `3fddde2 feat: add LAN merge domain boundaries`

## Slice 2: Dependency Boundary Linting

Status: completed

Picked on: 2026-06-19
Stable on: 2026-06-19

Goal:

- Enforce the package graph boundary instead of leaving it as documentation.
- Catch forbidden direct source imports and forbidden workspace dependencies.
- Link the lint policy back to the LAN merge plan and package READMEs.

Difficulties:

- The installed Biome CLI exposes experimental `search`, but this repo does not have a Grit plugin setup and `biome explain` does not expose a project-domain rule in this version.
- Biome `noRestrictedImports` can express source import bans, but not package-specific `package.json` dependency matrix checks.

Decisions:

- Add scoped Biome `noRestrictedImports` overrides for package boundaries that are simple to express globally per path: `packages/lan-pairing` cannot import `@ai-usage/*`, and `packages/report-core` cannot import workspace packages.
- Add `tools/check-package-boundaries.ts` for the package graph cases that need package-specific import and dependency checks.
- Co-locate architectural comments with the policy list in the checker so the reason for each forbidden edge is visible next to the rule.
- Wire `tools/check-package-boundaries.ts` into `bun run lint`.

File changes:

- Updated `biome.json` with scoped restricted-import overrides.
- Added `tools/check-package-boundaries.ts`.
- Updated root `package.json` lint script.
- Updated `docs/architecture.md` to document the boundary lint entry point and link it to this plan and package READMEs.

Checks:

- `bun run lint`: passed. Biome reported the same non-failing `/nix/store` max-size warnings.
- `bun run check`: passed. Biome reported the same non-failing `/nix/store` max-size warnings.
- Boundary search: `packages/lan-pairing` has no `@ai-usage/*` imports.
- Boundary search: no package imports `@ai-usage/web`.
- `bun run test`: passed.

Commit:

- `0e98b5f chore: enforce package boundaries`

## Slice 3: Usage Store Local Pipeline

Status: completed

Picked on: 2026-06-19
Stable on: 2026-06-19

Goal:

- Add the SQLite-backed local usage-store pipeline.
- Import locally collected rows into the store before reporting.
- Query active local rows back through the store without adding LAN behavior.

Difficulties:

- `bun:sqlite` is Bun-specific, while app production builds can run under Node. The store now imports it dynamically inside the database opener instead of using a top-level import.
- `report-data` needed `LocalHistoryError` as a runtime value, not only a type, so usage-store failures can be wrapped consistently with existing local collection errors.
- The local collection path had to keep source metadata even when callers did not request it, because stable row keys require source identity.

Decisions:

- Store rows in `~/.config/ai-usage/usage-store.sqlite` under the same home boundary already used by local history storage.
- Use the `SerializedMergeRow` key/hash model from `@ai-usage/report-core/merge-bundle` as the persisted row contract.
- Default report queries to `active` rows and leave `superseded`/`deleted` support in the schema for later merge slices.
- Apply project aliases before importing local rows, preserving current report output while making the store the report read path.
- Keep peer bundle import/export functions in `usage-store` now, but do not call them from runtime code until Slice 4.

File changes:

- Implemented `packages/usage-store/src/index.ts` with SQLite migration, import, query, export, and self-import rejection helpers.
- Added `deserializeMergeRow` to `packages/report-core/src/merge-bundle.ts`.
- Updated `packages/report-data/src/index.ts` so local rows are imported into usage-store and read back from usage-store.
- Added `@ai-usage/usage-store` as a `packages/report-data` dependency.
- Expanded `packages/usage-store/src/index.test.ts` with idempotent import and same-key update tests.
- Regenerated `bun.lock`.

Checks:

- `bun test packages/usage-store/src/index.test.ts`: passed.
- `bun run --cwd packages/usage-store check`: passed.
- `bun run --cwd packages/report-data check`: passed.
- `bun run --cwd packages/report-data test`: passed.
- `bun run --cwd apps/cli test`: passed.
- `bun run check`: passed. Biome reported the same non-failing `/nix/store` max-size warnings.
- `bun run test`: passed.

Commit:

- Pending.
