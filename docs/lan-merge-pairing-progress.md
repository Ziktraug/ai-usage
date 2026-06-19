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

- `13da52c feat: add usage-store local pipeline`

## Slice 4: Usage Store Peer Bundle Import/Export

Status: completed

Picked on: 2026-06-19
Stable on: 2026-06-19

Goal:

- Prove usage-store can export this machine's merge bundle and import peer merge bundles.
- Keep peer rows by origin machine and stable row key.
- Make report-data include stored peer rows in the normal local payload path.

Difficulties:

- Effect typed failures reject through `Effect.runPromise` as fiber failures, so self-import tests need `Effect.either` to assert the typed `UsageStoreError`.
- Querying all active stored rows would have leaked stored Cursor rows when `includeCursor` is false, and would have ignored explicit harness selection. The store query needed a harness-key filter before report-data could safely read local plus peer rows.

Decisions:

- Keep later peer imports additive: a missing row in a later peer bundle does not delete prior peer rows.
- Treat explicit `deleted` merge rows as tombstones by updating row status and excluding them from default active queries.
- Keep local export limited to this machine's active rows.
- Add `harnessKeys` to `queryReportRows` so report-data can apply the same harness selection to stored local and peer rows.

File changes:

- Extended `packages/usage-store/src/index.ts` query input with `harnessKeys`.
- Updated `packages/report-data/src/index.ts` to query all active stored rows while preserving requested harness and Cursor selection.
- Expanded `packages/usage-store/src/index.test.ts` with local export, peer import, self-import rejection, idempotent import, changed-content update, missing-row retention, and tombstone tests.
- Added a `packages/report-data/src/reporting.test.ts` integration test proving stored peer rows appear in the final local `UsageReportPayload`.

Checks:

- `bun test packages/usage-store/src/index.test.ts`: passed.
- `bun test packages/report-data/src/reporting.test.ts`: passed.
- `bun run --cwd packages/usage-store check`: passed.
- `bun run --cwd packages/report-data check`: passed.
- `bun run check`: passed. Biome reported the same non-failing `/nix/store` max-size warnings.
- `bun run test`: passed.

Commit:

- `807cb0b feat: support usage-store peer bundles`

## Slice 5: LAN Pairing Runtime

Status: completed

Picked on: 2026-06-19
Stable on: 2026-06-19

Goal:

- Add a generic process-local LAN pairing runtime in `packages/lan-pairing`.
- Bind the first available port in the stable `3847-3857` range by default.
- Expose `/lan/health`, `/lan/peer`, and generic pairing endpoints without ai-usage imports.

Difficulties:

- `exactOptionalPropertyTypes` required clearing optional runtime fields by omitting them instead of assigning `undefined`.
- TypeScript widens object-literal status values inside `Ref.update`, so runtime state updates need explicit literal statuses.
- `Bun.serve().port` is typed optional in tests even though it is populated after binding.

Decisions:

- Implement the runtime as an Effect `Layer` and `Ref`-backed service via `makeLanPairingService` and `LanPairingRuntimeLive`.
- Use Bun's HTTP server for this first runtime slice, matching the repo's Bun-based package tests.
- Keep the generic pairing endpoints minimal and credential-redacted; real PAKE remains a later slice.
- Treat repeated `start` and `stop` calls as idempotent.
- Keep discovery as a stub returning no peers until Slice 6.

File changes:

- Added the generic LAN pairing HTTP handler, port-range binder, runtime state, service factory, Context tag, and live Layer in `packages/lan-pairing/src/index.ts`.
- Expanded `packages/lan-pairing/src/index.test.ts` to cover random local servers, occupied-port fallback, full-range failure, idempotent lifecycle, and public credential redaction.

Checks:

- `bun test packages/lan-pairing/src/index.test.ts`: passed.
- `bun run --cwd packages/lan-pairing check`: passed.
- `bun run check`: passed. Biome reported the same non-failing `/nix/store` max-size warnings.
- `bun run test`: passed.
- Boundary search: `packages/lan-pairing/src` has no `from '@ai-usage/*'` imports.

Commit:

- `d9e2e15 feat: add LAN pairing runtime`

## Slice 6: Discovery

Status: completed

Picked on: 2026-06-19
Stable on: 2026-06-19

