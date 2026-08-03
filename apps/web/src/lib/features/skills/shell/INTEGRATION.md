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
