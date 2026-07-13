import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseSkillConfigInput } from './config';
import type {
  ProjectSkillInventory,
  SkillManagementConfigDocument,
  SkillManagementSnapshot,
  SkillMarkdownDocument,
  SkillMarkdownWriteInput,
  SkillReconcileResult,
  SkillToggleInput,
} from './contracts';
import { readBoundedRegularFile } from './filesystem';
import { scanProjectSkills } from './project-scan';
import { parseSkillName } from './shared';
import { readSkillMarkdown, writeSkillMarkdown } from './skill-markdown-io';
import {
  createSkillTargetDirectory,
  loadSkillManagementSnapshot,
  previewReconcileAllActiveSkills,
  reconcileAllActiveSkills,
  reconcileSkill,
  toggleSkillEnabled,
  writeSkillManagementConfig,
} from './workflows';

const maxProjectSkillMarkdownBytes = 65_536;

export interface SkillsProjectMarkdownInput {
  projectPath: string;
  runtimeDirId: string;
  skillName: string;
}

export interface SkillsProjectMarkdownDocument {
  content: string;
  path: string;
  skillName: string;
  truncated: boolean;
}

export interface SkillsApplicationPorts {
  homePath: string;
  projectPaths?(): Promise<readonly string[]>;
  readConfig(): Promise<SkillManagementConfigDocument>;
  writeConfig(config: SkillManagementConfigDocument): Promise<void>;
}

export interface SkillsApplicationWorkflows {
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
}

export interface SkillsApplication {
  createTarget(targetId: string): Promise<SkillManagementSnapshot>;
  previewReconcile(): Promise<SkillReconcileResult>;
  readMarkdown(skillName: string): Promise<SkillMarkdownDocument>;
  readProjectInventories(): Promise<readonly ProjectSkillInventory[]>;
  readProjectMarkdown(input: SkillsProjectMarkdownInput): Promise<SkillsProjectMarkdownDocument>;
  readSnapshot(): Promise<SkillManagementSnapshot>;
  reconcileAll(): Promise<SkillReconcileResult>;
  reconcileSkill(skillName: string): Promise<SkillReconcileResult>;
  toggleSkill(input: SkillToggleInput): Promise<SkillReconcileResult>;
  writeConfig(skills: unknown): Promise<SkillManagementSnapshot>;
  writeMarkdown(
    input: SkillMarkdownWriteInput,
  ): Promise<
    | { reason: 'conflict' | 'not-found' | 'too-large' }
    | { document: SkillMarkdownDocument; snapshot: SkillManagementSnapshot }
  >;
}

const pathIsWithin = (parentPath: string, candidatePath: string): boolean => {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
  );
};

export const readBoundedProjectSkillMarkdown = async (
  filePath: string,
  maxBytes = maxProjectSkillMarkdownBytes,
): Promise<{ content: string; truncated: boolean }> => {
  const fileRead = await readBoundedRegularFile(filePath, maxBytes);
  if (fileRead.kind === 'too-large') {
    return { content: fileRead.buffer.toString('utf8'), truncated: true };
  }
  if (fileRead.kind !== 'ok') {
    throw new Error('project skill markdown must be a readable regular file');
  }
  return { content: fileRead.buffer.toString('utf8'), truncated: false };
};

