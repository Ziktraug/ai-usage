import { describe, expect, test } from 'bun:test';
import type { UsageReportProjectGroup, UsageReportProjectSource } from '@ai-usage/report-core/report-data';
import type { ProjectGroup } from './dashboard-analytics';
import {
  projectDataQualityLabel,
  projectIdentityPresentation,
  projectLinesPresentation,
  projectSearchRows,
  projectsEmptyMessage,
} from './project-presentation';

const source = (
  id: string,
  machineId: string,
  machineLabel: string,
  project: string,
  sessions = 1,
  tokens = 0,
): UsageReportProjectSource => ({
  gitRemote: '',
  id,
  machineId,
  machineLabel,
  project,
  sessions,
  sourcePath: `/home/alex/${project || 'unknown'}`,
  tokens,
});

const catalogueGroup = (
  id: string,
  name: string,
  grouped: boolean,
  sources: readonly UsageReportProjectSource[],
): UsageReportProjectGroup => ({
  cache: 0,
  cost: 0,
  fresh: 0,
  grouped,
  id,
  linesAdded: 0,
  linesDeleted: 0,
  name,
  priced: 0,
  sessions: sources.length,
  sources: [...sources],
  tokens: 0,
  tools: 0,
  turns: 0,
});

const project = (key: string, label: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup => ({
  cache: 0,
  cost: 0,
  fresh: 0,
  key,
  label,
  lineMeasurement: { measuredSessions: 0, totalSessions: 0 },
  linesAdded: 0,
  linesDeleted: 0,
  priced: 0,
  sessions: 0,
  tools: 0,
  turns: 0,
  ...overrides,
});

describe('project data-quality presentation', () => {
  test('classifies exact filename, worktree, and missing-project shapes case-insensitively', () => {
    expect(projectDataQualityLabel('usage.csv')).toBe('Filename-like');
    expect(projectDataQualityLabel('REPORT.CSV')).toBe('Filename-like');
    expect(projectDataQualityLabel('/tmp/imports/Usage.CsV')).toBe('Filename-like');
    expect(projectDataQualityLabel('agent-a15e8356ff54ade2a')).toBe('Worktree-like');
    expect(projectDataQualityLabel('WORKTREE-Feature-12')).toBe('Worktree-like');
    expect(projectDataQualityLabel('/repo/.claude/worktrees/agent-a1')).toBe('Worktree-like');
    expect(projectDataQualityLabel('(unknown)')).toBe('No detected project');
  });

  test('leaves ambiguous labels unbadged', () => {
    for (const label of [
      '',
      'report.csv.json',
      'agent-',
      'agent-a_b',
      'agent a',
      'worktree--',
      'my-agent-a1',
      'agent-a1 — Build Host',
      '(Unknown)',
    ]) {
      expect(projectDataQualityLabel(label)).toBeNull();
    }
  });
});

describe('project breakdown presentation', () => {
  const fixtureA = catalogueGroup('source:fixture-a', 'fixture-app — Fixture Machine', false, [
    source('fixture-a', 'machine-a', 'Fixture Machine', 'fixture-app'),
  ]);
  const fixtureB = catalogueGroup('source:fixture-b', 'fixture-app — Fixture Machine Secondary', false, [
    source('fixture-b', 'machine-b', 'Fixture Machine Secondary', 'fixture-app'),
  ]);
  const shared = catalogueGroup('group:shared', 'Shared tooling', true, [
    source('fixture-a-shared', 'machine-a', 'Fixture Machine', 'shared-a'),
    source('fixture-b-shared', 'machine-b', 'Fixture Machine Secondary', 'shared-b'),
    source('fixture-b-shared-copy', 'machine-b', 'Fixture Machine Secondary', 'shared-b-copy'),
  ]);
  const catalogue = [fixtureA, fixtureB, shared];
  const rows = [
    project(fixtureA.id, fixtureA.name),
    project(fixtureB.id, fixtureB.name),
    project(shared.id, shared.name),
  ];

  test('splits catalogue-backed project names from their ordered machine identities', () => {
    expect(projectIdentityPresentation(rows[0]!, catalogue)).toEqual({
      grouped: false,
      machines: ['Fixture Machine'],
      name: 'fixture-app',
    });
    expect(projectIdentityPresentation(rows[2]!, catalogue)).toEqual({
      grouped: true,
      machines: ['Fixture Machine', 'Fixture Machine Secondary'],
      name: 'Shared tooling',
    });
    expect(
      projectIdentityPresentation(project('source:unknown', 'unknown — Fixture Machine'), [
        catalogueGroup('source:unknown', 'unknown — Fixture Machine', false, [
          source('unknown', 'machine-a', 'Fixture Machine', ''),
        ]),
      ]),
    ).toEqual({ grouped: false, machines: ['Fixture Machine'], name: '(unknown)' });
    expect(projectIdentityPresentation(project('missing', 'Fallback project'), catalogue)).toEqual({
      grouped: false,
      machines: [],
      name: 'Fallback project',
    });
  });

  test('keeps two machine identities when their labels match and their contributions differ', () => {
    const sameLabel = catalogueGroup('group:same-label', 'Shared label project', true, [
      source('machine-a-source', 'machine-a', 'Shared', 'shared-a', 2, 200),
      source('machine-b-source', 'machine-b', 'Shared', 'shared-b', 5, 900),
    ]);

    expect(projectIdentityPresentation(project(sameLabel.id, sameLabel.name), [sameLabel])).toEqual({
      grouped: true,
      machines: ['Shared (machine-a)', 'Shared (machine-b)'],
      name: 'Shared label project',
    });
  });

  test('labels exact, partial, and unknown line measurements independently', () => {
    expect(
      projectLinesPresentation(
        project('unknown', 'Unknown', { lineMeasurement: { measuredSessions: 0, totalSessions: 3 } }),
      ),
    ).toEqual({
      coverage: null,
      label: '—',
      status: 'unknown',
      title: 'No session in this project reports line changes (0 of 3 measured)',
    });
    expect(
      projectLinesPresentation(
        project('partial', 'Partial', {
          lineMeasurement: { measuredSessions: 2, totalSessions: 5 },
          linesAdded: 0,
          linesDeleted: 0,
        }),
      ),
    ).toEqual({
      coverage: '2 of 5 sessions measured',
      label: '+0/-0',
      status: 'lower-bound',
      title: 'No line changes reported by the 2 of 5 sessions that report line counts; the rest are not counted',
    });
    expect(
      projectLinesPresentation(
        project('exact', 'Exact', {
          lineMeasurement: { measuredSessions: 3, totalSessions: 3 },
          linesAdded: 860,
          linesDeleted: 120,
        }),
      ),
    ).toEqual({
      coverage: null,
      label: '+860/-120',
      status: 'exact',
      title: 'Lines added/deleted summed over all 3 sessions',
    });
  });

  test('searches across project and machine identities while preserving row order', () => {
    expect(projectSearchRows(rows, '', catalogue)).toEqual(rows);
    expect(projectSearchRows(rows, 'secondary', catalogue)).toEqual([rows[1]!, rows[2]!]);
    expect(projectSearchRows(rows, 'shared', catalogue)).toEqual([rows[2]!]);
    expect(projectSearchRows(rows, 'FIXTURE-APP', catalogue)).toEqual([rows[0]!, rows[1]!]);
    expect(projectSearchRows(rows, 'zzz', catalogue)).toEqual([]);
    expect(projectsEmptyMessage('  ')).toBe('No projects');
    expect(projectsEmptyMessage('x')).toBe('No breakdown rows match this search');
  });
});
