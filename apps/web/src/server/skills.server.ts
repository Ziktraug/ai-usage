import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import {
  readAiUsageConfig,
  readMergedAiUsageConfigFrom,
  writeAiUsageConfig,
} from '@ai-usage/local-collectors/machine-config';
import type { AiUsageConfig } from '@ai-usage/report-core/project-alias';
import type {
  ProjectionAction,
  SkillManagementConfig,
  SkillManagementSnapshot,
  SkillTargetDirectoryInput,
  SkillToggleInput,
} from '@ai-usage/skills';
import {
  createSkillTargetDirectory,
  loadSkillManagementSnapshot,
  parseSkillConfigInput,
  parseSkillName,
  parseSkillTargetDirectoryInput,
  parseSkillToggleInput,
  reconcileAllActiveSkills,
  reconcileSkill,
  toggleSkillEnabled,
  writeSkillManagementConfig,
} from '@ai-usage/skills';
import { Cause, Effect, Option, Runtime } from 'effect';

export type SkillsServerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        message: string;
        tag: string;
      };
    };

const toJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const unwrapEffectFailure = (error: unknown) => {
  if (!Runtime.isFiberFailure(error)) {
    return error;
  }
  return Option.getOrUndefined(Cause.failureOption(error[Runtime.FiberFailureCauseId])) ?? error;
};

const errorResult = (error: unknown): SkillsServerResult<never> => {
  const unwrapped = unwrapEffectFailure(error);
  const record = typeof unwrapped === 'object' && unwrapped !== null ? (unwrapped as Record<string, unknown>) : {};
  return {
    ok: false,
    error: {
      message: unwrapped instanceof Error ? unwrapped.message : String(unwrapped),
      tag: typeof record._tag === 'string' ? record._tag : 'Error',
    },
  };
};

export interface SkillReconcileServerResult {
  actions: readonly ProjectionAction[];
  snapshot: SkillManagementSnapshot;
}

export const skillConfigInputFrom = (input: unknown): SkillManagementConfig => parseSkillConfigInput(input);

export const skillToggleInputFrom = (input: unknown): SkillToggleInput => parseSkillToggleInput(input);

export const skillNameInputFrom = (input: unknown): string => {
  if (typeof input === 'string') {
    return parseSkillName(input);
  }
  if (typeof input === 'object' && input !== null && 'skillName' in input) {
    return parseSkillName((input as { skillName?: unknown }).skillName);
  }
  return parseSkillName(input);
};

export const skillTargetDirectoryInputFrom = (input: unknown): SkillTargetDirectoryInput =>
  parseSkillTargetDirectoryInput(input);

const runWithStorage = async <T>(
  operation: (storage: LocalHistoryStorage) => Promise<T>,
): Promise<SkillsServerResult<T>> => {
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* LocalHistoryStorage;
        return yield* Effect.promise(() => operation(storage));
      }).pipe(Effect.provide(LocalHistoryStorageLive)),
    );
    return { ok: true, data: toJson(result) };
  } catch (error) {
    return errorResult(error);
  }
};

const loadMergedConfig = () =>
  Effect.runPromise(readMergedAiUsageConfigFrom().pipe(Effect.provide(LocalHistoryStorageLive)));

const loadSnapshotForStorage = async (storage: LocalHistoryStorage): Promise<SkillManagementSnapshot> => {
  const config = await Effect.runPromise(
    readMergedAiUsageConfigFrom().pipe(Effect.provideService(LocalHistoryStorage, storage)),
  );
  return loadSkillManagementSnapshot({
    config: { ...config },
    homePath: storage.home,
  });
};

export const readSkillManagementSnapshotForServer = async (): Promise<SkillsServerResult<SkillManagementSnapshot>> =>
  runWithStorage((storage) => loadSnapshotForStorage(storage));

export const writeSkillManagementConfigForServer = async (
  skills: SkillManagementConfig,
): Promise<SkillsServerResult<SkillManagementSnapshot>> =>
  runWithStorage(async (storage) => {
    const config = await Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)));
    await writeSkillManagementConfig({
      config: { ...config },
      skills,
      writeConfig: (nextConfig) =>
        Effect.runPromise(
          writeAiUsageConfig(nextConfig as AiUsageConfig).pipe(Effect.provideService(LocalHistoryStorage, storage)),
        ),
    });
    return loadSnapshotForStorage(storage);
  });

export const toggleSkillEnabledForServer = async (
  input: SkillToggleInput,
): Promise<SkillsServerResult<SkillReconcileServerResult>> =>
  runWithStorage(async (storage) => {
    const config = await loadMergedConfig();
    const skillsConfig = parseSkillConfigInput(config.skills ?? {});
    if (skillsConfig.sourceRepoPath === undefined) {
      throw new Error('skills.sourceRepoPath is required before toggling skills');
    }
    await toggleSkillEnabled({
      enabled: input.enabled,
      skillName: input.skillName,
      sourceRepoPath: skillsConfig.sourceRepoPath,
    });
    if (!input.enabled) {
      const reconcileResult = await reconcileSkill({
        config: { ...config },
        homePath: storage.home,
        skillName: input.skillName,
      });
      return {
        actions: reconcileResult.actions,
        snapshot: await loadSnapshotForStorage(storage),
      };
    }
    return { actions: [], snapshot: await loadSnapshotForStorage(storage) };
  });

export const reconcileSkillForServer = async (
  skillName: string,
): Promise<SkillsServerResult<SkillReconcileServerResult>> =>
  runWithStorage(async (storage) => {
    const config = await loadMergedConfig();
    const reconcileResult = await reconcileSkill({
      config: { ...config },
      homePath: storage.home,
      skillName,
    });
    return {
      actions: reconcileResult.actions,
      snapshot: await loadSnapshotForStorage(storage),
    };
  });

export const reconcileAllActiveSkillsForServer = async (): Promise<SkillsServerResult<SkillReconcileServerResult>> =>
  runWithStorage(async (storage) => {
    const config = await loadMergedConfig();
    const reconcileResult = await reconcileAllActiveSkills({
      config: { ...config },
      homePath: storage.home,
    });
    return {
      actions: reconcileResult.actions,
      snapshot: await loadSnapshotForStorage(storage),
    };
  });

export const createSkillTargetDirectoryForServer = async (
  input: SkillTargetDirectoryInput,
): Promise<SkillsServerResult<SkillManagementSnapshot>> =>
  runWithStorage(async (storage) => {
    const snapshot = await loadSnapshotForStorage(storage);
    const target = snapshot.targets.find((candidate) => candidate.id === input.targetId);
    if (!target) {
      throw new Error(`Unknown skill target: ${input.targetId}`);
    }
    await createSkillTargetDirectory({ path: target.path });
    return loadSnapshotForStorage(storage);
  });
