import { createWebQueryLoadState } from '$lib/query/composition';
import type { LayoutLoad } from './$types';

export const trailingSlash = 'never';

export const load: LayoutLoad = ({ data, fetch, untrack, url }) => {
  const rpcBaseUrl = untrack(() => new URL(url.origin));
  return {
    ...data,
    queryState: createWebQueryLoadState({ fetch, url: rpcBaseUrl }),
  };
};
