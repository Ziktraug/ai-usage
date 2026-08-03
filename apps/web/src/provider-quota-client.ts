import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import { createReportClient } from './lib/rpc/report-client';
import { resolveSolidWebRpcClient } from './lib/rpc/solid-client';

export interface ProviderQuotaSource {
  history(request: ProviderQuotaHistoryRequest, signal?: AbortSignal): Promise<ProviderQuotaHistoryResult>;
}

export const createServedProviderQuotaSource = (): ProviderQuotaSource => ({
  history: async (request, signal) => {
    const client = createReportClient(await resolveSolidWebRpcClient());
    return await client.getProviderQuotaHistory(request, signal === undefined ? {} : { signal });
  },
});
