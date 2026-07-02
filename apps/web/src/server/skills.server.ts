import fs from 'node:fs';
import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import {
  ensureMachineConfig,
  readAiUsageConfig,
  readMergedAiUsageConfigFrom,
  writeAiUsageConfig,
} from '@ai-usage/local-collectors/machine-config';
import type { AiUsageConfig } from '@ai-usage/report-core/project-alias';
import type {
  ProjectionAction,
  ProjectSkillInventory,
  SkillManagementConfig,
  SkillManagementSnapshot,
  SkillMarkdownDocument,
  SkillMarkdownWriteInput,
  SkillTargetDirectoryInput,
  SkillToggleInput,
} from '@ai-usage/skills';
import {
  createSkillTargetDirectory,
  loadSkillManagementSnapshot,
  parseSkillConfigInput,
  parseSkillMarkdownWriteInput,
  parseSkillName,
  parseSkillTargetDirectoryInput,
  parseSkillToggleInput,
  previewReconcileAllActiveSkills,
  readSkillMarkdown,
  reconcileAllActiveSkills,
  reconcileSkill,
  scanProjectSkills,
  toggleSkillEnabled,
  writeSkillManagementConfig,
  writeSkillMarkdown,
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

interface ProjectPathSource {
  machineId?: string;
  machineLabel?: string;
  project: string;
  sessions?: number;
  sourcePath?: string | null;
}

interface ProjectPathRow {
  project: string;
  rawProject?: string;
  source?: {
    machineId?: string;
    machineLabel?: string;
    sourcePath?: string | null;
  };
}

interface ProjectPathSourcePayload {
  projectGroups?: readonly { sources: readonly ProjectPathSource[] }[];
  rows: readonly ProjectPathRow[];
}

export interface KnownSkillProjectPath {
  label: string;
  machineLabel?: string;
  path: string;
  project: string;
  sessions: number;
}

interface KnownSkillProjectPathOptions {
  directoryExists?: (projectPath: string) => boolean;
  localMachineId?: string;
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

export const skillMarkdownWriteInputFrom = (input: unknown): SkillMarkdownWriteInput =>
  parseSkillMarkdownWriteInput(input);

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

const pathEntryLabel = (entry: { machineLabel?: string | undefined; project: string }) =>
  entry.machineLabel ? `${entry.project} · ${entry.machineLabel}` : entry.project;

const addKnownProjectPath = (
  entries: Map<string, KnownSkillProjectPath>,
  input: {
    machineId?: string | undefined;
    machineLabel?: string | undefined;
    path?: string | null | undefined;
    project: string;
    sessions?: number;
  },
  options: KnownSkillProjectPathOptions,
) => {
  if (options.localMachineId && input.machineId && input.machineId !== options.localMachineId) {
    return;
  }
  const projectPath = input.path?.trim();
  if (!projectPath) {
    return;
  }
  if (options.directoryExists && !options.directoryExists(projectPath)) {
    return;
  }
  const existing = entries.get(projectPath);
  if (existing) {
    entries.set(projectPath, {
      ...existing,
      sessions: existing.sessions + (input.sessions ?? 0),
    });
    return;
  }
  entries.set(projectPath, {
    label: pathEntryLabel(input),
    ...(input.machineLabel ? { machineLabel: input.machineLabel } : {}),
    path: projectPath,
    project: input.project,
    sessions: input.sessions ?? 0,
  });
};

export const knownSkillProjectPathsFromReportPayload = (
  payload: ProjectPathSourcePayload,
  options: KnownSkillProjectPathOptions = {},
): readonly KnownSkillProjectPath[] => {
  const entries = new Map<string, KnownSkillProjectPath>();
  const groupedSources = payload.projectGroups?.flatMap((group) => group.sources) ?? [];

  if (groupedSources.length > 0) {
    for (const source of groupedSources) {
      addKnownProjectPath(
        entries,
        {
          machineId: source.machineId,
          machineLabel: source.machineLabel,
          path: source.sourcePath,
          project: source.project,
          sessions: source.sessions ?? 0,
        },
        options,
      );
    }
  } else {
    for (const row of payload.rows) {
      addKnownProjectPath(
        entries,
        {
          machineId: row.source?.machineId,
          machineLabel: row.source?.machineLabel,
          path: row.source?.sourcePath,
          project: row.rawProject ?? row.project,
          sessions: 1,
        },
        options,
      );
    }
  }

  return [...entries.values()].sort(
    (left, right) => right.sessions - left.sessions || left.label.localeCompare(right.label),
  );
};

const localDirectoryExists = (projectPath: string) => {
  try {
    return fs.statSync(projectPath).isDirectory();
  } catch {
    return false;
  }
};

export const readKnownSkillProjectPathsForServer = async (): Promise<
  SkillsServerResult<readonly KnownSkillProjectPath[]>
> => {
  try {
    const [machine, payload] = await Promise.all([
      Effect.runPromise(ensureMachineConfig.pipe(Effect.provide(LocalHistoryStorageLive))),
      import('./report-payload.server').then(({ runReportPayloadCollection }) => runReportPayloadCollection()),
    ]);
    return {
      ok: true,
      data: knownSkillProjectPathsFromReportPayload(payload, {
        directoryExists: localDirectoryExists,
        localMachineId: machine.id,
      }),
    };
  } catch (error) {
    return errorResult(error);
  }
};

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

export const previewReconcileAllActiveSkillsForServer = async (): Promise<
  SkillsServerResult<SkillReconcileServerResult>
> =>
  runWithStorage(async (storage) => {
    const config = await loadMergedConfig();
    // Planning only — apply re-plans from a fresh snapshot; per-action safety
    // rules in the workflow remain the real mutation guard.
    const previewResult = await previewReconcileAllActiveSkills({
      config: { ...config },
      homePath: storage.home,
    });
    return {
      actions: previewResult.actions,
      snapshot: previewResult.snapshot,
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

export const readSkillProjectInventoriesForServer = async (): Promise<
  SkillsServerResult<readonly ProjectSkillInventory[]>
> =>
  runWithStorage(async () => {
    const config = await loadMergedConfig();
    const skillsConfig = parseSkillConfigInput(config.skills ?? {});
    if ((skillsConfig.projectPaths?.length ?? 0) === 0) {
      return [];
    }
    return scanProjectSkills({
      ...(skillsConfig.tokenThresholds === undefined
        ? {}
        : { options: { tokenThresholds: skillsConfig.tokenThresholds } }),
      projectPaths: skillsConfig.projectPaths ?? [],
      ...(skillsConfig.sourceRepoPath === undefined ? {} : { sourceRepoPath: skillsConfig.sourceRepoPath }),
    });
  });

export interface SkillMarkdownSaveResult {
  document?: SkillMarkdownDocument;
  reason?: 'conflict' | 'not-found' | 'too-large';
  snapshot?: SkillManagementSnapshot;
}

export const readSkillMarkdownForServer = async (
  skillName: string,
): Promise<SkillsServerResult<SkillMarkdownDocument>> =>
  runWithStorage(async () => {
    const config = await loadMergedConfig();
    const skillsConfig = parseSkillConfigInput(config.skills ?? {});
    if (skillsConfig.sourceRepoPath === undefined) {
      throw new Error('skills.sourceRepoPath is required before reading SKILL.md');
    }
    return readSkillMarkdown({ skillName, sourceRepoPath: skillsConfig.sourceRepoPath });
  });

export const writeSkillMarkdownForServer = async (
  input: SkillMarkdownWriteInput,
): Promise<SkillsServerResult<SkillMarkdownSaveResult>> =>
  runWithStorage(async (storage) => {
    const config = await loadMergedConfig();
    const skillsConfig = parseSkillConfigInput(config.skills ?? {});
    if (skillsConfig.sourceRepoPath === undefined) {
      throw new Error('skills.sourceRepoPath is required before writing SKILL.md');
    }
    const result = await writeSkillMarkdown({ ...input, sourceRepoPath: skillsConfig.sourceRepoPath });
    if (!result.ok) {
      return { reason: result.reason };
    }
    return {
      document: await readSkillMarkdown({ skillName: input.skillName, sourceRepoPath: skillsConfig.sourceRepoPath }),
      snapshot: await loadSnapshotForStorage(storage),
    };
  });
