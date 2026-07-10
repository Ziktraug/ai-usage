import { describe, expect, test } from 'bun:test';
import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
import type { UsageReportProjectSource } from '@ai-usage/report-core/report-data';
import { moveProjectSourcesToGroup } from './project-group-actions';

const source = (id: string, sourcePath: string): UsageReportProjectSource => ({
  gitRemote: '',
  id,
  machineId: 'machine-a',
  machineLabel: 'Machine A',
  project: id,
  sessions: 1,
  sourcePath,
  tokens: 10,
});

const sourceA = source('source-a', '/work/a');
const sourceB = source('source-b', '/work/b');
const sourceC = source('source-c', '/work/c');

const groups: ProjectGroupConfig[] = [
  {
    id: 'group-old',
    name: 'old',
    sources: [
      { machineId: 'machine-a', sourcePath: '/work/a' },
      { machineId: 'machine-a', sourcePath: '/work/b' },
    ],
  },
  {
    id: 'group-target',
    name: 'target',
    sources: [{ machineId: 'machine-a', sourcePath: '/work/c' }],
  },
];

describe('project group editor actions', () => {
  test('moves selected sources out of their old group when extending an existing group', () => {
    const result = moveProjectSourcesToGroup({
      createGroupId: 'unused',
      groupName: 'target',
      projectGroups: groups,
      projectSources: [sourceA, sourceB, sourceC],
      selectedSources: [sourceA],
    });

    expect(result).toEqual([
      {
        id: 'group-old',
        name: 'old',
        sources: [{ machineId: 'machine-a', sourcePath: '/work/b' }],
      },
      {
        id: 'group-target',
        name: 'target',
        sources: [
          { machineId: 'machine-a', sourcePath: '/work/c' },
          { machineId: 'machine-a', sourcePath: '/work/a' },
        ],
      },
    ]);
  });

  test('removes an emptied old group when creating a new group', () => {
    const result = moveProjectSourcesToGroup({
      createGroupId: 'group-new',
      groupName: 'new',
      projectGroups: [
        {
          id: 'group-old',
          name: 'old',
          sources: [{ machineId: 'machine-a', project: 'source-a' }],
        },
      ],
      projectSources: [sourceA],
      selectedSources: [sourceA],
    });

    expect(result).toEqual([
      {
        id: 'group-new',
        name: 'new',
        sources: [{ machineId: 'machine-a', sourcePath: '/work/a' }],
      },
    ]);
  });
});
