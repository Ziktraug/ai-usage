# P9 Skills editor integration request

X0 owns the SvelteKit route files and must compose this packet together with
P5's Skills shell request. Do not move editor state into a route or create a
second Query/snapshot owner.

In `apps/web/svelte-shadow/routes/skills/+layout.svelte`, import
`SkillsEditorSlot` from
`$lib/features/skills/editor/skills-editor-slot.svelte` and the frozen
`SkillsShellSlotContext` type from
`$lib/features/skills/shell/slot-context`. Pass one snippet to P5's sole
`SkillsShell`:

```svelte
{#snippet editorSlot(context: SkillsShellSlotContext)}
  <SkillsEditorSlot {context} />
{/snippet}

<SkillsShell {editorSlot} pathname={page.url.pathname} runtimeMode={data.runtimeMode} />
```

P10 may add `healthSlot` and `matrixSlot` to that same `SkillsShell`; it must not
wrap or replace `editorSlot`. The root `WebQueryProvider` supplies the canonical
Query client and `AppShell` supplies the sole dirty-navigation registry.

Once the real editor slot is composed, remove the temporary
`DirtyNavigationFixture` from
`apps/web/svelte-shadow/routes/skills/global/[skillName]/+page.svelte`. The
nested page remains an addressable marker with no editor or acquisition.

The slot registers one identity-stable draft guard on mount, unregisters that
same identity on cleanup, updates only the exact managed-markdown and snapshot
Query keys after a confirmed save, and renders P5's pending snapshot decision.
Keep retains and refocuses the exact draft. Discard is awaited before the
pending snapshot commits; while it is pending, buttons are disabled and Escape
cannot close the dialog. The shared shell navigation blocker handles route,
history, and before-unload decisions through this real guard.

After applying the coordinator delta, preserve P5's settled SSR/no-duplicate
acquisition test and run P9's controller, SSR, closure, Svelte, boundary, and
parity gates. X0 owns the process-level Skills navigation/reload cases.
