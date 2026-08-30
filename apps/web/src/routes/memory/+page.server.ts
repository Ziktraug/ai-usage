import { deferredMemoryPageData, loadMemoryPageData } from '$lib/features/memory/memory-load';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, isDataRequest, url }) => {
  if (isDataRequest) {
    return deferredMemoryPageData();
  }
  return await loadMemoryPageData({ fetch, requestOwner: 'memory-root-ssr', url });
};
