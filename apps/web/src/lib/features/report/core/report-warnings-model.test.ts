import { describe, expect, test } from 'bun:test';
import { commonDirectoryPrefix, presentReportWarning, reportNoticesSummary, tildePath } from './report-warnings-model';

const machine = '87df7ab3-689b-4765-9379-07fc005a5a5e';
const twin = 'aaaa1111-689b-4765-9379-07fc005a5a5e';

describe('report warning presentation', () => {
  test('collapses selector paths to their common directory, per machine, keeping extra predicates', () => {
    const notice = presentReportWarning(
      {
        groupId: 'g1',
        groupName: 'coding-challenge',
        message: 'Project group "coding-challenge" has unmatched selectors: machine=…',
        reason: 'partial-group',
        selectors: [
          { machineId: machine, sourcePath: '/Users/nathan/projects/coding-challenge/react/apps/dashboard' },
          {
            gitRemote: 'git@github.com:x/coding-challenge.git',
            machineId: machine,
            sourcePath: '/Users/nathan/projects/coding-challenge/.claude/worktrees/orbital',
          },
          { machineId: machine, sourcePath: '/Users/nathan/projects/coding-challenge' },
          { project: 'orbital', sourcePath: '/home/other/thing' },
          { machineId: machine, project: 'loose' },
        ],
      },
      (id) => (id === machine ? 'MacBook' : id),
    );
    expect(notice.headline).toBe('Project group "coding-challenge": 5 configured sources matched nothing');
    expect(notice.selectorCount).toBe(5);
    expect(notice.selectorGroups).toEqual([
      {
        machine: 'MacBook',
        machineId: machine,
        otherSelectors: ['project=loose'],
        paths: [
          'coding-challenge/react/apps/dashboard',
          'coding-challenge/.claude/worktrees/orbital (git=git@github.com:x/coding-challenge.git)',
          'coding-challenge',
        ],
        prefix: '~/projects',
      },
      { machine: 'Any machine', machineId: '', otherSelectors: [], paths: ['~/thing (project=orbital)'], prefix: null },
    ]);
  });

  test('keeps two machines with the same label apart by id', () => {
    const notice = presentReportWarning(
      {
        groupId: 'g1',
        groupName: 'x',
        message: 'x',
        reason: 'partial-group',
        selectors: [
          { machineId: machine, sourcePath: '/a' },
          { machineId: twin, sourcePath: '/b' },
        ],
      },
      () => 'Laptop',
    );
    expect(notice.selectorGroups.map((group) => [group.machine, group.machineId])).toEqual([
      ['Laptop', machine],
      ['Laptop', twin],
    ]);
  });

  test('names an unresolved machine by a shortened id instead of hiding it', () => {
    const notice = presentReportWarning({
      groupId: 'g1',
      groupName: 'Exalibur',
      message: 'x',
      reason: 'partial-group',
      selectors: [{ machineId: machine, sourcePath: '/Users/nathan/projects/Exalibur' }],
    });
    expect(notice.headline).toBe('Project group "Exalibur": 1 configured source matched nothing');
    expect(notice.selectorGroups[0]?.machine).toBe('Unknown machine 87df7ab3');
    expect(notice.selectorGroups[0]?.paths).toEqual(['~/projects/Exalibur']);
  });

  test('keeps collector warnings verbatim and the harness separate', () => {
    const notice = presentReportWarning({ harness: 'codex', message: 'rejected 9 records', path: '/x' });
    expect(notice).toMatchObject({
      harness: 'codex',
      headline: 'rejected 9 records',
      selectorCount: 0,
      selectorGroups: [],
    });
  });

  test('prefix never equals one of the paths and needs at least two paths', () => {
    expect(commonDirectoryPrefix(['/a/b/c'])).toBeNull();
    expect(commonDirectoryPrefix(['/a/b/c', '/a/b'])).toBe('/a');
    expect(commonDirectoryPrefix(['/a/x', '/b/y'])).toBeNull();
    expect(tildePath('/home/nathan/Projects/x')).toBe('~/Projects/x');
    expect(tildePath('/srv/data')).toBe('/srv/data');
  });

  test('states only the consequences the present kinds carry', () => {
    const grouping = { groupId: 'g', groupName: 'g', message: 'm', reason: 'partial-group' as const, selectors: [] };
    const collector = { harness: 'codex', message: 'rejected' };
    expect(reportNoticesSummary([grouping, grouping], 0)).toBe('2 notices — project grouping is incomplete');
    expect(reportNoticesSummary([collector], 0)).toBe('1 notice — totals use available rows only');
    expect(reportNoticesSummary([grouping, collector], 3)).toBe(
      '2 notices · 3 support items omitted — project grouping is incomplete, totals use available rows only, bounded summary',
    );
    expect(reportNoticesSummary([], 1)).toBe('1 support item omitted — bounded summary');
  });
});
