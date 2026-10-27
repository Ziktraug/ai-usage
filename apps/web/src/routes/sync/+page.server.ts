import { deferredSyncPageData, loadSyncPageData } from '#lib/features/sync/sync-load.ts';
import { createInProcessWebRpcClient } from '#lib/server/rpc/in-process-client.server.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ isDataRequest, request }) => {
  // A document request gets a complete SSR fleet. On SPA entry the root QueryClient either serves
  // its still-fresh fleet immediately or lets the mounted query revalidate without blocking routing.
  if (isDataRequest) {
    return deferredSyncPageData();
  }
  return await loadSyncPageData({ rpc: await createInProcessWebRpcClient(request) });
};
