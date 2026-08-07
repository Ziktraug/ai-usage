import { redirect } from '@sveltejs/kit';
import { untrack } from 'svelte';
import { loadSkillsShellRoute } from '$lib/features/skills/shell/data';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ fetch, parent, url }) => {
  const parentData = await parent();
  // This layout owns the long-lived Skills workspace. Child pathname changes are consumed by
  // `page.url` in the component and must not rebuild a request-scoped QueryClient on every skill.
  const initialUrl = untrack(() => new URL(url));
  const result = await loadSkillsShellRoute({
    mode: parentData.runtimeMode,
    options: {
      fetch: (request) => fetch(request),
      requestOwner: 'skills-shell-ssr',
      url: initialUrl,
    },
    pathname: initialUrl.pathname,
  });
  if (result.decision === 'redirect-report') {
    redirect(307, '/');
  }
  return { ...parentData, queryState: result.queryState, source: result.source };
};
