import type { ProviderQuotaSource } from './provider-quota-client';
import type { ProviderQuotaHistoryRange } from './provider-quota-history-model';
import { providerQuotaHistoryRequest } from './provider-quota-history-model';
import { getKnownSkillProjectPaths, getSkillManagementSnapshot, getSkillProjectInventories } from './server/skills';

export const webQueryKeys = {
  providerQuotaHistory: (range?: ProviderQuotaHistoryRange) =>
    range === undefined ? (['provider-quota-history'] as const) : (['provider-quota-history', range] as const),
  skillInventories: ['skills', 'inventories'] as const,
  skills: ['skills'] as const,
  skillsInitial: ['skills', 'initial'] as const,
} as const;

export const loadSkillsInitialData = async () => {
  const [knownProjectPaths, skills] = await Promise.all([getKnownSkillProjectPaths(), getSkillManagementSnapshot()]);
  return { knownProjectPaths, skills };
};

export const loadSkillInventories = async () => await getSkillProjectInventories();

export const loadProviderQuotaHistory = async (source: ProviderQuotaSource, range: ProviderQuotaHistoryRange) =>
  await source.history(providerQuotaHistoryRequest(range, new Date(), { providerKey: 'codex' }));
