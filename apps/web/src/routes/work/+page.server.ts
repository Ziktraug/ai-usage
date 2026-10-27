import { deferredThreadPageData, loadThreadPageData } from '#lib/features/work/work-thread-load.ts';
import { createInProcessWebRpcClient } from '#lib/server/rpc/in-process-client.server.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ isDataRequest, locals, request, untrack, url }) => {
  const mode = locals.runtimeMode ?? 'live';
  return isDataRequest
    ? deferredThreadPageData(mode)
    : await loadThreadPageData(
        { rpc: await createInProcessWebRpcClient(request), url: untrack(() => new URL(url.href)) },
        mode,
      );
};
