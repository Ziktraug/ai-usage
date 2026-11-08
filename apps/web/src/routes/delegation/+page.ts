import { prefetchDelegationRoute } from '#lib/features/delegation/delegation-load.ts';
import { prefetchNavigationIntent } from '#lib/features/shell/intent-prefetch.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ data, parent, untrack }) => {
  const { runtimeMode } = await untrack(() => parent());
  if (runtimeMode !== 'demo') {
    await prefetchNavigationIntent(data.queryState, prefetchDelegationRoute);
  }
  return data;
};
