import type { WebContractClient } from '@ai-usage/web-contract';
import type { WebQueryHydrationState } from '../../query/client';
import { prefetchQuotaRail, type QuotaQueryClient } from '../../query/options/quota';
import { createReportClient } from '../../rpc/report-client';
import { reportUnexpectedPrefetchFailure } from './prefetch-errors';
import { createAwaitedRouteQueryState } from './query-load';

/** Optional data (plan 068, SSR rule 7): a quota outage must never replace a document with a 500.
 * Failed queries are not dehydrated; the browser retries and renders its own unavailable state.
 * Defects are reported on the server too, but the independent application remains usable.
 */
export const loadOptionalQuotaRail = async (input: {
  readonly createRpc: () => Promise<WebContractClient>;
  readonly createClient?: (rpc: WebContractClient) => QuotaQueryClient;
}): Promise<WebQueryHydrationState> => {
  try {
    const rpc = await input.createRpc();
    return await createAwaitedRouteQueryState({ rpc }, async (runtime) => {
      await prefetchQuotaRail(runtime.queryClient, input.createClient?.(rpc) ?? createReportClient(rpc));
    });
  } catch (cause) {
    reportUnexpectedPrefetchFailure(cause);
    return { dehydratedState: { mutations: [], queries: [] } };
  }
};
