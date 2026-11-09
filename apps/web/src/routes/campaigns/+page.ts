import { prefetchCampaignsRoute } from '#lib/features/campaigns/campaigns-load.ts';
import { prefetchNavigationIntent } from '#lib/features/shell/intent-prefetch.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ data, url, untrack }) => {
  const target = untrack(() => new URL(url.href));
  if (data.mode === 'live') {
    await prefetchNavigationIntent(data.queryState, (runtime) => prefetchCampaignsRoute(runtime, target, data.mode));
  }
  return data;
};
