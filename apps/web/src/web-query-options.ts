import type { SkillsQueryClient } from './lib/query/options/skills';
import { createSkillsMutationRunner } from './skills-query-operations';

export type { SkillsMutationRequest, SkillsMutationResult } from './skills-query-operations';
export { webQueryKeys } from './web-query-keys';

const resolveSkillsClient = async () =>
  await (await import('./lib/rpc/skills-solid-client')).resolveSolidSkillsClient();

export const solidSkillsQueryClient = {
  getKnownSkillProjectPaths: async (options) => await (await resolveSkillsClient()).getKnownSkillProjectPaths(options),
  getManagedSkillMarkdown: async (skillName, options) =>
    await (await resolveSkillsClient()).getManagedSkillMarkdown(skillName, options),
  getProjectSkillMarkdown: async (input, options) =>
    await (await resolveSkillsClient()).getProjectSkillMarkdown(input, options),
  getSkillManagementSnapshot: async (options) =>
    await (await resolveSkillsClient()).getSkillManagementSnapshot(options),
  getSkillProjectInventories: async (options) =>
    await (await resolveSkillsClient()).getSkillProjectInventories(options),
} satisfies SkillsQueryClient;

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
