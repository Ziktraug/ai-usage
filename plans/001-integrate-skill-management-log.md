# Plan 001 Implementation Log

## Slice Log

### Slice 11: Project Path Picker UX

- Status: completed
- Goal: replace the raw project-path entry with a picker based on projects already present in the local report payload.
- Files touched:
  - `apps/web/src/routes/skills.tsx`
  - `apps/web/src/server/skills.ts`
  - `apps/web/src/server/skills.server.ts`
  - `apps/web/src/server/skills.server.test.ts`
  - `plans/001-integrate-skill-management-log.md`
- Decisions:
  - Use report `projectGroups[].sources[].sourcePath` as the primary known-project source, with a fallback to row `source.sourcePath` for older stored payloads.
  - Filter known project choices to the current machine and to local directories that still exist.
  - Keep a manual path input because browser directory pickers do not provide a stable absolute local path that can be persisted by this local web app.
  - Keep configured project paths explicit in `skills.projectPaths`; the picker only helps populate that list and does not reintroduce broad root scans.
- Problems encountered:
  - The previous `/skills` page only displayed configured `skills.projectPaths`, so already-scanned report projects were invisible until explicitly added.

Verification:

```bash
bun test apps/web/src/server/skills.server.test.ts apps/web/src/skills-page-model.test.ts packages/skills/src/index.test.ts packages/local-collectors/src/machine-config.test.ts
```

Result: passed.

### Slice 1: Product Boundary Docs

- Status: completed
- Goal: document the skill-management package boundary before feature code.
- Files touched:
  - `docs/skills-management.md`
  - `docs/architecture.md`
  - `docs/public-package-interfaces.md`
  - `docs/future-work.md`
  - `plans/README.md`
- Decisions:
  - Keep skill management native to `ai-usage` and exposed through `/skills`.
  - Keep user-local skill config in `~/.config/ai-usage/config.json`.
  - Keep portable source repo state JSON-only under the configured source repository.
  - Keep project and repository scans local-machine scoped, with no default broad root scan.
- Problems encountered:
  - `plans/` was untracked at start; the implementation plan and status README are being kept with the execution log so the plan status is reproducible.

Verification:

```bash
bun run lint
```

Result: passed.

### Slice 7: Read-Only `/skills` Web Route

- Status: completed with verification caveat
- Goal: expose a read-only skill-management snapshot in the web app.
- Files touched:
  - `apps/web/package.json`
  - `apps/web/src/server/skills.ts`
  - `apps/web/src/server/skills.server.ts`
  - `apps/web/src/routes/skills.tsx`
  - `apps/web/src/skills-page-model.ts`
  - `apps/web/src/skills-page-model.test.ts`
  - `apps/web/src/dashboard.tsx`
  - `apps/web/src/routeTree.gen.ts`
  - `packages/skills/src/index.ts`
  - `bun.lock`
  - `plans/001-integrate-skill-management-log.md`
- Decisions:
  - Server functions follow the existing facade pattern and keep filesystem/config reads in `skills.server.ts`.
  - The server facade returns a serializable snapshot; `SkillFrontmatterField.value` is now constrained to JSON values instead of `unknown`.
  - `/skills` is read-only in this slice: summary tiles, managed skills, targets, unmanaged entries, diagnostics, and native-rules placeholder.
  - Dashboard navigation now links to `/skills`.
- Problems encountered:
  - `bun test apps/web/src` fails in pre-existing TSX tests with `Cannot find module 'react/jsx-dev-runtime'` from Solid TSX modules. The new `apps/web/src/skills-page-model.test.ts` passes, and build/typecheck/lint pass.

Verification:

```bash
bun test apps/web/src/skills-page-model.test.ts
bun test packages/skills/src apps/web/src/skills-page-model.test.ts
bun run typecheck
bun run build
bun run lint
```

Result: passed.

Additional attempted verification:

```bash
bun test apps/web/src
```

Result: failed on existing TSX test imports resolving `react/jsx-dev-runtime`; no skill-route test failed.

