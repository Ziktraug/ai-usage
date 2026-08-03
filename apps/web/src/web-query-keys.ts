import type { ProviderQuotaHistoryRange } from './provider-quota-history-model';

export const webQueryKeys = {
  providerQuotaHistory: (range?: ProviderQuotaHistoryRange) =>
    range === undefined ? (['provider-quota-history'] as const) : (['provider-quota-history', range] as const),
  skillInventories: ['skills', 'inventories'] as const,
  skillsMutation: ['skills', 'mutation'] as const,
  skills: ['skills'] as const,
  skillsInitial: ['skills', 'initial'] as const,
} as const;
