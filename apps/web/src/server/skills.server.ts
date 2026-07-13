import fs from 'node:fs';
import path from 'node:path';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import { readMergedAiUsageConfigFrom, updateAiUsageConfig } from '@ai-usage/local-collectors/machine-config';
import type { AiUsageConfig } from '@ai-usage/report-core/project-alias';
import {
  createKnownLocalProjectSources,
  type KnownLocalProjectSourcesRequest,
  type KnownLocalProjectSourcesResult,
} from '@ai-usage/report-data';
import type {
  ProjectSkillInventory,
  SkillManagementConfig,
  SkillManagementSnapshot,
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
import { runKnownProjectSourcesRunner } from './known-project-sources-runner.server';
import type {
  KnownSkillProjectPath,
  ProjectSkillMarkdownDocument,
  ProjectSkillMarkdownInput,
  SkillsServerAdapter,
  SkillsServerResult,
} from './skills-contracts';

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
  projectGroups?: readonly {
    grouped?: boolean;
    id: string;
    name: string;
    sources: readonly ProjectPathSource[];
  }[];
  rows?: readonly ProjectPathRow[];
  sources?: readonly ProjectPathSource[];
}

interface KnownSkillProjectPathOptions {
  directoryExists?: (projectPath: string) => boolean;
  // Tool-managed data locations (agent worktrees, caches) are not user
  // projects even when they carry a `.git` marker.
  excludedPathPrefixes?: readonly string[];
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

export const skillManagementSnapshotForClient = (snapshot: SkillManagementSnapshot): SkillManagementSnapshot => ({
  ...snapshot,
  skills: snapshot.skills.map((skill) => ({
    ...skill,
    manifest: {
      ...skill.manifest,
      markdown: '',
    },
  })),
});

const pathEntryLabel = (entry: { project: string }) => entry.project;

const addKnownProjectPath = (
  entries: Map<string, KnownSkillProjectPath>,
  input: {
    groupId?: string | undefined;
    groupLabel?: string | undefined;
    label?: string | undefined;
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
  if (
    options.excludedPathPrefixes?.some((prefix) => {
      const resolvedPrefix = path.resolve(prefix);
      return projectPath === resolvedPrefix || projectPath.startsWith(`${resolvedPrefix}${path.sep}`);
    })
  ) {
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
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.groupLabel ? { groupLabel: input.groupLabel } : {}),
    label: input.label ?? pathEntryLabel(input),
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
    for (const group of payload.projectGroups ?? []) {
      for (const source of group.sources) {
        addKnownProjectPath(
          entries,
          {
            ...(group.grouped ? { groupId: group.id, groupLabel: group.name, label: group.name } : {}),
            machineId: source.machineId,
            machineLabel: source.machineLabel,
            path: source.sourcePath,
            project: source.project,
            sessions: source.sessions ?? 0,
          },
          options,
        );
      }
    }
  } else if (payload.sources && payload.sources.length > 0) {
    for (const source of payload.sources) {
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
    for (const row of payload.rows ?? []) {
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

interface ReadProjectSkillMarkdownOptions {
  loadConfig?: () => Promise<AiUsageConfig>;
  readKnownProjectPaths?: () => Promise<SkillsServerResult<readonly KnownSkillProjectPath[]>>;
}

const maxProjectSkillMarkdownBytes = 65_536;

interface ProjectSkillMarkdownFileHandle {
  close: () => Promise<void>;
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ buffer: Buffer; bytesRead: number }>;
  stat: () => Promise<{ isFile: () => boolean; size: number }>;
}

interface ReadBoundedProjectSkillMarkdownFileOptions {
  openFile?: (filePath: string, flags: number) => Promise<ProjectSkillMarkdownFileHandle>;
}

export const readBoundedProjectSkillMarkdownFile = async (
  filePath: string,
  maxBytes: number,
  options: ReadBoundedProjectSkillMarkdownFileOptions = {},
): Promise<{ content: string; truncated: boolean }> => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file flags are bitmasks.
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const file = await (options.openFile?.(filePath, flags) ?? fs.promises.open(filePath, flags));
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) {
      throw new Error('project skill markdown must be a regular file');
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const truncated = fileStat.size > maxBytes || bytesRead > maxBytes;
    return {
      content: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8'),
      truncated,
    };
  } finally {
    await file.close();
  }
};

const pathIsWithin = (parentPath: string, candidatePath: string): boolean => {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
  );
};

interface SkillsConfigReadInput {
  configCwd: string;
  storage: LocalHistoryStorageService;
}

interface SkillsConfigUpdateInput {
  storage: LocalHistoryStorageService;
  update: (config: AiUsageConfig) => AiUsageConfig | Promise<AiUsageConfig>;
}

interface KnownProjectSourcesReadInput {
  request: KnownLocalProjectSourcesRequest;
  storage: LocalHistoryStorageService;
}

export interface SkillsServerAdapterDependencies {
  configCwd: string;
  readConfig: (input: SkillsConfigReadInput) => Promise<AiUsageConfig>;
  readKnownProjectSources: (input: KnownProjectSourcesReadInput) => Promise<KnownLocalProjectSourcesResult>;
  storage: LocalHistoryStorageService;
  updateConfig: (input: SkillsConfigUpdateInput) => Promise<AiUsageConfig>;
  workflows: {
    createTargetDirectory: typeof createSkillTargetDirectory;
    loadSnapshot: typeof loadSkillManagementSnapshot;
    previewReconcileAll: typeof previewReconcileAllActiveSkills;
    readMarkdown: typeof readSkillMarkdown;
    reconcileAll: typeof reconcileAllActiveSkills;
    reconcileSkill: typeof reconcileSkill;
    scanProjects: typeof scanProjectSkills;
    toggleSkill: typeof toggleSkillEnabled;
    writeConfig: typeof writeSkillManagementConfig;
    writeMarkdown: typeof writeSkillMarkdown;
  };
}

const runAdapterOperation = async <T>(operation: () => Promise<T>): Promise<SkillsServerResult<T>> => {
  try {
    return { ok: true, data: toJson(await operation()) };
  } catch (error) {
    return errorResult(error);
  }
};

const projectScanInput = (skillsConfig: SkillManagementConfig, projectPaths: readonly string[]) => ({
  ...(skillsConfig.tokenThresholds === undefined ? {} : { options: { tokenThresholds: skillsConfig.tokenThresholds } }),
  projectPaths,
  ...(skillsConfig.sourceRepoPath === undefined ? {} : { sourceRepoPath: skillsConfig.sourceRepoPath }),
});

export const createSkillsServerAdapter = (dependencies: SkillsServerAdapterDependencies): SkillsServerAdapter => {
  const loadConfig = () =>
    dependencies.readConfig({ configCwd: dependencies.configCwd, storage: dependencies.storage });

  const loadSnapshot = async (): Promise<SkillManagementSnapshot> =>
    dependencies.workflows.loadSnapshot({
      config: { ...(await loadConfig()) },
      homePath: dependencies.storage.home,
    });

  const loadClientSnapshot = async (): Promise<SkillManagementSnapshot> =>
    skillManagementSnapshotForClient(await loadSnapshot());

  const readKnownProjectPaths = async (): Promise<readonly KnownSkillProjectPath[]> => {
    const projectSources = await dependencies.readKnownProjectSources({
      request: {
        configCwd: dependencies.configCwd,
        harness: null,
        includeCursor: true,
      },
      storage: dependencies.storage,
    });
    const homePath = dependencies.storage.home;
    return knownSkillProjectPathsFromReportPayload(projectSources, {
      directoryExists: localDirectoryExists,
      excludedPathPrefixes: [path.join(homePath, '.local', 'share'), path.join(homePath, '.cache')],
      homePath,
      isProjectRoot: localProjectRootExists,
    });
  };

  const readProjectInventories = async (): Promise<readonly ProjectSkillInventory[]> => {
    const skillsConfig = parseSkillConfigInput((await loadConfig()).skills ?? {});
    const projectPaths = projectSkillScanPathsFrom(skillsConfig, await readKnownProjectPaths());
    if (projectPaths.length === 0) {
      return [];
    }
    return dependencies.workflows.scanProjects(projectScanInput(skillsConfig, projectPaths));
  };

  const readProjectMarkdown = async (input: ProjectSkillMarkdownInput): Promise<ProjectSkillMarkdownDocument> => {
    const skillsConfig = parseSkillConfigInput((await loadConfig()).skills ?? {});
    const allowedProjectPaths = new Set(
      projectSkillScanPathsFrom(skillsConfig, await readKnownProjectPaths()).map((projectPath) =>
        path.resolve(projectPath),
      ),
    );
    const projectPath = path.resolve(input.projectPath);
    if (!allowedProjectPaths.has(projectPath)) {
      throw new Error('project path is not allowed');
    }
    const inventories = await dependencies.workflows.scanProjects(projectScanInput(skillsConfig, [projectPath]));
    const observation = inventories
      .flatMap((inventory) => inventory.observations)
      .find((candidate) => candidate.name === input.skillName && candidate.runtimeDirId === input.runtimeDirId);
    if (observation === undefined) {
      throw new Error('project skill markdown not found');
    }
    if (!observation.markdownReadable || observation.placement === 'external-symlink') {
      throw new Error('project skill markdown is not readable');
    }
    const observedSkillMdPath = path.resolve(observation.skillMdPath);
    const [canonicalProjectPath, canonicalSkillMdPath] = await Promise.all([
      fs.promises.realpath(projectPath),
      fs.promises.realpath(observedSkillMdPath),
    ]);
    const isLexicallyInsideProject = pathIsWithin(projectPath, observedSkillMdPath);
    const isCanonicallyInsideProject = pathIsWithin(canonicalProjectPath, canonicalSkillMdPath);
    let isCanonicallyInsideSource = false;
    if (observation.placement === 'symlink-to-source' && skillsConfig.sourceRepoPath !== undefined) {
      const canonicalSourceRepoPath = await fs.promises.realpath(skillsConfig.sourceRepoPath);
      isCanonicallyInsideSource = pathIsWithin(path.join(canonicalSourceRepoPath, 'skills'), canonicalSkillMdPath);
    }
    if (!(isLexicallyInsideProject && (isCanonicallyInsideProject || isCanonicallyInsideSource))) {
      throw new Error('project skill markdown resolves outside the allowed project');
    }
    return {
      ...(await readBoundedProjectSkillMarkdownFile(canonicalSkillMdPath, maxProjectSkillMarkdownBytes)),
      path: observedSkillMdPath,
      skillName: input.skillName,
    };
  };

  return {
    createTargetDirectory: (input) =>
      runAdapterOperation(async () => {
        const target = (await loadSnapshot()).targets.find((candidate) => candidate.id === input.targetId);
        if (!target) {
          throw new Error(`Unknown skill target: ${input.targetId}`);
        }
        await dependencies.workflows.createTargetDirectory({ path: target.path });
        return loadClientSnapshot();
      }),
    previewReconcileAll: () =>
      runAdapterOperation(async () => {
        const previewResult = await dependencies.workflows.previewReconcileAll({
          config: { ...(await loadConfig()) },
          homePath: dependencies.storage.home,
        });
        return {
          actions: previewResult.actions,
          snapshot: skillManagementSnapshotForClient(previewResult.snapshot),
        };
      }),
    readKnownProjectPaths: () => runAdapterOperation(readKnownProjectPaths),
    readMarkdown: (skillName) =>
      runAdapterOperation(async () => {
        const skillsConfig = parseSkillConfigInput((await loadConfig()).skills ?? {});
        if (skillsConfig.sourceRepoPath === undefined) {
          throw new Error('skills.sourceRepoPath is required before reading SKILL.md');
        }
        return dependencies.workflows.readMarkdown({ skillName, sourceRepoPath: skillsConfig.sourceRepoPath });
      }),
    readProjectInventories: () => runAdapterOperation(readProjectInventories),
    readProjectMarkdown: (input) => runAdapterOperation(() => readProjectMarkdown(input)),
    readSnapshot: () => runAdapterOperation(loadClientSnapshot),
    reconcileAll: () =>
      runAdapterOperation(async () => {
        const reconcileResult = await dependencies.workflows.reconcileAll({
          config: { ...(await loadConfig()) },
          homePath: dependencies.storage.home,
        });
        return { actions: reconcileResult.actions, snapshot: await loadClientSnapshot() };
      }),
    reconcileSkill: (skillName) =>
      runAdapterOperation(async () => {
        const reconcileResult = await dependencies.workflows.reconcileSkill({
          config: { ...(await loadConfig()) },
          homePath: dependencies.storage.home,
          skillName,
        });
        return { actions: reconcileResult.actions, snapshot: await loadClientSnapshot() };
      }),
    refreshSnapshot: () => runAdapterOperation(loadClientSnapshot),
    saveConfig: (skills) =>
      runAdapterOperation(async () => {
        await dependencies.updateConfig({
          storage: dependencies.storage,
          update: async (config) => {
            let updatedConfig: AiUsageConfig | undefined;
            await dependencies.workflows.writeConfig({
              config: { ...config },
              skills,
              writeConfig: (nextConfig) => {
                updatedConfig = nextConfig as AiUsageConfig;
                return Promise.resolve();
              },
            });
            if (updatedConfig === undefined) {
              throw new Error('Skill config update did not produce a configuration document');
            }
            return updatedConfig;
          },
        });
        return loadClientSnapshot();
      }),
    saveMarkdown: (input) =>
      runAdapterOperation(async () => {
        const skillsConfig = parseSkillConfigInput((await loadConfig()).skills ?? {});
        if (skillsConfig.sourceRepoPath === undefined) {
          throw new Error('skills.sourceRepoPath is required before writing SKILL.md');
        }
        const result = await dependencies.workflows.writeMarkdown({
          ...input,
          sourceRepoPath: skillsConfig.sourceRepoPath,
        });
        if (!result.ok) {
          return { reason: result.reason };
        }
        return {
          document: await dependencies.workflows.readMarkdown({
            skillName: input.skillName,
            sourceRepoPath: skillsConfig.sourceRepoPath,
          }),
          snapshot: await loadClientSnapshot(),
        };
      }),
    toggleSkill: (input) =>
      runAdapterOperation(async () => {
        const config = await loadConfig();
        const skillsConfig = parseSkillConfigInput(config.skills ?? {});
        if (skillsConfig.sourceRepoPath === undefined) {
          throw new Error('skills.sourceRepoPath is required before toggling skills');
        }
        await dependencies.workflows.toggleSkill({
          enabled: input.enabled,
          skillName: input.skillName,
          sourceRepoPath: skillsConfig.sourceRepoPath,
        });
        if (input.enabled) {
          return { actions: [], snapshot: await loadClientSnapshot() };
        }
        const reconcileResult = await dependencies.workflows.reconcileSkill({
          config: { ...config },
          homePath: dependencies.storage.home,
          skillName: input.skillName,
        });
        return { actions: reconcileResult.actions, snapshot: await loadClientSnapshot() };
      }),
  };
};

export const createSkillsServerDependencies = (
  options: { configCwd?: string; storage?: LocalHistoryStorageService } = {},
): SkillsServerAdapterDependencies => {
  const readKnownProjectSources: SkillsServerAdapterDependencies['readKnownProjectSources'] =
    options.storage === undefined
      ? ({ request }) => runKnownProjectSourcesRunner(request)
      : ({ request, storage }) =>
          Effect.runPromise(
            createKnownLocalProjectSources(request).pipe(Effect.provideService(LocalHistoryStorage, storage)),
          );

  return {
    configCwd: options.configCwd ?? process.cwd(),
    readConfig: ({ configCwd, storage }) =>
      Effect.runPromise(
        readMergedAiUsageConfigFrom(configCwd).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      ),
    readKnownProjectSources,
    storage: options.storage ?? createLocalHistoryStorage(),
    updateConfig: ({ storage, update }) =>
      Effect.runPromise(updateAiUsageConfig(update).pipe(Effect.provideService(LocalHistoryStorage, storage))),
    workflows: {
      createTargetDirectory: createSkillTargetDirectory,
      loadSnapshot: loadSkillManagementSnapshot,
      previewReconcileAll: previewReconcileAllActiveSkills,
      readMarkdown: readSkillMarkdown,
      reconcileAll: reconcileAllActiveSkills,
      reconcileSkill,
      scanProjects: scanProjectSkills,
      toggleSkill: toggleSkillEnabled,
      writeConfig: writeSkillManagementConfig,
      writeMarkdown: writeSkillMarkdown,
    },
  };
};

export const productionSkillsServerAdapter = createSkillsServerAdapter(createSkillsServerDependencies());

export const readSkillManagementSnapshotForServer = () => productionSkillsServerAdapter.readSnapshot();
export const readKnownSkillProjectPathsForServer = () => productionSkillsServerAdapter.readKnownProjectPaths();
export const writeSkillManagementConfigForServer = (skills: SkillManagementConfig) =>
  productionSkillsServerAdapter.saveConfig(skills);
export const toggleSkillEnabledForServer = (input: SkillToggleInput) =>
  productionSkillsServerAdapter.toggleSkill(input);
export const reconcileSkillForServer = (skillName: string) => productionSkillsServerAdapter.reconcileSkill(skillName);
export const reconcileAllActiveSkillsForServer = () => productionSkillsServerAdapter.reconcileAll();
export const previewReconcileAllActiveSkillsForServer = () => productionSkillsServerAdapter.previewReconcileAll();
export const createSkillTargetDirectoryForServer = (input: SkillTargetDirectoryInput) =>
  productionSkillsServerAdapter.createTargetDirectory(input);
export const readSkillProjectInventoriesForServer = () => productionSkillsServerAdapter.readProjectInventories();
export const readSkillMarkdownForServer = (skillName: string) => productionSkillsServerAdapter.readMarkdown(skillName);
export const writeSkillMarkdownForServer = (input: SkillMarkdownWriteInput) =>
  productionSkillsServerAdapter.saveMarkdown(input);

export const readProjectSkillMarkdownForServer = (
  input: ProjectSkillMarkdownInput,
  options: ReadProjectSkillMarkdownOptions = {},
): Promise<SkillsServerResult<ProjectSkillMarkdownDocument>> | SkillsServerResult<ProjectSkillMarkdownDocument> => {
  if (!(options.loadConfig || options.readKnownProjectPaths)) {
    return productionSkillsServerAdapter.readProjectMarkdown(input);
  }
  const dependencies = createSkillsServerDependencies({
    configCwd: path.dirname(path.resolve(input.projectPath)),
    storage: createLocalHistoryStorage(path.dirname(path.resolve(input.projectPath))),
  });
  return createSkillsServerAdapter({
    ...dependencies,
    ...(options.loadConfig === undefined ? {} : { readConfig: () => options.loadConfig!() }),
    ...(options.readKnownProjectPaths === undefined
      ? {}
      : {
          readKnownProjectSources: async () => {
            const result = await options.readKnownProjectPaths!();
            if (!result.ok) {
              throw new Error(result.error.message);
            }
            return {
              projectGroups: [],
              sources: result.data.map((entry) => ({
                harness: '',
                harnesses: [],
                harnessKey: '',
                harnessKeys: [],
                id: entry.path,
                machine: entry.machineLabel ?? '',
                machineId: '',
                project: entry.project,
                sessions: entry.sessions,
                sourcePath: entry.path,
                tokens: 0,
                gitRemote: '',
              })),
              warnings: [],
            };
          },
        }),
  }).readProjectMarkdown(input);
};
