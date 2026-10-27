import { createAwaitedRouteQueryState } from '#lib/features/shell/query-load.ts';
import type { WebQueryHydrationState } from '#lib/query/client.ts';
import { prefetchQuotaRail } from '#lib/query/options/quota.ts';
import { createReportClient } from '#lib/rpc/report-client.ts';
import { createInProcessWebRpcClient } from '#lib/server/rpc/in-process-client.server.ts';
import type { LayoutServerLoad } from './$types';

const emptyQueryState: WebQueryHydrationState = { dehydratedState: { mutations: [], queries: [] } };

export const load: LayoutServerLoad = async ({ depends, isDataRequest, locals, request }) => {
  depends('ai-usage:provider-quota');
  const runtimeMode = locals.runtimeMode ?? 'live';
  if (isDataRequest || runtimeMode === 'demo') {
    return { quotaQueryState: emptyQueryState, runtimeMode };
  }
  const quotaQueryState = await createAwaitedRouteQueryState(
    { rpc: await createInProcessWebRpcClient(request) },
    async (runtime) => await prefetchQuotaRail(runtime.queryClient, createReportClient(runtime.rpc)),
  );
  return {
    quotaQueryState,
    runtimeMode,
  };
};
