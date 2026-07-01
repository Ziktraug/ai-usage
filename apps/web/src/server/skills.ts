import {
  parseSkillConfigInput,
  parseSkillName,
  parseSkillTargetDirectoryInput,
  parseSkillToggleInput,
} from '@ai-usage/skills';
import { createServerFn } from '@tanstack/solid-start';

export const getSkillManagementSnapshot = createServerFn({ method: 'GET' }).handler(() =>
  import('./skills.server').then(({ readSkillManagementSnapshotForServer }) => readSkillManagementSnapshotForServer()),
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

export const createManagedSkillTargetDirectory = createServerFn({ method: 'POST' })
  .validator((input) => parseSkillTargetDirectoryInput(input))
  .handler(({ data }) =>
    import('./skills.server').then(({ createSkillTargetDirectoryForServer }) =>
      createSkillTargetDirectoryForServer(data),
    ),
  );