## Blocked Stop

Stopped after Slice 7 because the plan's STOP conditions include unrelated
existing web test failures. The read-only `/skills` slice is implemented and
passes targeted model/package tests, typecheck, lint, and build, but
`bun test apps/web/src` currently fails in pre-existing Solid TSX tests because
Bun resolves those TSX modules through `react/jsx-dev-runtime`.

Next safe slice after unblocking that test runner issue:

- Step 9 controlled mutations in the web route.
- Step 10 editor deferral verification.
- Final full `bun run test`, `bun run typecheck`, `bun run lint`, and `bun run build`.

### Slice 8: Controlled Web Mutations

- Status: completed
- Goal: wire explicit `/skills` mutations for config update, skill toggles, safe reconciliation, reconcile-all, and target directory creation.
- Files touched:
  - `packages/skills/src/index.ts`
  - `packages/skills/src/index.test.ts`
  - `apps/web/src/server/skills.ts`
  - `apps/web/src/server/skills.server.ts`
  - `apps/web/src/server/skills.server.test.ts`
  - `apps/web/src/skills-page-model.ts`
  - `apps/web/src/skills-page-model.test.ts`
  - `apps/web/src/routes/skills.tsx`
  - `plans/001-integrate-skill-management-log.md`
  - `plans/README.md`
- Decisions:
  - Target directory creation accepts only `targetId` from the client; the server resolves the configured path from the current snapshot.
  - Reconcile-all is disabled in the UI while unmanaged target content is present, and the workflow still refuses unsafe actions server-side.
  - Disabling a skill toggles source state and runs safe cleanup for managed symlinks before refreshing the snapshot.
  - Server function validators use package parsers for config, skill names, target ids, and boolean toggles.
- Problems encountered:
  - Running `bun test apps/web/src` concurrently with `bun run build` races on `.output`; rerunning the web tests by themselves passed.

Verification:

```bash
bun test packages/skills/src apps/web/src/skills-page-model.test.ts apps/web/src/server/skills.server.test.ts
bun run typecheck
bun run lint
bun run build
bun test apps/web/src
```

Result: passed when `bun test apps/web/src` was run without a concurrent build.

### Slice 9: Editor Deferral And Final Verification

- Status: completed
- Goal: confirm the editor slice is deferred and run the full done-criteria verification set.
- Files touched:
  - `plans/001-integrate-skill-management-log.md`
  - `plans/README.md`
- Decisions:
  - The skill editor remains deferred as future work; no `writeSkillFile`, `readSkillFile`, or `loadSkillDetail` symbols were added.
- Problems encountered:
  - None.

Verification:

```bash
rg -n "writeSkillFile|readSkillFile|loadSkillDetail" apps packages
bun run test
bun run typecheck
bun run lint
bun run build
```

Result: passed. The `rg` command exited with no matches.

### Slice 6: Read-Only Snapshot Workflows

- Status: completed
- Goal: add package-level workflow functions for snapshots, config writes, toggles, reconcile operations, and target directory creation.
- Files touched:
  - `packages/skills/src/index.ts`
  - `packages/skills/src/snapshot.test.ts`
  - `plans/001-integrate-skill-management-log.md`
- Decisions:
  - Workflow config IO is dependency-injected to avoid a cycle between `@ai-usage/skills` and `@ai-usage/local-collectors`.
  - Unconfigured snapshots return JSON-safe empty data instead of throwing.
  - Reconcile-all returns refused actions without applying any mutation if unmanaged content would be touched.
  - Native rule findings are represented in the snapshot shape but remain empty until the web/server slice has local project-path context.
- Problems encountered:
  - `exactOptionalPropertyTypes` required building scan options only when token thresholds are present.

Verification:

```bash
bun test packages/skills/src
bun run typecheck
bun run lint
```

Result: passed.

### Slice 5: Target Defaults And Projection Safety

