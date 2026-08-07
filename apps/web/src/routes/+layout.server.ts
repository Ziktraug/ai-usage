import { buildProviderQuotaRail, type ProviderQuotaRailEntry } from '$lib/features/shell/provider-quota-rail';
import type { LayoutServerLoad } from './$types';

/**
 * The quota rail sits in the navigation shell, so it is loaded here rather than per route. The store
 * module is imported lazily for the same reason `context.server.ts` does it: demo and e2e runtimes
 * have no durable database to open, and they should not pay to link one.
 */
const loadProviderQuotaRail = async (): Promise<ProviderQuotaRailEntry[]> => {
  const { getProviderQuotaRailForServer } = await import('../server/provider-quota-rail.server');
  return await getProviderQuotaRailForServer();
};

export const load: LayoutServerLoad = async ({ depends, locals }) => {
  depends('ai-usage:provider-quota');
  const runtimeMode = locals.runtimeMode ?? 'live';
  return {
    providerQuota: runtimeMode === 'live' ? await loadProviderQuotaRail() : buildProviderQuotaRail(null, new Date()),
    runtimeMode,
  };
};
