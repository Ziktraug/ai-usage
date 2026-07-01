# Plan 001: Integrate Skill Management Into ai-usage

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise around filesystem mutation safety.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 49a1952..HEAD -- package.json turbo.json biome.json docs apps/web packages tools
> ```
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch that changes package boundaries, config ownership, or server
> function patterns, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `49a1952`, 2026-07-01

## Why this matters

`../agent-skills` has a working local control plane for Agent Skills: it scans a
source skill repository, validates `SKILL.md`, observes local runtime targets,
classifies symlink health, and reconciles managed symlinks safely. The validated
product direction is to make this native to `ai-usage`, exposed as a dedicated
`/skills` route, while keeping the implementation behind a separate package such
as `@ai-usage/skills`.

The integration should not copy the prototype wholesale. `ai-usage` already has
stronger package-boundary rules, a user-local JSON config, TanStack Start server
function conventions, and an existing web design system. The goal is a native
skill management area that feels like part of `ai-usage` without contaminating
the usage reporting domain.

## Current state

### Existing ai-usage boundaries

- `docs/architecture.md` defines package ownership. `@ai-usage/report-core` is
  pure domain code and must not read the filesystem; `@ai-usage/local-collectors`
  owns local history and user-local config; `apps/web` owns UI routes and server
  function facades.
- `docs/public-package-interfaces.md` lists the only public package exports and
  states that cross-package imports must use package exports, not private `src`
  paths.
- `biome.json` enforces restricted imports for relative workspace paths and
  private `@ai-usage/*/src/**` imports.
- `packages/local-collectors/src/machine-config.ts` owns
  `~/.config/ai-usage/config.json` parsing and writing.

Relevant excerpts:

```md
docs/architecture.md:94
- Local history adapters live in `@ai-usage/local-collectors`.
- Report orchestration lives in `@ai-usage/report-data`.
- Sync transport and workflow modules live in `@ai-usage/sync`.
- CLI renderers live in `apps/cli`.
- Web server functions and browser output adapters live in `apps/web`.
- Design-system exports are consumed through package exports, never through relative package paths.
```

```md
docs/public-package-interfaces.md:1
The workspace packages expose only these public seams. Cross-package imports must use these package exports, not private `src` paths or relative workspace paths.
```

```ts
packages/local-collectors/src/machine-config.ts:16
export const machineConfigPath = (storage: LocalHistoryStorageService) =>
  path.join(storage.home, '.config', 'ai-usage', 'machine.json');

packages/local-collectors/src/machine-config.ts:19
export const aiUsageConfigPath = (storage: LocalHistoryStorageService) =>
  path.join(storage.home, '.config', 'ai-usage', 'config.json');
```

### Existing web patterns

- `apps/web/src/routes/index.tsx` loads report data through a route loader and
  renders focused components.
- `apps/web/src/routes/sync.tsx` is the best local example of a non-report
  operational route with server actions, state summaries, forms, diagnostics,
  and design-system styling.
- `apps/web/src/server/sync.ts` exposes server functions as thin dynamic-import
  facades over server-only implementation files.

Relevant excerpt:

```ts
apps/web/src/server/sync.ts:1
import { createServerFn } from '@tanstack/solid-start';

export const getLanMergeState = createServerFn({ method: 'GET' }).handler(() =>
  import('./lan-merge.server').then(({ readLanMergeStateForServer }) => readLanMergeStateForServer()),
);
```

### Prototype worth porting from agent-skills

`../agent-skills` implements the vertical slice:

- source repository scan;
- `SKILL.md` parsing and validation;
- approximate token counts;
- connector and target observation;
- target projection classification;
- symlink reconciliation planning and application;
- read-only native rules detection;
- TanStack Start/Solid UI and server functions;
- tests for config/state/scanner/projection/program/UI smoke paths.

Relevant excerpts:

```md
../agent-skills/docs/skill-tracker-planning.md:24
1. The current `agent-skills` repository contains the app, not the skill library.
2. A second user-configured repository is the source of system skills.
3. Project repositories keep ownership of their own skills and `AGENTS.md`.
4. Rules are `AGENTS.md` only. Native rule formats are read-only.
```

```ts
../agent-skills/packages/projection/src/index.ts:1
export type ProjectionAction =
  | {
      type: "create-symlink" | "repair-symlink" | "unlink-managed-symlink";
      skillName: string;
      targetId: string;
      path: string;
      sourcePath: string;
    }
  | {
      type: "refuse-unmanaged-mutation" | "noop";
      skillName: string;
      targetId: string;
      path: string;
      reason: string;
    };
```

### Prototype risks to fix during port

Do not copy these behaviors unchanged:

- `../agent-skills/packages/config-store/src/index.ts` and
  `../agent-skills/packages/source-state/src/index.ts` fall back to dynamic
  importing local TypeScript data files when JSON-shaped parsing fails. For the
  integrated feature, user-local config must stay in `~/.config/ai-usage/config.json`;
  portable source state should be JSON, not executable TypeScript.
- `../agent-skills/apps/web/src/server-functions.ts` validators mostly return
  the input unchanged. The integrated server functions must perform runtime
  validation before filesystem paths or mutation inputs reach workflows.
- `../agent-skills/apps/web/src/router.tsx` treats `missing` projections as
  healthy. In `ai-usage`, `missing` must be visible as "not linked" or "needs
  reconcile" because the primary user goal is to verify active skills are
  actually exposed through symlinks.
- `../agent-skills/packages/scanner/src/index.ts` recursively reads entire skill
  directories and hashes directory contents with no scan limits. Add file count,
  byte size, and ignored directory safeguards during the port.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `bun install` | exit 0 |
| Test all | `bun run test` | exit 0, all tests pass |
| Typecheck | `bun run typecheck` | exit 0, no TypeScript errors |
| Lint | `bun run lint` | exit 0, no restricted import or boundary failures |
| Full build | `bun run build` | exit 0, web build succeeds |
| Targeted web tests | `bun test apps/web/src` | exit 0 |
| Targeted package tests | `bun test packages/skills/src` | exit 0 after `@ai-usage/skills` exists |

## Suggested executor toolkit

- If a `tdd` skill is available, use it for the package port. The scanner and
  projection behavior has clear fixtures and should stay test-first.
- Use `rg` to verify import boundaries and package names.
- Prefer `apply_patch` for manual edits and avoid moving large files without
  reviewing package names, exports, and imports.

## Scope

**In scope**:

- `package.json`
- `turbo.json`
- `biome.json`
- `docs/architecture.md`
- `docs/public-package-interfaces.md`
- `docs/future-work.md`
- `packages/skills/**` (new)
- `packages/local-collectors/src/machine-config.ts`
- `packages/report-core/src/project-alias.ts` if `AiUsageConfig` remains there
- `apps/web/package.json`
- `apps/web/src/routes/skills.tsx` (new)
- `apps/web/src/server/skills.ts` (new)
- `apps/web/src/server/skills.server.ts` (new)
- `apps/web/src/skills-*.ts` and `apps/web/src/skills-*.tsx` (new UI model/components)
- package README files needed for ownership docs
- focused tests beside new or changed modules

**Out of scope**:

- Rewriting the usage dashboard or report payload architecture.
- Changing `UsageRow`, usage snapshots, merge bundles, or LAN merge protocols.
- Editing CLI report rendering unless a later explicit requirement adds a CLI
  skills command.
- Native management of Cursor/Copilot/Claude rule formats. Native rules remain
  read-only diagnostics in this plan.
- Importing from GitHub, skills.sh, or SkillSpector. Keep those as future work.
- Adoption or rename flows for unmanaged skills. This plan may surface them as
  diagnostics only.
- Any automatic deletion or overwrite of unmanaged target content.

## Git workflow

- Branch: `advisor/001-integrate-skill-management`
- Commit style observed in `git log`: concise imperative subject, for example
  `Add persistent remote snapshot sync` or `Move manual merge import to server action`.
- Commit by slice, not by every tiny edit.
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Record the product and package boundary

Add a short architecture note before writing feature code:

- Create `docs/skills-management.md`.
- Update `docs/architecture.md` with a new package ownership section for
  `@ai-usage/skills`.
- Update `docs/public-package-interfaces.md` with the new package export.
- Add a short item to `docs/future-work.md` for deferred adoption/import/editor
  improvements.

The docs must state:

- Skill management is native to `ai-usage`, exposed through `/skills`.
- The package name is `@ai-usage/skills`.
- `@ai-usage/skills` owns skill config types, source state parsing, source scans,
  target scans, projection planning/apply, diagnostics, and workflow functions.
- User-local skill config lives under `~/.config/ai-usage/config.json` via the
  existing ai-usage config path.
- Portable source repo state lives in the configured source repository, but as
  JSON data, not executable TypeScript.
- `apps/web` owns UI and server function facades only.
- Project/repository skill inventory is local-machine only. Do not use synced
  rows, peer snapshots, remote machine ids, or LAN merge state to decide which
  repositories to scan.
- No personal directory convention such as `~/Projects` may become a default.
  Repository discovery can use explicit config and locally observed project
  paths, but broad root scans must be opt-in.

**Verify**:

```bash
bun run lint
```

Expected: exit 0.

### Step 2: Add `@ai-usage/skills` package scaffold

Create `packages/skills` with:

- `package.json` declaring `name: "@ai-usage/skills"`, root export `"."`, scripts
  matching other packages (`build`, `check`, `test`, `lint`, `format`).
- `tsconfig.json` matching nearby package patterns.
- `README.md` documenting ownership, dependencies, non-ownership, and test
  strategy.
- `src/index.ts` exporting only public APIs.

Dependencies should be conservative:

- `effect` is allowed if workflows are Effect-based.
- Avoid dependencies on `@ai-usage/report-data`, `@ai-usage/usage-store`,
  `@ai-usage/usage-merge`, `@ai-usage/lan-pairing`, and apps.
- If shared `AiUsageConfig` remains in `@ai-usage/report-core/project-alias`,
  `@ai-usage/skills` may import config shape types only if that does not create
  a filesystem dependency inside `report-core`.

Update:

- root `package.json` only if scripts or workspace behavior need changes;
  workspaces already include `packages/*`.
- `turbo.json` only if package-specific outputs are needed.
- `docs/public-package-interfaces.md` for `@ai-usage/skills`.

**Verify**:

```bash
bun run typecheck
bun run lint
```

Expected: both exit 0.

### Step 3: Port the pure domain model and runtime validation

Implement skill domain types in `packages/skills/src/index.ts` or split into
small exported modules if that is clearer:

- `SkillManagementConfig`
- `SkillSourceState`
- `SkillDiagnostic`
- `SkillTarget`
- `SourceSkill`
- `SkillManifest`
- `Projection`
- `ProjectionAction`
- runtime validators for all server-facing inputs:
  - `parseSkillConfigInput`
  - `parseSkillName`
  - `parseSkillFilePath`
  - `parseTargetId`
  - `parseSkillMutationInput`

Port and adapt these concepts from `../agent-skills/packages/domain/src/index.ts`.
Keep names in `ai-usage` vocabulary:

- Use "runtime" or "agent runtime" for Codex/Claude/OpenCode/Cursor/Copilot
  skill consumers.
- Do not use "harness" for skill consumers. In `ai-usage`, "Harness" means a
  local history source for usage reporting, as defined in `CONTEXT.md`.

Validation rules:

- Skill names are lowercase kebab-case.
- Server-facing file paths must be relative and must remain inside the selected
  skill directory after resolution.
- Source repo path and target paths must be non-empty strings.
- Booleans must be actual booleans, not truthy strings.

**Verify**:

```bash
bun test packages/skills/src
bun run typecheck
```

Expected: tests pass; typecheck exits 0.

### Step 4: Integrate skills config into ai-usage config

Extend the existing `AiUsageConfig` shape with an optional `skills` section.
Current config parsing lives in `packages/local-collectors/src/machine-config.ts`.

Recommended shape:

```ts
interface AiUsageSkillsConfig {
  sourceRepoPath?: string;
  // Optional explicit local root to scan for project-level rules/skills.
  // There is no default such as ~/Projects.
  projectsRootPath?: string;
  targets?: Record<
    string,
    {
      enabled: boolean;
      kind: 'standard-interop' | 'native' | 'custom';
      path: string;
      scope: 'system' | 'project';
    }
  >;
  connectors?: Record<
    string,
    {
      enabled: boolean;
      consumesTargets: string[];
    }
  >;
  tokenThresholds?: {
    skillMd: { warn: number; high: number };
    referenceFile: { warn: number; high: number };
    totalSkill: { warn: number; high: number };
  };
  ignoredTargetFindings?: string[];
}
```

Implementation rules:

- Preserve existing config fields and merge behavior.
- Keep existing project group, cursor, and sync parsing unchanged except for
  recognizing `config.skills`.
- Write JSON with `writeAiUsageConfig`; do not introduce `config.ts`.
- Add tests for valid and invalid `skills` config.
- Treat `projectsRootPath` as an optional, explicit local setting only. If it is
  absent, do not infer `~/Projects`, `~/projects`, or any other personal folder
  convention.

**Verify**:

```bash
bun test packages/local-collectors/src/machine-config.test.ts packages/skills/src
bun run typecheck
```

Expected: tests pass; typecheck exits 0.

### Step 5: Port source state and source scanning with JSON-only storage

Implement source repository state under:

```text
<sourceRepoPath>/.skill-tracker/state.json
```

Use this shape:

```json
{
  "version": 1,
  "skillEnabledByName": {
    "example-skill": false
  }
}
```

Port scanner behavior from `../agent-skills/packages/scanner/src/index.ts`, but
add safeguards:

- ignore `.git`, `node_modules`, `dist`, `build`, `.turbo`, `styled-system`;
- enforce a maximum number of files per skill;
- enforce a maximum bytes-per-file for text token counting;
- do not read binary files into token-count text paths;
- return diagnostics instead of throwing for unreadable files where possible.

Required source scan behavior:

- Scan `sourceRepoPath/skills/*/SKILL.md`.
- Parse frontmatter fields `name` and `description`.
- Preserve known Cursor extensions such as `paths` and
  `disable-model-invocation`.
- Warn on unknown frontmatter fields.
- Mark absent skills as enabled by default.
- Count approximate tokens, clearly marked approximate.

Port tests from:

- `../agent-skills/packages/source-state/src/index.test.ts`
- `../agent-skills/packages/markdown/src/index.test.ts`
- `../agent-skills/packages/scanner/src/index.test.ts`
- `../agent-skills/packages/tokens/src/index.test.ts`

**Verify**:

```bash
bun test packages/skills/src
bun run typecheck
```

Expected: package tests pass; typecheck exits 0.

### Step 6: Port target observation and projection safety

Implement built-in runtime target observation in `@ai-usage/skills`.

Target defaults should include the same user-visible runtimes from the prototype:

- Standard Agents: `~/.agents/skills`
- Claude Code: `~/.claude/skills`
- Codex: `~/.codex/skills`
- OpenCode: `~/.config/opencode/skills`
- GitHub Copilot: keep default disabled until verified by local use
- Cursor: keep default disabled until verified by local use

Projection classification must include:

- `linked`
- `missing`
- `broken-link`
- `wrong-target`
- `unmanaged-copy`
- `unmanaged-symlink`
- `duplicate-same-content`
- `duplicate-name-conflict`
- `disabled-exposed`
- `missing-target`

Mutation rules:

- Creating a symlink is allowed only for a valid enabled source skill and an
  enabled target.
- Repair is allowed only when the existing target entry is a symlink.
- Unlink is allowed only when the symlink resolves to the configured source
  skill path.
- Never delete copied directories.
- Never overwrite unmanaged symlinks.
- Never mutate native rule files.

Fix the prototype's health interpretation:

- `linked` is healthy for enabled skills.
- `missing` is not healthy for enabled skills; it means "not linked" or "ready
  to reconcile".
- `missing-target`, `broken-link`, `wrong-target`,
  `duplicate-name-conflict`, `unmanaged-*`, and `disabled-exposed` need visible
  attention.

Port tests from:

- `../agent-skills/packages/projection/src/index.test.ts`
- target scanning tests in `../agent-skills/packages/scanner/src/index.test.ts`

Add one new test that proves enabled `missing` is not summarized as healthy.

**Verify**:

```bash
bun test packages/skills/src
bun run lint
```

Expected: tests pass; lint exits 0.

### Step 7: Build skill workflows for read-only snapshot first

Implement workflow functions in `@ai-usage/skills`:

- `loadSkillManagementSnapshot`
- `initializeSkillManagement`
- `writeSkillManagementConfig`
- `toggleSkillEnabled` (may update state but do not expose in UI yet unless
  Step 9 is in progress)
- `reconcileSkill` (implemented and tested, but not wired into read-only UI yet)
- `reconcileAllActiveSkills` (implemented and tested, but not wired into
  read-only UI yet)
- `createSkillTargetDirectory` (implemented and tested, but not wired into
  read-only UI yet)

Read-only snapshot must compose:

1. merged ai-usage config;
2. skill source state;
3. runtime observations;
4. target observations;
5. source skill scan;
6. target projection scan;
7. native rules diagnostics for local project sources only:
   - prefer local project paths already observed by this machine's local usage
     collection;
   - include `projectsRootPath` only when the user explicitly configured it;
   - never use synced/merged rows from other machines as scan targets.

If `sourceRepoPath` is absent, return a UI-safe "not configured" snapshot rather
than throwing.

**Verify**:

```bash
bun test packages/skills/src
bun run typecheck
```

Expected: tests pass; typecheck exits 0.

### Step 8: Add `/skills` read-only web route

Create:

- `apps/web/src/server/skills.ts`
- `apps/web/src/server/skills.server.ts`
- `apps/web/src/routes/skills.tsx`
- small UI model files such as `apps/web/src/skills-page-model.ts`
- component files if route size grows, for example
  `apps/web/src/skills-status.tsx` and `apps/web/src/skills-table.tsx`

Server function rules:

- Follow the `apps/web/src/server/sync.ts` facade pattern.
- Keep filesystem and workflow calls in `skills.server.ts`.
- Validate inputs at the server function boundary using parsers from
  `@ai-usage/skills`.
- Return JSON-safe objects only.

UI requirements for Slice 1:

- route `/skills`;
- summary tiles for configured source repo, skill count, active skills, target
  health, diagnostics;
- table of managed skills with name, description, enabled state, token count,
  validation status, target status;
- table of unmanaged target entries;
- read-only native rules section;
- clear empty state when skills are not configured;
- link from the existing dashboard shell or header to `/skills`.

Use existing design-system report classes from `@ai-usage/design-system/report`
before adding new tokens. Follow the density and operational style of
`apps/web/src/routes/sync.tsx`; do not build a marketing page.

**Verify**:

```bash
bun test apps/web/src
bun run typecheck
bun run build
```

Expected: tests pass; typecheck and build exit 0.

### Step 9: Wire controlled mutations

After the read-only UI is working, add explicit actions:

- initialize or update skill config;
- toggle skill enabled;
- reconcile one skill;
- reconcile all active skills that are valid and unblocked;
- create a missing target directory.

UI rules:

- Show the planned action result before or immediately after mutation.
- Use disabled buttons and status text for unsafe or refused operations.
- Do not offer "reconcile all" if any action would touch unmanaged content.
- Do not hide diagnostics after mutation; refresh the snapshot and show the new
  state.

Tests:

- server function input validation rejects invalid skill names, invalid target
  ids, non-boolean toggles, and unsafe file paths;
- mutation workflow refuses unmanaged copies and unmanaged symlinks;
- toggling disabled removes only managed symlinks;
- target directory creation only creates the configured target path.

**Verify**:

```bash
bun test packages/skills/src apps/web/src
bun run typecheck
bun run lint
```

Expected: tests pass; typecheck and lint exit 0.

### Step 10: Defer the editor unless the previous slices are stable

The prototype includes file listing, text editing, and git diff. Do not port it
until scan, diagnostics, and reconciliation are stable in `ai-usage`.

If the editor is added in this plan anyway, it must be its own final slice:

- `loadSkillDetail`
- `readSkillFile`
- `writeSkillFile`
- `readSkillGitDiff`
- runtime validation for every file path;
- max file size for editor reads;
- no binary editing;
- no writes outside `sourceRepoPath/skills/<skillName>`.

Recommended default: leave editor as future work in `docs/future-work.md`.

**Verify if deferred**:

```bash
rg -n "writeSkillFile|readSkillFile|loadSkillDetail" apps packages
```

Expected: no new editor workflow symbols unless this step was intentionally
implemented.

## Test plan

Add or port tests at these layers:

- `packages/skills/src/source-state.test.ts`
  - missing state defaults;
  - invalid state returns diagnostics;
  - toggles persist to JSON.
- `packages/skills/src/skill-markdown.test.ts`
  - valid frontmatter;
  - missing description;
  - name mismatch;
  - Cursor extension preservation;
  - unknown extension warnings.
- `packages/skills/src/source-scan.test.ts`
  - valid and invalid skills;
  - token thresholds;
  - ignored directories;
  - file/byte limits.
- `packages/skills/src/projection.test.ts`
  - create symlink;
  - repair symlink only;
  - unlink only managed symlink;
  - refuse copied directories;
  - refuse unmanaged symlinks;
  - disabled invalid skill can still clean up managed symlink.
- `packages/skills/src/snapshot.test.ts`
  - unconfigured state;
  - configured source + targets;
  - enabled missing projection is not healthy.
- `apps/web/src/skills-page-model.test.ts`
  - summary counts;
  - health labels;
  - action availability rules.
- `apps/web/src/server/skills.server.test.ts` or equivalent
  - invalid server inputs are rejected before workflow mutation.

Use the structure of the existing tests in `../agent-skills`, but rename imports
and adapt config/state storage to `ai-usage` conventions.

## Done criteria

All must hold:

- [ ] `@ai-usage/skills` exists with public package exports only.
- [ ] `docs/architecture.md` and `docs/public-package-interfaces.md` document
      the new package boundary.
- [ ] `~/.config/ai-usage/config.json` supports optional `skills` config
      without breaking existing config fields.
- [ ] Portable skill source state is JSON-only; no dynamic import fallback is
      used for source repo state.
- [ ] `/skills` route exists and renders a read-only snapshot when configured.
- [ ] Enabled `missing` projections are visibly not healthy.
- [ ] Reconciliation actions never overwrite or delete unmanaged content.
- [ ] Runtime validation exists for every server function input.
- [ ] `bun run test` exits 0.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `bun run build` exits 0.
- [ ] `git status --short` contains only intentional files in scope plus
      generated files expected by the repo.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report back if:

- The user-local config ownership has moved away from
  `packages/local-collectors/src/machine-config.ts`.
- The web app no longer uses TanStack Start server functions.
- Implementing `@ai-usage/skills` requires importing from private
  `@ai-usage/*/src/**` paths.
- A mutation requires deleting copied directories, overwriting unmanaged
  symlinks, or editing native rule files.
- The configured target path could resolve outside the user's intended home or
  source repo assumptions and there is no validation boundary.
- The implementation starts treating `~/Projects`, `~/projects`, or another
  personal folder convention as a default scan root.
- Project-level scanning depends on remote/synced machine data, peer snapshots,
  or non-local machine ids.
- Existing report dashboard, sync, usage-store, or snapshot tests start failing
  for reasons unrelated to skills integration.
- The editor slice becomes necessary to complete the read-only or reconciliation
  slices. Defer it instead.

## Maintenance notes

- Keep "harness" reserved for usage-report collectors. Use "agent runtime" or
  "connector" for skill consumers.
- Keep skill inventory local-machine scoped. Multi-machine usage reporting can
  still exist elsewhere in `ai-usage`, but this feature should only inspect and
  mutate files available on the current machine.
- Do not encode the maintainer's personal folder layout as a product default.
  Any broad repository root scanning must be an explicit user configuration.
- Keep scanner limits configurable; personal skill repos may grow.
- Revisit target defaults after real local use, especially Cursor and GitHub
  Copilot system skill locations.
- A future plan should cover adoption/import flows for unmanaged target skills.
- A future plan should cover a safe skill editor with git diff after the core
  control plane is stable.
