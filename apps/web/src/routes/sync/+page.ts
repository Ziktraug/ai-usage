import { prefetchNavigationIntent } from '#lib/features/shell/intent-prefetch.ts';
import { prefetchSyncRoute } from '#lib/features/sync/sync-load.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ data, parent, untrack }) => {
  const { runtimeMode } = await untrack(() => parent());
  if (runtimeMode !== 'demo') {
    await prefetchNavigationIntent(data.queryState, prefetchSyncRoute);
  }
  return data;
};
