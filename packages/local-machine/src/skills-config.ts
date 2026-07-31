import { parseSkillConfigInput, type SkillManagementConfigDocument } from '@ai-usage/skills';
import { Effect } from 'effect';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';
import { readMergedAiUsageConfigFrom, updateAiUsageConfig } from './machine-config';

export interface SkillsConfigStore {
  readonly homePath: string;
  readonly read: () => Promise<SkillManagementConfigDocument>;
  readonly updateSkills: (skills: unknown) => Promise<void>;
}

export interface SkillsConfigStoreOptions {
  readonly configCwd?: string;
  readonly homePath?: string;
}

export const createSkillsConfigStore = (options: SkillsConfigStoreOptions = {}): SkillsConfigStore => {
  const storage = createLocalHistoryStorage(options.homePath);
  const provideStorage = <A, E>(effect: Effect.Effect<A, E, typeof LocalHistoryStorage.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

  return {
    homePath: storage.home,
    read: async () => ({ skills: (await provideStorage(readMergedAiUsageConfigFrom(options.configCwd))).skills }),
    updateSkills: async (skills) => {
      const parsedSkills = parseSkillConfigInput(skills);
      await provideStorage(updateAiUsageConfig((config) => ({ ...config, skills: parsedSkills })));
    },
  };
};
