import { createServerFn } from '@tanstack/solid-start';
import { type ProjectRuntimeDirId, projectSkillDirectories } from '../project-skill-directories';

export type { KnownSkillProjectPath } from './skills.server';

type JsonRecord = Record<string, unknown>;

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const targetIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const maxSkillMarkdownBytes = 256 * 1024;

const assertRecord = (input: unknown, label: string): JsonRecord => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as JsonRecord;
};

const parseRequiredString = (input: unknown, label: string): string => {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return input;
};

const parseOptionalStringArray = (input: unknown, label: string): readonly string[] | undefined => {
  if (input === undefined) {
    return;
  }
  if (!(Array.isArray(input) && input.every((value) => typeof value === 'string' && value.trim().length > 0))) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return input;
};

const parseSkillNameInput = (input: unknown): string => {
  if (typeof input !== 'string' || !skillNamePattern.test(input)) {
    throw new Error('skill name must be lowercase kebab-case');
  }
  return input;
};

const parseSkillConfigInputForClient = (input: unknown) => {
  const record = assertRecord(input, 'skills config');
  if (record.sourceRepoPath !== undefined) {
    parseRequiredString(record.sourceRepoPath, 'sourceRepoPath');
  }
  if (record.projectsRootPath !== undefined) {
    parseRequiredString(record.projectsRootPath, 'projectsRootPath');
  }
  parseOptionalStringArray(record.projectPaths, 'projectPaths');
  parseOptionalStringArray(record.ignoredTargetFindings, 'ignoredTargetFindings');
  return record;
};

const parseSkillToggleInputForClient = (input: unknown) => {
  const record = assertRecord(input, 'skill toggle input');
  if (typeof record.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  return {
    enabled: record.enabled,
    skillName: parseSkillNameInput(record.skillName),
  };
};

const parseSkillTargetDirectoryInputForClient = (input: unknown) => {
  const record = assertRecord(input, 'skill target directory input');
  const targetId = record.targetId;
  if (typeof targetId !== 'string' || !targetIdPattern.test(targetId)) {
    throw new Error('target id must be lowercase kebab-case');
  }
  return { targetId };
};

const parseSkillMarkdownWriteInputForClient = (input: unknown) => {
  const record = assertRecord(input, 'skill markdown write input');
  const content = typeof record.content === 'string' ? record.content : undefined;
  if (content === undefined) {
    throw new Error('content must be a string');
  }
  if (new TextEncoder().encode(content).byteLength > maxSkillMarkdownBytes) {
    throw new Error('content must be at most 262144 bytes');
  }
  const baseSha256 = parseRequiredString(record.baseSha256, 'baseSha256');
  if (!sha256Pattern.test(baseSha256)) {
    throw new Error('baseSha256 must be a 64-character lowercase hex string');
  }
  return {
    baseSha256,
    content,
    skillName: parseSkillNameInput(record.skillName),
  };
};

export const getSkillManagementSnapshot = createServerFn({ method: 'GET' }).handler(() =>
  import('./skills.server').then(({ readSkillManagementSnapshotForServer }) => readSkillManagementSnapshotForServer()),
);

export const getKnownSkillProjectPaths = createServerFn({ method: 'GET' }).handler(() =>
  import('./skills.server').then(({ readKnownSkillProjectPathsForServer }) => readKnownSkillProjectPathsForServer()),
);

export const saveSkillManagementConfig = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillConfigInputForClient(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ writeSkillManagementConfigForServer }) =>
      writeSkillManagementConfigForServer(data),
    ),
  );

export const toggleManagedSkill = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillToggleInputForClient(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ toggleSkillEnabledForServer }) => toggleSkillEnabledForServer(data)),
  );

export const reconcileManagedSkill = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillNameInput(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ reconcileSkillForServer }) => reconcileSkillForServer(data)),
  );

export const reconcileAllManagedSkills = createServerFn({ method: 'POST' }).handler(() =>
  import('./skills.server').then(({ reconcileAllActiveSkillsForServer }) => reconcileAllActiveSkillsForServer()),
);

export const previewReconcileAllManagedSkills = createServerFn({ method: 'GET' }).handler(() =>
  import('./skills.server').then(({ previewReconcileAllActiveSkillsForServer }) =>
    previewReconcileAllActiveSkillsForServer(),
  ),
);

export const createManagedSkillTargetDirectory = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillTargetDirectoryInputForClient(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ createSkillTargetDirectoryForServer }) =>
      createSkillTargetDirectoryForServer(data),
    ),
  );

export const getSkillProjectInventories = createServerFn({ method: 'GET' }).handler(() =>
  import('./skills.server').then(({ readSkillProjectInventoriesForServer }) => readSkillProjectInventoriesForServer()),
);

const projectRuntimeDirectoryIds = new Set<string>(projectSkillDirectories.map((directory) => directory.id));

const parseProjectSkillMarkdownInput = (input: unknown) => {
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
    runtimeDirId: runtimeDirId as ProjectRuntimeDirId,
    skillName: parseSkillNameInput(record.skillName),
  };
};

export const getProjectSkillMarkdown = createServerFn({ method: 'GET' })
  .validator((input) => parseProjectSkillMarkdownInput(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ readProjectSkillMarkdownForServer }) => readProjectSkillMarkdownForServer(data)),
  );

export const getManagedSkillMarkdown = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillNameInput(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ readSkillMarkdownForServer }) => readSkillMarkdownForServer(data)),
  );

export const saveManagedSkillMarkdown = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillMarkdownWriteInputForClient(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ writeSkillMarkdownForServer }) => writeSkillMarkdownForServer(data)),
  );
