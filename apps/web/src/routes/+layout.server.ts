import { ORPCError } from '@orpc/client';
import { loadOptionalQuotaRail } from '#lib/features/shell/quota-load.ts';
import type { WebQueryHydrationState } from '#lib/query/client.ts';
import { createInProcessWebRpcClient } from '#lib/server/rpc/in-process-client.server.ts';
import type { LayoutServerLoad } from './$types';

const emptyQueryState: WebQueryHydrationState = { dehydratedState: { mutations: [], queries: [] } };

export const load: LayoutServerLoad = async ({ depends, isDataRequest, locals, request }) => {
  depends('ai-usage:provider-quota');
  const runtimeMode = locals.runtimeMode ?? 'live';
  if (isDataRequest || runtimeMode === 'demo') {
    return { quotaQueryState: emptyQueryState, runtimeMode };
  }
  const quotaQueryState = await loadOptionalQuotaRail({
    createRpc: () =>
      locals.quotaE2eFailure ? Promise.reject(new ORPCError('Unavailable')) : createInProcessWebRpcClient(request),
  });
  return {
    quotaQueryState,
    runtimeMode,
    ...(locals.quotaE2eFailure ? { quotaE2eFailure: true } : {}),
  };
};
