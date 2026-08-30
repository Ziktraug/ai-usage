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

Global and configured projects are peer scopes in the left navigation tree.
The global scope overview is the decision surface: three verdict tiles (to
adopt, to delete, catalogue only) lead, a single links strip states link health
in one taxonomy — healthy · to link · to repair · blocked — and a joined
inventory table shows each managed skill's exposure marks, skill signals per
tier, last signal, and verdict on one row, followed by the project scopes with
their own invocation-evidence summaries. Selecting a project scope shows the
same join for that repo's skills. Selecting a managed global skill opens a
summary band — state, exposure, skill signals, verdict, and the skill's two operations —
above its canonical `SKILL.md`, which stays the dominant, directly editable
document without a separate preview or Edit mode. Save is explicit through the
visible button or `Ctrl+S` / `Cmd+S`; there is no autosave. A successful Save
writes only the source repository and leaves the document editable. It never
installs, repairs, enables, disables, or otherwise reconciles a runtime
projection.

The right panel becomes the selected global document's Inspector. It contains
validation and grouped diagnostics, document token and invocation metadata,
source identity, enabled state, and exposure in each configured runtime — the
facts. Runtime Install or Repair and source Enable or Disable live in the
summary band above the editor, one place at every viewport width, separate from
document Save. Project-owned skills keep their read-only `SKILL.md` view until
an adoption workflow provides a canonical source document. Their detail opens
on a read-only synthesis band instead: project placement, name-scoped observed
use, last observation, and a collision-safe verdict. It never exposes the
global source toggle or reconciliation actions for a project-owned document.

The skills-by-runtimes matrix remains available as a secondary exposure view.
Status dots are used inside matrix cells where the runtime column gives them
context, but the matrix is not the default object model of the page.

Unmanaged runtime entries are shown as a grouped, collapsed consolidation
backlog. They are never rendered as a flat list; adopting or importing them into
the source repository is future work.

Disabling a skill is a first-class toggle. It never requires moving files by
hand, and the UI keeps disabled skills visible in a collapsed shelf.

Health is reported as separate counters in one taxonomy everywhere: healthy
links, to link, to repair, blocked, to consolidate, and disabled. The matrix
states them as tiles that count links; the skill-count filter chips beside the
matrix are labelled as counting skills, so the same word never carries two
numbers without its unit. The UI does not merge those signals into one "needs
attention" number.

Skill consumers are called runtimes in UI copy and docs. "Harness" remains
reserved for usage-report collectors — which is exactly why skill signals are
reported per *harness*: they come from the collectors, not from the projection
targets.

Skill observations are a second axis on the same inventory, so they render
joined to it rather than beside it. The landing page's verdict tiles and joined
inventory table are the first surface; the matrix and skill details both carry
a "Skill observations" section. Every count states its observation tier
(`declared`, `inferred`, `exposed`) and the harness that produced it, and the
tiers are never added together. `declared` and `inferred` are invocation
evidence; `exposed` is availability only. The panel's table lists managed names
and names with invocation evidence, strongest evidence first and most recent
signal first; signal dates older than ninety days carry a textual `stale`
marker. Cursor records nothing about skill observations, so it renders as *not
observable* rather than as a zero — stated once per surface in the coverage
roster, never repeated as a column of identical cells. Three verdicts get their
own groups. *Projected everywhere, no invocation recorded* contains deletion
candidates only when invocation history is complete: managed skills installed
in every enabled runtime with no recorded invocation. *Invocation evidence,
unmanaged* contains adoption candidates, listed by residence in three
sub-groups: names installed in runtime directories (the adoptable backlog),
names shipped by a harness or plugin, and names owned by a project repository —
whose verdict sentence names that ownership instead of prescribing adoption.
*Available to a model, no invocation recorded* contains names whose only signal is a catalogue
listing: a harness injects its whole catalogue, so being in one says nothing
about use, and the group folds to one expandable row per catalogue. When
invocation history is bounded, partially unreadable, rejected, skipped, or not
yet established by the first producer sweep, absence-derived verdicts instead
say *no invocation in loaded history* and remain provisional. Exposure-only
incompleteness does not weaken an otherwise complete invocation verdict.
Adopting an unmanaged skill with invocation evidence into the source repository
remains future work, as above.

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
