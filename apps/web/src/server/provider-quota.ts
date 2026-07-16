import { parseProviderQuotaHistoryRequest } from '@ai-usage/report-core/provider-quota';
import { createServerFn } from '@tanstack/solid-start';

export const getProviderQuotaHistory = createServerFn({ method: 'POST' })
  .validator(parseProviderQuotaHistoryRequest)
  .handler(({ data }) =>
    import('./provider-quota.server').then(({ getProviderQuotaHistoryForServer }) =>
      getProviderQuotaHistoryForServer(data),
    ),
  );
