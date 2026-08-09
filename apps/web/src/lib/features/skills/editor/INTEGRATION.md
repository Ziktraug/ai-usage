# Canonical Skills editor integration

`apps/web/src/routes/skills/+layout.svelte` imports `SkillsEditorSlot` and passes
one `editorSlot` snippet to the sole `SkillsShell`. The root
`WebQueryProvider` supplies the canonical Query client and `AppShell` supplies
the sole dirty-navigation registry. Nested pages, including
`apps/web/src/routes/skills/global/[skillName]/+page.svelte`, remain addressable
route leaves and do not create another editor or acquisition owner.

The editor slot registers one identity-stable draft guard on mount and removes
that same guard during cleanup. A confirmed save updates only the exact managed
Markdown and Skills snapshot query keys. Keeping a pending draft retains and
refocuses that draft. Discarding is awaited before the pending snapshot commits;
buttons remain disabled while it is pending, and Escape cannot close the
confirmation dialog.

Health and matrix slots share the same frozen `SkillsShellSlotContext`; they do
not wrap or replace the editor slot. The shared shell navigation blocker remains
the only owner of route, history, and before-unload decisions.
