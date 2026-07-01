# Plan 001 Implementation Log

## Slice Log

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
