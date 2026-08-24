import { createAwaitedRouteQueryState } from '$lib/features/shell/query-load';
import type { WebQueryHydrationState } from '$lib/query/client';
import { prefetchQuotaRail } from '$lib/query/options/quota';
import { createReportClient } from '$lib/rpc/report-client';
import type { LayoutServerLoad } from './$types';

const emptyQueryState: WebQueryHydrationState = { dehydratedState: { mutations: [], queries: [] } };

export const load: LayoutServerLoad = async ({ depends, fetch, isDataRequest, locals, untrack, url }) => {
  depends('ai-usage:provider-quota');
  const runtimeMode = locals.runtimeMode ?? 'live';
  if (isDataRequest || runtimeMode === 'demo') {
    return { quotaQueryState: emptyQueryState, runtimeMode };
  }
  const rpcBaseUrl = untrack(() => new URL(url.origin));

  const quotaQueryState = await createAwaitedRouteQueryState(
    { fetch, requestOwner: 'quota-rail-ssr', url: rpcBaseUrl },
    async (runtime) => await prefetchQuotaRail(runtime.queryClient, createReportClient(runtime.rpc)),
  );
  return {
    quotaQueryState,
    runtimeMode,
  };
};
