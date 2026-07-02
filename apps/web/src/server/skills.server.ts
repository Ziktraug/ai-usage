import fs from 'node:fs';
import path from 'node:path';
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
  projectSkillDirectories,
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

export interface ProjectSkillMarkdownInput {
  projectPath: string;
  runtimeDirId: (typeof projectSkillDirectories)[number]['id'];
  skillName: string;
}

export interface ProjectSkillMarkdownDocument {
  content: string;
  path: string;
  skillName: string;
  truncated: boolean;
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
  homePath?: string;
  isProjectRoot?: (projectPath: string) => boolean;
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

const projectRuntimeDirectoryIds = new Set<string>(projectSkillDirectories.map((directory) => directory.id));

export const projectSkillMarkdownInputFrom = (input: unknown): ProjectSkillMarkdownInput => {
  if (typeof input !== 'object' || input === null) {
    throw new Error('project skill markdown input must be an object');
  }
  const record = input as Record<string, unknown>;
  const projectPath = typeof record.projectPath === 'string' ? record.projectPath.trim() : '';
  if (!projectPath) {
    throw new Error('projectPath is required');
  }
  const runtimeDirId = typeof record.runtimeDirId === 'string' ? record.runtimeDirId : '';
  if (!projectRuntimeDirectoryIds.has(runtimeDirId)) {
    throw new Error('runtimeDirId is unknown');
  }
  return {
    projectPath,
    runtimeDirId: runtimeDirId as ProjectSkillMarkdownInput['runtimeDirId'],
    skillName: parseSkillName(record.skillName),
  };
};

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

const pathEntryLabel = (entry: { project: string }) => entry.project;

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
  const rawProjectPath = input.path?.trim();
  if (!rawProjectPath) {
    return;
  }
  const projectPath = path.resolve(rawProjectPath);
  if (options.homePath !== undefined && projectPath === path.resolve(options.homePath)) {
    return;
  }
  if (options.directoryExists && !options.directoryExists(projectPath)) {
    return;
  }
  if (options.isProjectRoot && !options.isProjectRoot(projectPath)) {
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

export const projectSkillScanPathsFrom = (
  skillsConfig: SkillManagementConfig,
  knownProjectPaths: readonly Pick<KnownSkillProjectPath, 'path'>[],
): readonly string[] => [
  ...new Set([...(skillsConfig.projectPaths ?? []), ...knownProjectPaths.map((projectPath) => projectPath.path)]),
];

const localDirectoryExists = (projectPath: string) => {
  try {
    return fs.statSync(projectPath).isDirectory();
  } catch {
    return false;
  }
};

export const localProjectRootExists = (projectPath: string) => {
  const gitPath = path.join(projectPath, '.git');
  if (fs.existsSync(gitPath)) {
    return true;
  }
  return projectSkillDirectories.some((directory) => fs.existsSync(path.join(projectPath, directory.relativePath)));
};

export const readKnownSkillProjectPathsForServer = async (): Promise<
  SkillsServerResult<readonly KnownSkillProjectPath[]>
> => {
  try {
    const [machine, payload, homePath] = await Promise.all([
      Effect.runPromise(ensureMachineConfig.pipe(Effect.provide(LocalHistoryStorageLive))),
      import('./report-payload.server').then(({ runReportPayloadCollection }) => runReportPayloadCollection()),
      Effect.runPromise(
        Effect.map(LocalHistoryStorage, (storage) => storage.home).pipe(Effect.provide(LocalHistoryStorageLive)),
      ),
    ]);
    return {
      ok: true,
      data: knownSkillProjectPathsFromReportPayload(payload, {
        directoryExists: localDirectoryExists,
        homePath,
        isProjectRoot: localProjectRootExists,
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
    const knownProjectsResult = await readKnownSkillProjectPathsForServer();
    const knownProjectPaths = knownProjectsResult.ok ? knownProjectsResult.data : [];
    const projectPaths = projectSkillScanPathsFrom(skillsConfig, knownProjectPaths);
    if (projectPaths.length === 0) {
      return [];
    }
    return scanProjectSkills({
      ...(skillsConfig.tokenThresholds === undefined
        ? {}
        : { options: { tokenThresholds: skillsConfig.tokenThresholds } }),
      projectPaths,
      ...(skillsConfig.sourceRepoPath === undefined ? {} : { sourceRepoPath: skillsConfig.sourceRepoPath }),
    });
  });

interface ReadProjectSkillMarkdownOptions {
  loadConfig?: () => Promise<AiUsageConfig>;
  readKnownProjectPaths?: () => Promise<SkillsServerResult<readonly KnownSkillProjectPath[]>>;
}

const maxProjectSkillMarkdownBytes = 65_536;

export const readProjectSkillMarkdownForServer = async (
  input: ProjectSkillMarkdownInput,
  options: ReadProjectSkillMarkdownOptions = {},
): Promise<SkillsServerResult<ProjectSkillMarkdownDocument>> =>
  runWithStorage(async () => {
    const config = await (options.loadConfig?.() ?? loadMergedConfig());
    const skillsConfig = parseSkillConfigInput(config.skills ?? {});
    const knownProjectsResult = await (options.readKnownProjectPaths?.() ?? readKnownSkillProjectPathsForServer());
    const knownProjectPaths = knownProjectsResult.ok ? knownProjectsResult.data : [];
    const allowedProjectPaths = new Set(
      projectSkillScanPathsFrom(skillsConfig, knownProjectPaths).map((projectPath) => path.resolve(projectPath)),
    );
    const projectPath = path.resolve(input.projectPath);
    if (!allowedProjectPaths.has(projectPath)) {
      throw new Error('project path is not allowed');
    }
    const inventories = await scanProjectSkills({
      ...(skillsConfig.tokenThresholds === undefined
        ? {}
        : { options: { tokenThresholds: skillsConfig.tokenThresholds } }),
      projectPaths: [projectPath],
      ...(skillsConfig.sourceRepoPath === undefined ? {} : { sourceRepoPath: skillsConfig.sourceRepoPath }),
    });
    const observation = inventories
      .flatMap((inventory) => inventory.observations)
      .find((candidate) => candidate.name === input.skillName && candidate.runtimeDirId === input.runtimeDirId);
    if (observation === undefined) {
      throw new Error('project skill markdown not found');
    }
    const fileStat = await fs.promises.stat(observation.skillMdPath);
    const truncated = fileStat.size > maxProjectSkillMarkdownBytes;
    const file = await fs.promises.open(observation.skillMdPath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(fileStat.size, maxProjectSkillMarkdownBytes));
      await file.read(buffer, 0, buffer.length, 0);
      return {
        content: buffer.toString('utf8'),
        path: observation.skillMdPath,
        skillName: input.skillName,
        truncated,
      };
    } finally {
      await file.close();
    }
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
