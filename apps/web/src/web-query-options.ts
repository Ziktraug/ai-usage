import type { ProviderQuotaSource } from './provider-quota-client';
import type { ProviderQuotaHistoryRange } from './provider-quota-history-model';
import { providerQuotaHistoryRequest } from './provider-quota-history-model';
import { type ProjectInventoriesResult, parseProjectInventoriesResult } from './skills-client-contracts';
import { createSkillsMutationRunner } from './skills-query-operations';

export type { SkillsMutationRequest, SkillsMutationResult } from './skills-query-operations';

export const webQueryKeys = {
  providerQuotaHistory: (range?: ProviderQuotaHistoryRange) =>
    range === undefined ? (['provider-quota-history'] as const) : (['provider-quota-history', range] as const),
  skillInventories: ['skills', 'inventories'] as const,
  skillsMutation: ['skills', 'mutation'] as const,
  skills: ['skills'] as const,
  skillsInitial: ['skills', 'initial'] as const,
} as const;

export const loadSkillsInitialData = async () => {
  const client = await import('./lib/rpc/skills-solid-client');
  const [knownProjectPaths, skills] = await Promise.all([
    client.getKnownSkillProjectPaths(),
    client.getSkillManagementSnapshot(),
  ]);
  return { knownProjectPaths, skills };
};

export const loadSkillInventories = async (): Promise<ProjectInventoriesResult> => {
  const { getSkillProjectInventories } = await import('./lib/rpc/skills-solid-client');
  return parseProjectInventoriesResult(await getSkillProjectInventories());
};

export const runSkillsMutation = createSkillsMutationRunner({
  createTarget: async (input) =>
    await (await import('./lib/rpc/skills-solid-client')).createManagedSkillTargetDirectory(input),
  knownProjectPaths: async () => await (await import('./lib/rpc/skills-solid-client')).getKnownSkillProjectPaths(),
  previewReconcile: async () =>
    await (await import('./lib/rpc/skills-solid-client')).previewReconcileAllManagedSkills(),
  reconcileAll: async () => await (await import('./lib/rpc/skills-solid-client')).reconcileAllManagedSkills(),
  reconcileOne: async (input) => await (await import('./lib/rpc/skills-solid-client')).reconcileManagedSkill(input),
  refresh: async () => await (await import('./lib/rpc/skills-solid-client')).refreshSkillManagementSnapshot(),
  saveConfig: async (input) => await (await import('./lib/rpc/skills-solid-client')).saveSkillManagementConfig(input),
  toggle: async (input) => await (await import('./lib/rpc/skills-solid-client')).toggleManagedSkill(input),
});

export const loadProviderQuotaHistory = async (source: ProviderQuotaSource, range: ProviderQuotaHistoryRange) =>
  await source.history(providerQuotaHistoryRequest(range, new Date(), { providerKey: 'codex' }));
