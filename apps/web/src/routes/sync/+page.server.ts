import { loadSyncPageData } from '$lib/features/sync/sync-load';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, url }) =>
  await loadSyncPageData({ fetch, requestOwner: 'sync-root-ssr', url });
