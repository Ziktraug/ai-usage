# P5 Skills shell integration request

P5 deliberately does not edit coordinator-owned route files. At X0, compose the
accepted shell with these bounded changes.

## Await Skills data in the route layout

Add `apps/web/svelte-shadow/routes/skills/+layout.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import { loadSkillsShellRoute } from '$lib/features/skills/shell/data';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ fetch, parent, url }) => {
  const parentData = await parent();
  const result = await loadSkillsShellRoute({
    mode: parentData.runtimeMode,
    options: {
      fetch: (request) => fetch(request),
      requestOwner: 'skills-shell-ssr',
      url,
    },
    pathname: url.pathname,
  });
  if (result.decision === 'redirect-report') {
    redirect(307, '/');
  }
  return { ...parentData, queryState: result.queryState };
};
```

The root query provider already reads `page.data.queryState`, so this preserves
the awaited cache for SSR and hydration without adding another provider or
request owner. The early demo decision is defense in depth after the existing
server hook and must stay before runtime construction.

## Render one workspace for every nested Skills leaf

Replace the body of
`apps/web/svelte-shadow/routes/skills/+layout.svelte` with:

```svelte
<script lang="ts">
  import { page } from '$app/state';
  import SkillsShell from '$lib/features/skills/shell/skills-shell.svelte';
  import RouteFrame from '$lib/features/shell/route-frame.svelte';
  import type { LayoutProps } from './$types';

  let { data }: LayoutProps = $props();
</script>

<RouteFrame heading="Skill management">
  <SkillsShell pathname={page.url.pathname} runtimeMode={data.runtimeMode} />
</RouteFrame>
```

Keep the existing nested route directories because they own addressability and
parameter typing. Their marker-only page bodies do not need to render once the
layout owns the workspace. P9 and P10 replace the shell's `editorSlot`,
`healthSlot`, and `matrixSlot` composition at X0; P5 must not implement those
behaviors. Remove the temporary R1 dirty-navigation fixture only when P9's real
blocker is composed.

## Frozen slot contract

Import `SkillsShellSlotContext` from
`$lib/features/skills/shell/slot-context`. All three slots receive that exact
context:

- `editorSlot(context)` is P9-owned. On mount it calls
  `context.snapshotUpdates.registerDraft(guard)` and its cleanup calls
  `unregisterDraft(guard)` with the same guard identity.
- When `context.snapshotUpdates.pendingDecision` exists, P9 renders the
  keep/discard decision. `keep()` retains the dirty document, `discard()`
  awaits the draft discard and applies the pending Query snapshot, and
  `focus()` returns focus to the registered editor.
- `healthSlot(context)` and `matrixSlot(context)` are P10-owned. They consume
  `context.snapshot` and publish mutation snapshots through the canonical
  Skills Query cache; they do not create another snapshot owner.

P9's focused integration test must register a dirty real editor guard, update
the canonical `skillsSnapshotKey()` cache with a snapshot that removes its
skill, and assert retain, focus, awaited discard, and identity-safe unregister.
P10's focused integration tests must render both slots with this unchanged
context and assert that a smallest-key snapshot update is observed by the
shipped shell. P9/P10 must not edit P5 shell files to add these capabilities.

P5 freezes the route request above with
`skills-workspace.ssr.test.ts`: the test runs the bounded awaited loader through
the real oRPC HTTP handler, dehydrates its isolated client, creates a new
`WebQueryProvider`, renders `SkillsShell`, and proves settled HTML with no
second Skills acquisition. X0 should preserve that test unchanged while
applying the two route files exactly as requested.
