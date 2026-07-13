# Skill Management

`ai-usage` owns a native skill-management control plane exposed through the web
route `/skills`. The feature is separate from usage reporting: it inspects and
reconciles local Agent Skill files, but it does not use snapshots from other
machines, manually imported rows, or non-local machine ids
to decide which repositories or runtime targets to scan.

## Package Boundary

`@ai-usage/skills` owns the skill-management domain:

- skill-management config types;
- JSON source-state parsing and persistence;
- source repository scans and `SKILL.md` validation;
- agent-runtime target scans;
- projection planning and apply logic;
- diagnostics;
- workflow functions used by app adapters.

`apps/web` owns the `/skills` UI, route loaders, and TanStack Start server
function facades only. Filesystem access and mutation rules stay behind
`@ai-usage/skills` workflows and server-only web modules.

## Storage

User-local skill configuration lives in the existing ai-usage config file:

```text
~/.config/ai-usage/config.json
```

That file is read and written through the existing local collector config path.
Portable source repository state lives inside the configured source repository
as JSON data, not executable TypeScript:

```text
<sourceRepoPath>/.skill-tracker/state.json
```

## Discovery Rules

Skill inventory is local-machine only. Project and repository discovery combines
explicit `projectPaths` config with one focused known-local-project-sources query.
That query reads only locally observed project rows and returns project sources,
groups, and warnings; it does not create a complete report payload or consult
manually imported rows. There is no default broad scan root such as
`~/Projects`, `~/projects`, or any other personal directory convention. Broad
root scans must be explicit opt-in configuration.

Discovered paths are curated before they become project scopes. The home
directory is never treated as a project, even when it contains global runtime
skill directories. A discovered directory must look like a project root: either
it has a `.git` entry (directory or worktree file) or it contains at least one
project runtime skill directory such as `.claude/skills` or `.agents/skills`.
Workspace container folders without those markers are ignored, and so are
paths under tool data directories (`~/.local/share`, `~/.cache`) such as
agent-managed worktrees, even when they carry a `.git` marker.

Configuration remains sovereign. Any path explicitly listed in
`skillsConfig.projectPaths` is scanned even if the discovery curation rules
would have ignored it.

Native rule formats for tools such as Cursor, Copilot, or project-specific rule
files are read-only diagnostics in this integration. Managed mutations are
limited to safe skill target reconciliation.

## UI design

The `/skills` route is a multi-axis inventory of Agent Skills on this machine.
It distinguishes global and project-owned scope, auto-invocable and manual
skills, personal or installed origins when metadata is present, enabled and
disabled state, and per-runtime exposure as linked, copied, missing, or broken.

For a managed global skill, the primary presentation follows the authoring
flow:

```text
Draft -> Source repository -> Runtimes
```

Global and configured projects are peer scopes in the left navigation tree.
Selecting a scope shows an overview. Selecting a managed global skill opens its
canonical `SKILL.md` as the dominant, directly editable document without a
separate preview or Edit mode. Save is explicit through the visible button or
`Ctrl+S` / `Cmd+S`; there is no autosave. A successful Save writes only the
source repository and leaves the document editable. It never installs, repairs,
enables, disables, or otherwise reconciles a runtime projection.

The right panel becomes the selected global document's Inspector. It contains
validation and grouped diagnostics, document token and invocation metadata,
source identity, enabled state, and exposure in each configured runtime. Runtime
Install or Repair and source Enable or Disable remain explicit actions in that
Inspector, separate from document Save. Project-owned skills keep their
read-only `SKILL.md` view until an adoption workflow provides a canonical source
document.

The skills-by-runtimes matrix remains available as a secondary exposure view.
Status dots are used inside matrix cells where the runtime column gives them
context, but the matrix is not the default object model of the page.

Unmanaged runtime entries are shown as a grouped, collapsed consolidation
backlog. They are never rendered as a flat list; adopting or importing them into
the source repository is future work.

Disabling a skill is a first-class toggle. It never requires moving files by
hand, and the UI keeps disabled skills visible in a collapsed shelf.

Health is reported as separate counters: healthy links, to repair, to
consolidate, and disabled. The UI does not merge those signals into one "needs
attention" number.

Skill consumers are called runtimes in UI copy and docs. "Harness" remains
reserved for usage-report collectors.

Bulk runtime reconciliation remains preview-first and is distinct from saving a
source document. "Reconcile all…" plans the actions server-side without mutating
anything and shows the exact list — actions to apply and refused unmanaged
mutations with their reasons — before the user confirms with "Apply". Applying
re-plans from a fresh snapshot; per-action safety rules in the workflow remain
the real mutation guard. Warning-status skills stay reconciliable; only
structurally invalid skills are refused.
