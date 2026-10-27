import { redirect } from '@sveltejs/kit';
import { deferredSkillsShellRoute, loadSkillsShellRoute } from '#lib/features/skills/shell/data.ts';
import { createInProcessWebRpcClient } from '#lib/server/rpc/in-process-client.server.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ isDataRequest, parent, request, url }) => {
  const { runtimeMode } = await parent();
  if (runtimeMode === 'demo') {
    redirect(307, '/');
  }

  // A document request receives complete, bounded SSR data. SPA entry must not reacquire
  // Skills before routing: the persistent root QueryClient serves fresh cache immediately
  // and mounted observers revalidate stale or missing resources in the background.
  const result = isDataRequest
    ? deferredSkillsShellRoute()
    : await loadSkillsShellRoute({
        mode: runtimeMode,
        options: { rpc: await createInProcessWebRpcClient(request) },
        pathname: url.pathname,
      });

  if (result.decision === 'redirect-report') {
    redirect(307, '/');
  }

  return { queryState: result.queryState, source: result.source };
};
