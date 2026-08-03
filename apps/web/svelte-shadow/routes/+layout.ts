import { createWebQueryLoadState } from '$lib/query/composition';
import type { LayoutLoad } from './$types';

export const trailingSlash = 'never';

export const load: LayoutLoad = ({ data, fetch, url }) => ({
  ...data,
  queryState: createWebQueryLoadState({ fetch, url }),
});
