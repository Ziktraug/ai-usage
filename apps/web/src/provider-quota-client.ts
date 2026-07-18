import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';

export interface ProviderQuotaSource {
  history(request: ProviderQuotaHistoryRequest, signal?: AbortSignal): Promise<ProviderQuotaHistoryResult>;
}

export const createServedProviderQuotaSource = (): ProviderQuotaSource => ({
  history: async (request) => {
    const { getProviderQuotaHistory } = await import('./server/provider-quota');
    return await getProviderQuotaHistory({ data: request });
  },
});
