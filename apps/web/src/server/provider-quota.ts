import { parseProviderQuotaHistoryRequest } from '@ai-usage/report-core/provider-quota';
import { createServerFn } from '@tanstack/solid-start';

export const getProviderQuotaHistory = createServerFn({ method: 'POST' })
  .validator(parseProviderQuotaHistoryRequest)
  .handler(async ({ data }) => {
    const { resolveProviderQuotaHistoryForServer } = await import('./provider-quota-resolver.server');
    return await resolveProviderQuotaHistoryForServer(data);
  });
