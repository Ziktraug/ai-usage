# P6 Sources integration request

Ownership of the root layout, shared shell and route leaves remains with the
coordinator. Integrate this feature exactly once as follows:

1. In `svelte-shadow/routes/+layout.svelte`, import
   `SourceControlProvider` from
   `$lib/features/sources/source-control-provider.svelte`.
2. Inside the existing `WebQueryProvider`, wrap the single root `AppShell` and
   its children with
   `<SourceControlProvider runtimeMode={data.runtimeMode}>`. The Query provider
   must stay outside so publication events can invalidate the two current
   Report aliases.
3. Add a single optional `sourceControlSummary: Snippet` composition prop to
   the coordinator-owned `AppShell` in
   `apps/web/src/lib/features/shell/app-shell.svelte`, and forward that exact
   prop to its existing `AppNavigation` child.
4. Add the same `sourceControlSummary: Snippet` prop to the coordinator-owned
   `AppNavigation` in
   `apps/web/src/lib/features/shell/app-navigation.svelte`. Invoke the snippet
   exactly once in each mutually exclusive responsive branch: on desktop,
   between the `Manage destinations` navigation and `railFooter`; on mobile,
   inside `managePopover` after the management destination links and before
   `ThemeToggle`. Do not render it in demo mode, where `showManage` is false.
5. In `apps/web/svelte-shadow/routes/+layout.svelte`, import exactly one
   `SourceControlSummary` from
   `$lib/features/sources/source-control-summary.svelte`, define one
   `sourceControlSummary` snippet beneath `SourceControlProvider`, and pass
   that snippet to the single `AppShell`. This keeps the summary below the
   provider while leaving navigation placement owned by `AppNavigation`.
6. Replace the marker-only `/sources` route content with exactly one
   `SourcesPage` from `$lib/features/sources/sources-page.svelte`. `SourcesPage`
   owns its `main` landmark and heading; do not wrap it in `RouteFrame`.

Do not create a second `SourceControlProvider`, source-control service,
EventSource subscription or summary instance. The root provider is the sole
owner of start, reconnect, publication invalidation and disposal for both the
summary and Sources page.

## Required framework-neutral presentation convergence

P6's write allowlist excludes the legacy Solid owner
apps/web/src/source-control-presentation.ts. Before accepting the P6 checkpoint
or composing X0, the coordinator must perform this exact mechanical
convergence:

1. Move the pure SourcePresentation, SourcePresentationTone,
   SourceProgressPresentation, presentSourceProgress, and presentSourceState
   declarations from lib/features/sources/presentation-model.ts to the
   framework-neutral apps/web/src/source-control-presentation-model.ts.
2. Update the legacy source-control-presentation.ts to import and re-export
   those declarations from the neutral owner. Keep only its existing
   design-system /report tone-to-class mapping local.
3. Update P6 presentation.ts and model.ts to import/re-export the same neutral
   owner, keep only the Svelte tone-to-class mapping local, and delete the
   temporary P6-owned model file.
4. Preserve presentation-model.test.ts as an explicit accepted-product parity
   proof until the legacy Solid route is retired; after the move, both suites
   must import the single neutral owner.

This is a source move only: copy, precedence, labels, explanations, progress
bounds, and CSS classes must not change. Re-run both presentation suites, the
P6 recursive client closure, Web typecheck/Svelte check, and the shadow build.
