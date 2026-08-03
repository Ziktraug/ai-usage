# Canonical Skills shell integration

`apps/web/src/routes/skills/+layout.ts` awaits `loadSkillsShellRoute` with the
parent runtime mode, route `fetch`, current URL, stable `skills-shell-ssr`
request owner, and current pathname. Demo mode redirects to `/` before runtime
construction. The loader returns dehydrated canonical Skills query state so SSR
renders settled content and hydration does not acquire the snapshot again.

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
