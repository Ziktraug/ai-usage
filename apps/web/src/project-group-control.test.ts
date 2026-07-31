import { expect, test } from 'bun:test';
import { buildProjectGroupReferenceCommand } from './project-group-control';

const PROJECT_SOURCE_REFERENCE_PATTERN = /^project-source:[a-f0-9]{64}$/;

test('replaces path selectors with stable opaque references before crossing the web boundary', async () => {
  const command = await buildProjectGroupReferenceCommand(
    [
      {
        id: 'group-a',
        name: 'Group A',
        sources: [
          { machineId: 'machine-a', sourcePath: '/private/worktree-a' },
          { machineId: 'machine-a', project: 'pathless-project' },
        ],
      },
    ],
    'revision-a',
  );

  expect(command).toMatchObject({
    command: 'replace-project-groups-by-reference',
    projectGroups: [{ id: 'group-a', name: 'Group A' }],
    revision: 'revision-a',
  });
  expect(command.projectGroups[0]?.sources).toHaveLength(2);
  expect(command.projectGroups[0]?.sources.every((reference) => PROJECT_SOURCE_REFERENCE_PATTERN.test(reference))).toBe(
    true,
  );
  expect(JSON.stringify(command)).not.toContain('/private');
  const repeated = await buildProjectGroupReferenceCommand(
    [{ id: 'group-a', name: 'Group A', sources: [{ machineId: 'machine-a', sourcePath: '/private/worktree-a' }] }],
    'revision-a',
  );
  expect(repeated.command).toBe('replace-project-groups-by-reference');
  expect(repeated.revision).toBe(command.revision);
  expect(repeated.projectGroups[0]?.sources[0]).toBe(command.projectGroups[0]?.sources[0]);
});
