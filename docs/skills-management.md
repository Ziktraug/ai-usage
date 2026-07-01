# Skill Management

`ai-usage` owns a native skill-management control plane exposed through the web
route `/skills`. The feature is separate from usage reporting: it inspects and
reconciles local Agent Skill files, but it does not use usage rows, synced
snapshots, peer data, remote machine ids, or LAN merge state to decide which
repositories or runtime targets to scan.

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

Skill inventory is local-machine only. Project and repository discovery may use
explicit `projectPaths` config and locally observed project paths, but it must not use synced
rows or remote machine data. There is no default broad scan root such as
`~/Projects`, `~/projects`, or any other personal directory convention. Broad
root scans must be explicit opt-in configuration.

Native rule formats for tools such as Cursor, Copilot, or project-specific rule
files are read-only diagnostics in this integration. Managed mutations are
limited to safe skill target reconciliation.