/** Owns complete Skills use cases; hosts supply only config and curated project paths. */
export const createSkillsApplication = (
  ports: SkillsApplicationPorts,
  workflows: SkillsApplicationWorkflows = {
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
): SkillsApplication => {
  const snapshotInput = async () => ({ config: await ports.readConfig(), homePath: ports.homePath });
  const readSnapshot = async () => workflows.loadSnapshot(await snapshotInput());
  const configuredSourceRepoPath = async (): Promise<string> => {
    const config = parseSkillConfigInput((await ports.readConfig()).skills ?? {});
    if (config.sourceRepoPath === undefined) {
      throw new Error('skills.sourceRepoPath is required');
    }
    return config.sourceRepoPath;
  };
  const projectPaths = async (): Promise<readonly string[]> => {
    const config = parseSkillConfigInput((await ports.readConfig()).skills ?? {});
    return [
      ...new Set(
        [...(config.projectPaths ?? []), ...((await ports.projectPaths?.()) ?? [])].map((projectPath) =>
          path.resolve(projectPath),
        ),
      ),
    ];
  };
  const readProjectInventories = async (): Promise<readonly ProjectSkillInventory[]> => {
    const config = parseSkillConfigInput((await ports.readConfig()).skills ?? {});
    const paths = await projectPaths();
    if (paths.length === 0) {
      return [];
    }
    return workflows.scanProjects({
      projectPaths: paths,
      ...(config.sourceRepoPath === undefined ? {} : { sourceRepoPath: config.sourceRepoPath }),
      ...(config.tokenThresholds === undefined ? {} : { options: { tokenThresholds: config.tokenThresholds } }),
    });
  };
  return {
    createTarget: async (targetId) => {
      const snapshot = await readSnapshot();
      const target = snapshot.targets.find((candidate) => candidate.id === targetId);
      if (!target) {
        throw new Error(`Unknown skill target: ${targetId}`);
      }
      await workflows.createTargetDirectory({ path: target.path });
      return readSnapshot();
    },
    previewReconcile: async () => workflows.previewReconcileAll(await snapshotInput()),
    readMarkdown: async (skillName) =>
      workflows.readMarkdown({
        skillName: parseSkillName(skillName),
        sourceRepoPath: await configuredSourceRepoPath(),
      }),
    readProjectInventories,
    readProjectMarkdown: async (input) => {
      const skillName = parseSkillName(input.skillName);
      const allowedPaths = new Set(await projectPaths());
      const projectPath = path.resolve(input.projectPath);
      if (!allowedPaths.has(projectPath)) {
        throw new Error('project path is not allowed');
      }
      const config = parseSkillConfigInput((await ports.readConfig()).skills ?? {});
      const inventories = await workflows.scanProjects({
        projectPaths: [projectPath],
        ...(config.sourceRepoPath === undefined ? {} : { sourceRepoPath: config.sourceRepoPath }),
        ...(config.tokenThresholds === undefined ? {} : { options: { tokenThresholds: config.tokenThresholds } }),
      });
      const observation = inventories
        .find((inventory) => path.resolve(inventory.projectPath) === projectPath)
        ?.observations.find(
          (candidate) => candidate.name === skillName && candidate.runtimeDirId === input.runtimeDirId,
        );
      if (!(observation?.markdownReadable && observation.placement !== 'external-symlink')) {
        throw new Error('project skill markdown is not readable');
      }
      const observedSkillMdPath = path.resolve(observation.skillMdPath);
      const [canonicalProjectPath, canonicalSkillMdPath] = await Promise.all([
        realpath(projectPath),
        realpath(observedSkillMdPath),
      ]);
      const canonicalSourcePath =
        observation.placement === 'symlink-to-source' && config.sourceRepoPath
          ? path.join(await realpath(config.sourceRepoPath), 'skills')
          : undefined;
      const authorized =
        pathIsWithin(projectPath, observedSkillMdPath) &&
        (pathIsWithin(canonicalProjectPath, canonicalSkillMdPath) ||
          (canonicalSourcePath !== undefined && pathIsWithin(canonicalSourcePath, canonicalSkillMdPath)));
      if (!authorized) {
        throw new Error('project skill markdown resolves outside the allowed project');
      }
      return {
        ...(await readBoundedProjectSkillMarkdown(canonicalSkillMdPath)),
        path: observedSkillMdPath,
        skillName,
      };
    },
    readSnapshot,
    reconcileAll: async () => workflows.reconcileAll(await snapshotInput()),
    reconcileSkill: async (skillName) =>
      workflows.reconcileSkill({ ...(await snapshotInput()), skillName: parseSkillName(skillName) }),
    toggleSkill: async (input) => {
      const sourceRepoPath = await configuredSourceRepoPath();
      await workflows.toggleSkill({ ...input, sourceRepoPath });
      return input.enabled
        ? { actions: [], snapshot: await readSnapshot() }
        : workflows.reconcileSkill({ ...(await snapshotInput()), skillName: input.skillName });
    },
    writeConfig: async (skills) => {
      const config = await ports.readConfig();
      await workflows.writeConfig({ config, skills, writeConfig: ports.writeConfig });
      return readSnapshot();
    },
    writeMarkdown: async (input) => {
      const sourceRepoPath = await configuredSourceRepoPath();
      const result = await workflows.writeMarkdown({ ...input, sourceRepoPath });
      if (!result.ok) {
        return { reason: result.reason };
      }
      return {
        document: await workflows.readMarkdown({ skillName: input.skillName, sourceRepoPath }),
        snapshot: await readSnapshot(),
      };
    },
  };
};
