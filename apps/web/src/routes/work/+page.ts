import { prefetchNavigationIntent } from '#lib/features/shell/intent-prefetch.ts';
import { prefetchThreadsRoute } from '#lib/features/work/work-thread-load.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ data, url, untrack }) => {
  const target = untrack(() => new URL(url.href));
  if (data.mode !== 'demo') {
    await prefetchNavigationIntent(data.queryState, (runtime) => prefetchThreadsRoute(runtime, target));
  }
  return data;
};
