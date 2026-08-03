import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';

export interface ProviderQuotaSource {
  history(request: ProviderQuotaHistoryRequest, signal?: AbortSignal): Promise<ProviderQuotaHistoryResult>;
}

export const createServedProviderQuotaSource = (): ProviderQuotaSource => ({
  history: async (request, signal) => {
    const { resolveSolidReportClient } = await import('./lib/rpc/solid-client');
    const client = await resolveSolidReportClient();
    return await client.getProviderQuotaHistory(request, signal === undefined ? {} : { signal });
  },
});
