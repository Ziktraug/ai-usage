import { deferredDelegationPageData, loadDelegationPageData } from '#lib/features/delegation/delegation-load.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, isDataRequest, url }) => {
  if (isDataRequest) {
    return deferredDelegationPageData(url);
  }
  return await loadDelegationPageData({ fetch, requestOwner: 'delegation-root-ssr', url });
};
