import { parseProviderQuotaHistoryRequest } from '@ai-usage/report-core/provider-quota';
import { createServerFn } from '@tanstack/solid-start';
import { assertOutsideDemo } from './demo-boundary.server';

export const getProviderQuotaHistory = createServerFn({ method: 'POST' })
  .validator(parseProviderQuotaHistoryRequest)
  .handler(async ({ data }) => {
    assertOutsideDemo();
    const { getProviderQuotaHistoryForServer } = await import('./provider-quota.server');
    return await getProviderQuotaHistoryForServer(data);
  });
