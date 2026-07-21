import { parseSkillConfigInput } from '@ai-usage/skills/config';
import { createServerFn } from '@tanstack/solid-start';
import { type ProjectRuntimeDirId, projectSkillDirectories } from '../project-skill-directories';
import { skillNameInputForClient, targetIdInputForClient } from './skill-input-validation';
import type { SkillsServerAdapter } from './skills-contracts';

export type { KnownSkillProjectPath } from './skills-contracts';

type JsonRecord = Record<string, unknown>;

const sha256Pattern = /^[a-f0-9]{64}$/;
const maxSkillMarkdownBytes = 256 * 1024;

const loadSkillsServerAdapter = async (): Promise<SkillsServerAdapter> => {
  const [{ assertOutsideDemo }, { getServerRuntimeMode }] = await Promise.all([
    import('./demo-boundary.server'),
    import('./runtime-mode.server'),
  ]);
  const runtimeMode = getServerRuntimeMode();
  assertOutsideDemo(runtimeMode);
  if (runtimeMode === 'e2e') {
    const fixture = await import('./skills-e2e-fixture.server');
    return {
      createTargetDirectory: fixture.createE2ESkillTargetDirectory,
      previewReconcileAll: fixture.previewE2EReconcileAllSkills,
      readKnownProjectPaths: fixture.readE2EKnownSkillProjectPaths,
      readMarkdown: fixture.readE2ESkillMarkdown,
      readProjectInventories: fixture.readE2ESkillProjectInventories,
      readProjectMarkdown: fixture.readE2EProjectSkillMarkdown,
      readSnapshot: fixture.readE2ESkillManagementSnapshot,
      reconcileAll: fixture.reconcileAllE2ESkills,
      reconcileSkill: fixture.reconcileE2ESkill,
      refreshSnapshot: fixture.readE2ERefreshedSkillManagementSnapshot,
      saveConfig: fixture.writeE2ESkillManagementConfig,
      saveMarkdown: fixture.writeE2ESkillMarkdown,
      toggleSkill: fixture.toggleE2ESkill,
    };
  }

  const server = await import('./skills.server');
  return server.productionSkillsServerAdapter;
};

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

const parseSkillToggleInputForClient = (input: unknown) => {
  const record = assertRecord(input, 'skill toggle input');
  if (typeof record.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  return {
    enabled: record.enabled,
    skillName: skillNameInputForClient(record.skillName),
  };
};

const parseSkillTargetDirectoryInputForClient = (input: unknown) => {
  const record = assertRecord(input, 'skill target directory input');
  return { targetId: targetIdInputForClient(record.targetId) };
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
    skillName: skillNameInputForClient(record.skillName),
  };
};

export const getSkillManagementSnapshot = createServerFn({ method: 'GET' }).handler(async () => {
  const server = await loadSkillsServerAdapter();
  const result = await server.readSnapshot();
  return result;
});

export const refreshSkillManagementSnapshot = createServerFn({ method: 'GET' }).handler(async () => {
  const server = await loadSkillsServerAdapter();
  const result = await server.refreshSnapshot();
  return result;
});

export const getKnownSkillProjectPaths = createServerFn({ method: 'GET' }).handler(async () => {
  const server = await loadSkillsServerAdapter();
  const result = await server.readKnownProjectPaths();
  return result;
});

export const saveSkillManagementConfig = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillConfigInput(input))
  .handler(async ({ data }) => {
    const server = await loadSkillsServerAdapter();
    const result = await server.saveConfig(data);
    return result;
  });

export const toggleManagedSkill = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillToggleInputForClient(input))
  .handler(async ({ data }) => {
    const server = await loadSkillsServerAdapter();
    const result = await server.toggleSkill(data);
    return result;
  });

export const reconcileManagedSkill = createServerFn({ method: 'POST' })
  .validator((input) => skillNameInputForClient(input))
  .handler(async ({ data }) => {
    const server = await loadSkillsServerAdapter();
    const result = await server.reconcileSkill(data);
    return result;
  });

export const reconcileAllManagedSkills = createServerFn({ method: 'POST' }).handler(async () => {
  const server = await loadSkillsServerAdapter();
  const result = await server.reconcileAll();
  return result;
});

export const previewReconcileAllManagedSkills = createServerFn({ method: 'GET' }).handler(async () => {
  const server = await loadSkillsServerAdapter();
  const result = await server.previewReconcileAll();
  return result;
});

export const createManagedSkillTargetDirectory = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillTargetDirectoryInputForClient(input))
  .handler(async ({ data }) => {
    const server = await loadSkillsServerAdapter();
    const result = await server.createTargetDirectory(data);
    return result;
  });

export const getSkillProjectInventories = createServerFn({ method: 'GET' }).handler(async () => {
  const server = await loadSkillsServerAdapter();
  const result = await server.readProjectInventories();
  return result;
});

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
    skillName: skillNameInputForClient(record.skillName),
  };
};

export const getProjectSkillMarkdown = createServerFn({ method: 'GET' })
  .validator((input) => parseProjectSkillMarkdownInput(input))
  .handler(async ({ data }) => {
    const server = await loadSkillsServerAdapter();
    const result = await server.readProjectMarkdown(data);
    return result;
  });

export const getManagedSkillMarkdown = createServerFn({ method: 'POST' })
  .validator((input) => skillNameInputForClient(input))
  .handler(async ({ data }) => {
    const server = await loadSkillsServerAdapter();
    const result = await server.readMarkdown(data);
    return result;
  });

export const saveManagedSkillMarkdown = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillMarkdownWriteInputForClient(input))
  .handler(async ({ data }) => {
    const server = await loadSkillsServerAdapter();
    const result = await server.saveMarkdown(data);
    return result;
  });
