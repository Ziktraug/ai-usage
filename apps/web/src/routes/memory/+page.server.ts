import { redirect } from '@sveltejs/kit';
import { deferredMemoryPageData, loadMemoryPageData } from '$lib/features/memory/memory-load';
import { memoryCanonicalRedirect } from '$lib/features/memory/memory-url';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, isDataRequest, url }) => {
  const canonical = memoryCanonicalRedirect(url.href);
  if (canonical !== null) {
    redirect(307, canonical);
  }
  if (isDataRequest) {
    return deferredMemoryPageData();
  }
  return await loadMemoryPageData({ fetch, requestOwner: 'memory-root-ssr', url });
};
