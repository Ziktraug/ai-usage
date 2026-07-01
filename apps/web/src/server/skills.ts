import { createServerFn } from '@tanstack/solid-start';

export const getSkillManagementSnapshot = createServerFn({ method: 'GET' }).handler(() =>
  import('./skills.server').then(({ readSkillManagementSnapshotForServer }) => readSkillManagementSnapshotForServer()),
);
