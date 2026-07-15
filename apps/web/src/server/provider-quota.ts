import { parseProviderQuotaHistoryRequest } from '@ai-usage/report-core/provider-quota';
import { createServerFn } from '@tanstack/solid-start';

const parseRefreshRequest = (value: unknown): Record<string, never> => {
  if (!(typeof value === 'object' && value !== null && Object.keys(value).length === 0)) {
    throw new Error('Quota refresh request must be an empty object');
  }
  return {};
};

export const refreshProviderQuotas = createServerFn({ method: 'POST' })
  .validator(parseRefreshRequest)
  .handler(() =>
    import('./provider-quota.server').then(({ refreshProviderQuotasForServer }) => refreshProviderQuotasForServer()),
  );

export const getProviderQuotaHistory = createServerFn({ method: 'POST' })
  .validator(parseProviderQuotaHistoryRequest)
  .handler(({ data }) =>
    import('./provider-quota.server').then(({ getProviderQuotaHistoryForServer }) =>
      getProviderQuotaHistoryForServer(data),
    ),
  );