- Status: completed
- Goal: add built-in agent runtime targets, target projection classification, health interpretation, and safe projection actions.
- Files touched:
  - `packages/skills/src/index.ts`
  - `packages/skills/src/projection.test.ts`
  - `plans/001-integrate-skill-management-log.md`
- Decisions:
  - Enabled default targets are Standard Agents, Claude Code, Codex, and OpenCode.
  - GitHub Copilot and Cursor defaults are present but disabled until their local paths are verified by real use.
  - `linked` is the only healthy projection state; enabled `missing` is visible as attention-needed.
  - Reconciliation refuses copied directories and unmanaged entries; unlink verifies the symlink resolves to the configured source path.
- Problems encountered:
  - TypeScript needed explicit union narrowing for `unlink-managed-symlink`.

Verification:

```bash
bun test packages/skills/src
bun run typecheck
bun run lint
```

Result: passed.

### Slice 4: Source State And Source Scanning

- Status: completed
- Goal: add JSON-only source state plus bounded source repository scanning for `skills/*/SKILL.md`.
- Files touched:
  - `packages/skills/src/index.ts`
  - `packages/skills/src/source-state.test.ts`
  - `packages/skills/src/skill-markdown.test.ts`
  - `packages/skills/src/source-scan.test.ts`
  - `plans/001-integrate-skill-management-log.md`
- Decisions:
  - Source state lives at `<sourceRepoPath>/.skill-tracker/state.json` and invalid content returns diagnostics with safe defaults.
  - The scanner ignores generated/vendor directories and enforces file-count and bytes-per-file limits before token counting.
  - Token counts are explicitly approximate and skip binary files.
  - Cursor frontmatter extensions `paths` and `disable-model-invocation` are preserved as known extensions; unknown fields produce warnings.
- Problems encountered:
  - Bun/TypeScript inferred a `readdir` overload with buffer names; using a structural `name: string` entry type kept the public behavior unchanged.

Verification:

```bash
bun test packages/skills/src
bun run typecheck
bun run lint
```

Result: passed.

### Slice 2: Package Scaffold And Domain Validation

- Status: completed
- Goal: add `@ai-usage/skills` with public exports for core domain types and server-facing runtime validators.
- Files touched:
  - `packages/skills/package.json`
  - `packages/skills/tsconfig.json`
  - `packages/skills/README.md`
  - `packages/skills/src/index.ts`
  - `packages/skills/src/index.test.ts`
  - `bun.lock`
- Decisions:
  - Keep the initial package dependency-free; the domain and validation layer does not need Effect or filesystem services.
  - Test through the public package export seam.
  - Keep `projectsRootPath` optional and never infer a personal default.
  - Use "agent runtime" vocabulary in package docs and types, not "harness", to avoid colliding with usage-report collectors.
- Problems encountered:
  - None.

Verification:

```bash
bun test packages/skills/src
bun run typecheck
bun run lint
bun install
```

Result: passed; `bun install` saved the workspace lockfile.

### Slice 3: ai-usage Config Integration

- Status: completed
- Goal: support optional `skills` config in `~/.config/ai-usage/config.json` without breaking existing config fields or merge behavior.
- Files touched:
  - `packages/report-core/src/project-alias.ts`
  - `packages/local-collectors/package.json`
  - `packages/local-collectors/src/machine-config.ts`
  - `packages/local-collectors/src/machine-config.test.ts`
  - `bun.lock`
- Decisions:
  - `report-core` exposes `AiUsageConfig.skills` as `unknown` because `report-core` is prohibited from importing workspace packages.
  - `local-collectors` validates the field with `parseSkillConfigInput` from `@ai-usage/skills`, preserving `@ai-usage/skills` as the owner of the precise config type.
  - Skills config merge preserves home `targets`, `connectors`, `tokenThresholds`, and ignored findings when repo config omits them.
- Problems encountered:
  - The precise `SkillManagementConfig` type cannot be referenced from `report-core` without violating the package graph boundary.

Verification:

```bash
bun test packages/local-collectors/src/machine-config.test.ts packages/skills/src
bun run typecheck
bun install
bun run lint
```

Result: passed.
