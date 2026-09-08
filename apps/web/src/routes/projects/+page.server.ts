import { deferredProjectsPageData, loadProjectsPageData } from '$lib/features/projects/projects-load';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, isDataRequest, url }) => {
  if (isDataRequest) {
    return deferredProjectsPageData();
  }
  return await loadProjectsPageData({ fetch, requestOwner: 'projects-root-ssr', url });
};
