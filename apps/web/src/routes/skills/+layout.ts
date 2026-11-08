import { prefetchNavigationIntent } from '#lib/features/shell/intent-prefetch.ts';
import { prefetchSkillsShellQueries } from '#lib/features/skills/shell/data.ts';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ data, parent, url, untrack }) => {
  const { runtimeMode } = await untrack(() => parent());
  const pathname = untrack(() => url.pathname);
  if (runtimeMode !== 'demo') {
    await prefetchNavigationIntent(data.queryState, async (runtime) => {
      await prefetchSkillsShellQueries(runtime, pathname);
    });
  }
  return data;
};
