import { prefetchNavigationIntent } from '#lib/features/shell/intent-prefetch.ts';
import { prefetchWorkRoute } from '#lib/features/work/work-load.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ data, url, untrack }) => {
  const target = untrack(() => new URL(url.href));
  if (data.mode !== 'demo') {
    await prefetchNavigationIntent(data.queryState, async (runtime) => {
      await prefetchWorkRoute(runtime, target, data.mode);
    });
  }
  return data;
};
