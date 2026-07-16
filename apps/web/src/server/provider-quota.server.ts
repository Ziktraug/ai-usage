import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import { runProviderQuotaHistoryForServer } from './provider-quota-history-runner.server';

export const getProviderQuotaHistoryForServer = (
  request: ProviderQuotaHistoryRequest,
): Promise<ProviderQuotaHistoryResult> => runProviderQuotaHistoryForServer(request);
