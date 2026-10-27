import { deferredWorkPageData, loadWorkPageData } from '#lib/features/work/work-load.ts';
import { createInProcessWebRpcClient } from '#lib/server/rpc/in-process-client.server.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ isDataRequest, locals, request, untrack, url }) => {
  const mode = locals.runtimeMode ?? 'live';
  return isDataRequest
    ? deferredWorkPageData(mode)
    : await loadWorkPageData(
        { rpc: await createInProcessWebRpcClient(request), url: untrack(() => new URL(url.href)) },
        mode,
      );
};
