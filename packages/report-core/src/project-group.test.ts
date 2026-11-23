import { describe, expect, test } from 'bun:test';
import {
  isProjectGroupConfig,
  isProjectSourceSelector,
  matchesProjectSourceSelector,
  normalizeProjectIdentity,
  parseProjectGroupConfigs,
  projectLabelWithMachine,
  projectSourceId,
  projectSourcePathFromId,
  projectSourceSelectorFor,
  projectSourceSelectorsEqual,
  uniqueProjectSourceSelectors,
} from './project-group';

describe('project groups', () => {
  test('normalizes project identity across case, spacing, and punctuation', () => {
    expect(normalizeProjectIdentity('  Acme / BUILD-host  ')).toBe('acme build host');
  });

  test('adds a machine label only when it disambiguates the project', () => {
    expect(projectLabelWithMachine('acme/app', 'app')).toBe('acme/app');
    expect(projectLabelWithMachine('Acme / Build Host', ' build-host ')).toBe('Acme / Build Host');
    expect(projectLabelWithMachine('acme/app', 'build-host')).toBe('acme/app — build-host');
    expect(projectLabelWithMachine('app/acme', 'app')).toBe('app/acme — app');
    expect(projectLabelWithMachine('happyapp', 'app')).toBe('happyapp — app');
  });

  test('uses machine and folder identity for project sources', () => {
    expect(projectSourceId({ machineId: 'machine-a', project: 'meridian', sourcePath: '/work/meridian' })).toBe(
      'machine-a|/work/meridian',
    );
    expect(projectSourceId({ machineId: 'machine-b', project: 'meridian', sourcePath: '/work/meridian' })).toBe(
      'machine-b|/work/meridian',
    );
    expect(projectSourceId({ machineId: 'machine-a', project: 'meridian' })).toBe('machine-a|meridian');
  });

  test('decodes the machine-prefixed path of a project source id only for that machine', () => {
    const id = projectSourceId({ machineId: 'machine-a', project: 'meridian', sourcePath: '/work/meridian' });
    expect(projectSourcePathFromId(id, 'machine-a')).toBe('/work/meridian');
    expect(projectSourcePathFromId('machine-a|/work/with|pipe', 'machine-a')).toBe('/work/with|pipe');
    expect(projectSourcePathFromId(id, 'machine-b')).toBeNull();
    expect(projectSourcePathFromId('machine-a|', 'machine-a')).toBeNull();
    expect(projectSourcePathFromId('machine-a', 'machine-a')).toBeNull();
    // Machine ids that prefix each other never decode across the boundary.
    expect(projectSourcePathFromId('machine-ab|/work/meridian', 'machine-a')).toBeNull();
    expect(projectSourcePathFromId('machine-a|/work/meridian', 'machine-ab')).toBeNull();
    expect(projectSourcePathFromId('machine-a|/work/meridian', 'machine')).toBeNull();
  });

  test('matches selectors conjunctively without machine labels', () => {
    const source = {
      machineId: 'machine-a',
      project: 'Meridian',
      sourcePath: '/work/meridian',
      gitRemote: 'nathan/meridian',
    };

    expect(matchesProjectSourceSelector(source, { machineId: 'machine-a', sourcePath: '/work/meridian' })).toBe(true);
    expect(matchesProjectSourceSelector(source, { machineId: 'machine-b', sourcePath: '/work/meridian' })).toBe(false);
    expect(matchesProjectSourceSelector(source, { project: 'meridian' })).toBe(true);
    expect(matchesProjectSourceSelector(source, { gitRemote: 'nathan/meridian' })).toBe(true);
    expect(matchesProjectSourceSelector(source, { gitRemote: 'other/meridian' })).toBe(false);
  });

  test('owns exact selector identity and deduplication', () => {
    const selector = projectSourceSelectorFor({
      gitRemote: 'nathan/meridian',
      machineId: 'machine-a',
      project: 'Meridian',
      sourcePath: '/work/meridian',
    });

    expect(selector).toEqual({
      gitRemote: 'nathan/meridian',
      machineId: 'machine-a',
      sourcePath: '/work/meridian',
    });
    expect(projectSourceSelectorsEqual({ project: 'Meridian' }, { project: 'meridian' })).toBe(true);
    expect(uniqueProjectSourceSelectors([{ project: 'Meridian' }, { project: 'meridian' }])).toEqual([
      { project: 'Meridian' },
    ]);
  });

  test('validates selectors and group configs', () => {
    expect(isProjectSourceSelector({})).toBe(false);
    expect(isProjectSourceSelector({ machineId: '' })).toBe(false);
    expect(isProjectSourceSelector({ machineId: 'machine-a' })).toBe(true);

    expect(
      isProjectGroupConfig({
        id: 'group-1',
        name: 'meridian',
        sources: [{ machineId: 'machine-a', sourcePath: '/work/meridian' }],
      }),
    ).toBe(true);
    expect(isProjectGroupConfig({ id: 'group-1', name: 'meridian', sources: [] })).toBe(false);
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
          sources: [{ machineId: 'machine-a', project: 'Meridian' }],
        },
        {
          id: 'group-2',
          name: 'precise',
          sources: [{ machineId: 'machine-a', sourcePath: '/work/meridian' }],
        },
      ]),
    ).toThrow('overlapping selectors');
  });
});
