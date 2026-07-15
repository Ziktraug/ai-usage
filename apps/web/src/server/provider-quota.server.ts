import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import type { ProviderQuotaRefreshResult } from '@ai-usage/report-data/provider-quota';
import { runProviderQuotaHistoryForServer, runProviderQuotaRefreshForServer } from './provider-quota-runner.server';

let refreshInFlight: Promise<ProviderQuotaRefreshResult> | null = null;

export interface ProviderQuotaServerCoordinator {
  history(request: ProviderQuotaHistoryRequest): Promise<ProviderQuotaHistoryResult>;
  refresh(): Promise<ProviderQuotaRefreshResult>;
}

export const createProviderQuotaServerCoordinator = (options: {
  history: (request: ProviderQuotaHistoryRequest) => Promise<ProviderQuotaHistoryResult>;
  refresh: () => Promise<ProviderQuotaRefreshResult>;
}): ProviderQuotaServerCoordinator => {
  let currentRefresh: Promise<ProviderQuotaRefreshResult> | null = null;
  return {
    history: options.history,
    refresh: () => {
      if (currentRefresh) {
        return currentRefresh;
      }
      const request = options.refresh().finally(() => {
        if (currentRefresh === request) {
          currentRefresh = null;
        }
      });
      currentRefresh = request;
      return request;
    },
  };
};

export const refreshProviderQuotasForServer = (): Promise<ProviderQuotaRefreshResult> => {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  const request = runProviderQuotaRefreshForServer().finally(() => {
    if (refreshInFlight === request) {
      refreshInFlight = null;
    }
  });
  refreshInFlight = request;
  return request;
};

export const getProviderQuotaHistoryForServer = (
  request: ProviderQuotaHistoryRequest,
): Promise<ProviderQuotaHistoryResult> => runProviderQuotaHistoryForServer(request);