Goal:

- Add active subnet-scan discovery to `packages/lan-pairing`.
- Scan the stable LAN port range without mDNS/Bonjour/Avahi.
- Keep the discovery interface open for later manual-host or mDNS adapters.

Difficulties:

- Discovery needed to be generic enough for fake transports and later adapters, while still usable by the process-local runtime immediately.
- Port scans run concurrently, so tests cannot rely on probe ordering.

Decisions:

- Add `LanPeerProbeTransport` and `discoverLanPeers` as the adapter boundary.
- Generate default discovery hosts from non-internal IPv4 interfaces and `/24` subnet candidates.
- Scan all ports in `3847-3857` by default.
- Preserve cached peers as `online: false` when a later scan misses them.
- Mark self peers explicitly instead of dropping them, matching the existing snapshot discovery behavior.

File changes:

- Added subnet host generation, default interface host discovery, fetch-based peer probing, and active LAN peer discovery in `packages/lan-pairing/src/index.ts`.
- Added injectable discovery options to `makeLanPairingServiceWithOptions`; `scan()` now updates the runtime discovery cache.
- Added tests for multiple-interface subnet candidates, fake transport scanning, stable port range coverage, machine-id dedupe, self detection, and offline cache state.

Checks:

- `bun test packages/lan-pairing/src/index.test.ts`: passed.
- `bun run --cwd packages/lan-pairing check`: passed.
- `bun run check`: passed. Biome reported the same non-failing `/nix/store` max-size warnings.
- `bun run test`: passed.
- Boundary search: `packages/lan-pairing/src` has no `from '@ai-usage/*'` imports.

Commit:

- `8309f0f feat: add LAN peer discovery`

## Slice 7: PAKE Library Spike

Status: completed

Picked on: 2026-06-19
Stable on: 2026-06-19

Goal:

- Evaluate `@cipherman/pake-js` CPace for Bun/Node compatibility and suitability.
- Prove same-password pairing derives a shared session key and wrong passwords fail confirmation.
- Bind the transcript to peer IDs, protocol version, session ID, and pairing roles.
- Keep the proof inside `packages/lan-pairing` with no ai-usage imports.

Difficulties:

- Public search did not surface clean package metadata, so the npm registry and package tarball were inspected directly.
- CPace does not include an explicit confirmation round, so the package wrapper adds role-bound HMAC confirmations over the derived ISK.
- The selected package is pre-1.0, recently published, and single-maintainer; this is acceptable for a spike only because its API is encapsulated and replaceable.

Decisions:

- Accept `@cipherman/pake-js@0.1.1` for the spike because it is stateless, supports Bun/Node imports, exposes CPace/Ristretto255, has one runtime dependency (`@noble/curves`), and has no transport or app-domain coupling.
- Derive CPace PRS with `scryptSync` using a transcript-derived salt before calling the library.
- Bind transcript fields through channel identifier and associated data: peer IDs, protocol, protocol version, session ID, and initiator/responder role.
- Reject self-pairing, expired sessions, mismatched/replayed peer messages, and wrong-password confirmations.
- Explicitly reject Noise as the short-password PAKE mechanism and keep HMAC challenge-response only as a documented weaker fallback.

File changes:

- Added `@cipherman/pake-js` to `packages/lan-pairing`.
- Added CPace PAKE start/complete/verify helpers to `packages/lan-pairing/src/index.ts`.
- Expanded `packages/lan-pairing/src/index.test.ts` with Node import smoke, same-password success, wrong-password failure, replay/expiry/self/concurrent session tests, and secret redaction checks.
- Updated `packages/lan-pairing/README.md` with the library decision, maturity caveat, alternatives, and fallback policy.
- Regenerated `bun.lock`.

Checks:

- `bun test packages/lan-pairing/src/index.test.ts`: passed.
- Node import smoke for `@cipherman/pake-js/cpace`: passed inside the LAN pairing test suite.
- `bun run --cwd packages/lan-pairing check`: passed.
- `bun run check`: passed. Biome reported the same non-failing `/nix/store` max-size warnings.
- `bun run test`: passed.
- Boundary search: `packages/lan-pairing/src` has no `from '@ai-usage/*'` imports.

Commit:

- Pending.
