import { deferredWorkPageData, loadWorkPageData } from '$lib/features/work/work-load';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, isDataRequest, locals, untrack, url }) => {
  const mode = locals.runtimeMode ?? 'live';
  return isDataRequest
    ? deferredWorkPageData(mode)
    : await loadWorkPageData({ fetch, requestOwner: 'work-root-ssr', url: untrack(() => new URL(url.href)) }, mode);
};
