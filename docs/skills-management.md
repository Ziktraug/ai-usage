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

`apps/web` owns the SvelteKit `/skills` UI and its oRPC transport adapters only.
The route layout awaits the Skills snapshot, dehydrates the canonical query
state, and renders settled initial HTML; hydration reuses that state without a
duplicate acquisition. Filesystem access and mutation rules stay behind
`@ai-usage/skills` workflows and server-only web modules reached through the
explicit Web RPC boundary.

Within the browser, the shell builds one immutable presentation projection from
the accepted Query results and passes it to every Skills renderer. One
shell-lived management-operation episode owns the Query mutation observer,
contract dispatch, cache publication and invalidation, pending state, reconcile
plan, and placement-scoped outcome. Configuration drafts remain local to their
form and TanStack Query remains the only owner of server state.

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

`/skills` has one worktable rather than separate tree, overview, Inspector, and
matrix surfaces. Its filter strip keeps All, To adopt, Links healthy, To delete,
and Catalogue only on the same table. Rows are grouped by the decision they
support: Managed, To adopt, Projects, and Catalogue only. Each runtime or
harness column joins its placement mark with that harness's invocation evidence;
recorded and reconstructed counts remain visibly distinct and are never added.
Project repositories are one expandable summary row each. A durable
project-owned observation remains in its repository group even when the current
inventory no longer carries that skill.

Selecting a managed or project-owned skill opens a non-modal drawer over the
worktable while the URL remains the selection authority. The drawer carries
placement, name-scoped observation evidence, validation findings, and the
document. A managed `SKILL.md` is directly editable without a preview-first
mode; Save is explicit through the visible button or `Ctrl+S` / `Cmd+S`, never
autosave. Saving updates only the source repository and never reconciles a
runtime projection. Runtime Link or Repair and source Enable or Disable are
separate controls in the drawer or worktable. Project-owned documents remain
read-only until a separate adoption workflow creates a canonical source
document.

The retired `/skills/matrix`, `/skills/global`, and project-scope pages redirect
to the worktable. Per-skill URLs remain drawer destinations. Configuration and
the grouped unmanaged-runtime backlog live in folds below the table, so retiring
the matrix removes no operation or diagnostic destination.

Unmanaged runtime entries are shown as a grouped, collapsed consolidation
backlog. They are never rendered as a flat list; adopting or importing them into
the source repository is future work.

Disabling a skill is a first-class toggle. It never requires moving files by
hand, and the UI keeps disabled skills visible in the Managed group with their
invocation history and without a placement claim.

Health remains separate from invocation evidence. The Links healthy filter
states healthy links over expected links, while To adopt, To delete, and
Catalogue only count skill names under their own evidence rules. The UI does
not merge those signals into one "needs attention" number.

Skill consumers are called runtimes in UI copy and docs. "Harness" remains
reserved for usage-report collectors — which is exactly why skill signals are
reported per *harness*: they come from the collectors, not from the projection
targets.

Skill observations are a second axis on the same inventory, so they render in
the worktable cells and drawer rather than beside placement. A plain number is
a `declared` invocation and a tilde-prefixed number is an `inferred` one;
accessible text spells out both tiers and their harness. `exposed` remains
availability only and is folded into Catalogue only or described in the drawer.
Signal dates older than ninety days carry a textual `stale` marker. Cursor
records nothing, so it is stated once as *not observable* and never rendered as
a zero.

Managed skills installed in every enabled runtime with no invocation evidence
form the To delete population only when the invocation proof is current and
complete. Runtime-installed unmanaged names with invocation evidence form To
adopt; harness- and plugin-owned names remain visible as upstream evidence; and
project-owned names stay in their repository group. When invocation history is
bounded, partially unreadable, rejected, skipped, stale, or being refreshed,
positive observations remain visible while every absence-derived verdict says
*no invocation in loaded history* and remains provisional. Count caveats name
only the affected harness and tier; exposure-only incompleteness does not weaken
an otherwise complete invocation verdict. Adopting unmanaged evidence into the
source repository remains future work.

See [ADR 0022](adr/0022-skill-observation-tiers-and-observability.md) for the
invariants and `docs/skills-management-spec.md` for the per-harness coverage
table.

Bulk runtime reconciliation remains preview-first and is distinct from saving a
source document. "Reconcile all…" plans the actions server-side without mutating
anything and shows the exact list — actions to apply and refused unmanaged
mutations with their reasons — before the user confirms with "Apply". Applying
re-plans from a fresh snapshot; per-action safety rules in the workflow remain
the real mutation guard. Warning-status skills stay reconciliable; only
structurally invalid skills are refused.
