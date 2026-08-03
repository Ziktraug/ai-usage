import type { ProviderQuotaSource } from './provider-quota-client';
import { type ProviderQuotaHistoryRange, providerQuotaHistoryRequest } from './provider-quota-history-model';

export const loadProviderQuotaHistory = async (source: ProviderQuotaSource, range: ProviderQuotaHistoryRange) =>
  await source.history(providerQuotaHistoryRequest(range, new Date(), { providerKey: 'codex' }));
