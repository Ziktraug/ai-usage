import { deferredDelegationPageData, loadDelegationPageData } from '#lib/features/delegation/delegation-load.ts';
import { createInProcessWebRpcClient } from '#lib/server/rpc/in-process-client.server.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ isDataRequest, request, url }) => {
  if (isDataRequest) {
    return deferredDelegationPageData(url);
  }
  return await loadDelegationPageData({ rpc: await createInProcessWebRpcClient(request), url });
};
