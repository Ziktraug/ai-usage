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
  return { ...parentData, queryState: result.queryState, source: result.source };
};
