import { parseProviderQuotaHistoryRequest } from '@ai-usage/report-core/provider-quota';
import { createServerFn } from '@tanstack/solid-start';

export const getProviderQuotaHistory = createServerFn({ method: 'POST' })
  .validator(parseProviderQuotaHistoryRequest)
  .handler(async ({ data }) => {
    const { assertOutsideDemo } = await import('./demo-boundary.server');
    assertOutsideDemo();
    const { getProviderQuotaHistoryForServer } = await import('./provider-quota.server');
    return await getProviderQuotaHistoryForServer(data);
  });
