import { createWebQueryLoadState } from '$lib/query/composition';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = ({ fetch, url }) => ({
  queryState: createWebQueryLoadState({
    fetch,
    url,
  }),
});
