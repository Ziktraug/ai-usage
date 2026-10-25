import { deferredThreadPageData, loadThreadPageData } from '#lib/features/work/work-thread-load.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, isDataRequest, locals, untrack, url }) => {
  const mode = locals.runtimeMode ?? 'live';
  return isDataRequest
    ? deferredThreadPageData(mode)
    : await loadThreadPageData(
        { fetch, requestOwner: 'work-threads-ssr', url: untrack(() => new URL(url.href)) },
        mode,
      );
};
