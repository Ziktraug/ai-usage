import {
  parseSkillConfigInput,
  parseSkillMarkdownWriteInput,
  parseSkillName,
  parseSkillTargetDirectoryInput,
  parseSkillToggleInput,
  projectSkillDirectories,
} from '@ai-usage/skills';
import { createServerFn } from '@tanstack/solid-start';
import type { ProjectSkillMarkdownInput } from './skills.server';

export type { KnownSkillProjectPath } from './skills.server';

export const getSkillManagementSnapshot = createServerFn({ method: 'GET' }).handler(() =>
  import('./skills.server').then(({ readSkillManagementSnapshotForServer }) => readSkillManagementSnapshotForServer()),
);

export const getKnownSkillProjectPaths = createServerFn({ method: 'GET' }).handler(() =>
  import('./skills.server').then(({ readKnownSkillProjectPathsForServer }) => readKnownSkillProjectPathsForServer()),
);

export const saveSkillManagementConfig = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillConfigInput(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ writeSkillManagementConfigForServer }) =>
      writeSkillManagementConfigForServer(data),
    ),
  );

export const toggleManagedSkill = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillToggleInput(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ toggleSkillEnabledForServer }) => toggleSkillEnabledForServer(data)),
  );

export const reconcileManagedSkill = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillName(input))
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
  .validator((input) => parseSkillTargetDirectoryInput(input))
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
    runtimeDirId: runtimeDirId as ProjectSkillMarkdownInput['runtimeDirId'],
    skillName: parseSkillName(record.skillName),
  };
};

export const getProjectSkillMarkdown = createServerFn({ method: 'GET' })
  .validator((input) => parseProjectSkillMarkdownInput(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ readProjectSkillMarkdownForServer }) => readProjectSkillMarkdownForServer(data)),
  );

export const getManagedSkillMarkdown = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillName(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ readSkillMarkdownForServer }) => readSkillMarkdownForServer(data)),
  );

export const saveManagedSkillMarkdown = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillMarkdownWriteInput(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ writeSkillMarkdownForServer }) => writeSkillMarkdownForServer(data)),
  );
