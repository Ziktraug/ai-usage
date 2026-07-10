import { describe, expect, test } from 'bun:test';
import {
  isProjectGroupConfig,
  isProjectSourceSelector,
  matchesProjectSourceSelector,
  parseProjectGroupConfigs,
  projectSourceId,
} from './project-group';

describe('project groups', () => {
  test('uses machine and folder identity for project sources', () => {
    expect(projectSourceId({ machineId: 'machine-a', project: 'exalibur', sourcePath: '/work/exalibur' })).toBe(
      'machine-a|/work/exalibur',
    );
    expect(projectSourceId({ machineId: 'machine-b', project: 'exalibur', sourcePath: '/work/exalibur' })).toBe(
      'machine-b|/work/exalibur',
    );
    expect(projectSourceId({ machineId: 'machine-a', project: 'exalibur' })).toBe('machine-a|exalibur');
  });

  test('matches selectors conjunctively without machine labels', () => {
    const source = {
      machineId: 'machine-a',
      project: 'Exalibur',
      sourcePath: '/work/exalibur',
      gitRemote: 'nathan/exalibur',
    };

    expect(matchesProjectSourceSelector(source, { machineId: 'machine-a', sourcePath: '/work/exalibur' })).toBe(true);
    expect(matchesProjectSourceSelector(source, { machineId: 'machine-b', sourcePath: '/work/exalibur' })).toBe(false);
    expect(matchesProjectSourceSelector(source, { project: 'exalibur' })).toBe(true);
    expect(matchesProjectSourceSelector(source, { gitRemote: 'nathan/exalibur' })).toBe(true);
    expect(matchesProjectSourceSelector(source, { gitRemote: 'other/exalibur' })).toBe(false);
  });

  test('validates selectors and group configs', () => {
    expect(isProjectSourceSelector({})).toBe(false);
    expect(isProjectSourceSelector({ machineId: '' })).toBe(false);
    expect(isProjectSourceSelector({ machineId: 'machine-a' })).toBe(true);

    expect(
      isProjectGroupConfig({
        id: 'group-1',
        name: 'exalibur',
        sources: [{ machineId: 'machine-a', sourcePath: '/work/exalibur' }],
      }),
    ).toBe(true);
    expect(isProjectGroupConfig({ id: 'group-1', name: 'exalibur', sources: [] })).toBe(false);
    expect(isProjectGroupConfig({ id: 'group-1', sources: [{ machineId: 'machine-a' }] })).toBe(false);
  });

  test('rejects duplicate group ids across the full config', () => {
    expect(() =>
      parseProjectGroupConfigs([
        {
          id: 'group-1',
          name: 'frontend',
          sources: [{ machineId: 'machine-a', sourcePath: '/work/frontend' }],
        },
        {
          id: 'group-1',
          name: 'backend',
          sources: [{ machineId: 'machine-a', sourcePath: '/work/backend' }],
        },
      ]),
    ).toThrow('duplicate id "group-1"');
  });

  test('rejects selectors from different groups that can match the same project source', () => {
    expect(() =>
      parseProjectGroupConfigs([
        {
          id: 'group-1',
          name: 'broad',
          sources: [{ machineId: 'machine-a', project: 'Exalibur' }],
        },
        {
          id: 'group-2',
          name: 'precise',
          sources: [{ machineId: 'machine-a', sourcePath: '/work/exalibur' }],
        },
      ]),
    ).toThrow('overlapping selectors');
  });
});
