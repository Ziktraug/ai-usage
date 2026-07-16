import type { ProviderQuotaSource } from './provider-quota-client';
import type { ProviderQuotaHistoryRange } from './provider-quota-history-model';
import { providerQuotaHistoryRequest } from './provider-quota-history-model';
import {
  createManagedSkillTargetDirectory,
  getKnownSkillProjectPaths,
  getSkillManagementSnapshot,
  getSkillProjectInventories,
  previewReconcileAllManagedSkills,
  reconcileAllManagedSkills,
  reconcileManagedSkill,
  refreshSkillManagementSnapshot,
  saveSkillManagementConfig,
  toggleManagedSkill,
} from './server/skills';
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
  const [knownProjectPaths, skills] = await Promise.all([getKnownSkillProjectPaths(), getSkillManagementSnapshot()]);
  return { knownProjectPaths, skills };
};

export const loadSkillInventories = async (): Promise<ProjectInventoriesResult> =>
  parseProjectInventoriesResult(await getSkillProjectInventories());

export const runSkillsMutation = createSkillsMutationRunner({
  createTarget: createManagedSkillTargetDirectory,
  knownProjectPaths: getKnownSkillProjectPaths,
  previewReconcile: previewReconcileAllManagedSkills,
  reconcileAll: reconcileAllManagedSkills,
  reconcileOne: reconcileManagedSkill,
  refresh: refreshSkillManagementSnapshot,
  saveConfig: saveSkillManagementConfig,
  toggle: toggleManagedSkill,
});

export const loadProviderQuotaHistory = async (source: ProviderQuotaSource, range: ProviderQuotaHistoryRange) =>
  await source.history(providerQuotaHistoryRequest(range, new Date(), { providerKey: 'codex' }));
