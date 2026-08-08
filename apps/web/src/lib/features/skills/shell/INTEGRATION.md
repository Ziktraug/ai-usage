# Canonical Skills shell integration

`apps/web/src/routes/skills/+layout.server.ts` redirects demo mode before any
acquisition. A document request awaits `loadSkillsShellRoute` with the stable
`skills-shell-ssr` owner and dehydrates snapshot, known paths, configured
inventories, and the selected document under their canonical finite-SWR keys.
Hydration therefore performs no duplicate acquisition.

A SvelteKit data request returns an empty hydration delta. The persistent root
Query client serves fresh Skills data immediately and revalidates stale or
missing entries through the mounted observers without a route-owned client.

`apps/web/src/routes/skills/+layout.svelte` renders one `SkillsShell` inside the
shared `RouteFrame`. Nested Skills route leaves retain addressability and typed
parameters; the layout owns the workspace. The root query provider remains the
only Query client owner.

The layout composes the frozen `SkillsShellSlotContext` once across these slots:

- `editorSlot` renders `SkillsEditorSlot`.
- `healthSlot` renders `SkillsHealthSlot`.
- `matrixSlot` renders `SkillsMatrixSlot`.

All slots consume the same canonical snapshot and publish mutation results
through its Query cache. They do not create another snapshot owner. Draft
navigation registers and unregisters one identity-stable guard. Keeping a draft
retains and refocuses it; discarding awaits cleanup before committing the
pending snapshot. The shared shell remains the sole owner of route, history,
and before-unload decisions.
