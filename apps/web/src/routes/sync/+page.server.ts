import { deferredSyncPageData, loadSyncPageData } from '$lib/features/sync/sync-load';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, isDataRequest, url }) => {
  // A document request gets a complete SSR fleet. On SPA entry the root QueryClient either serves
  // its still-fresh fleet immediately or lets the mounted query revalidate without blocking routing.
  if (isDataRequest) {
    return deferredSyncPageData();
  }
  return await loadSyncPageData({ fetch, requestOwner: 'sync-root-ssr', url });
};
