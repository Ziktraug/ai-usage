import { describe, expect, test } from 'bun:test';
import {
  knownSkillProjectPathsFromReportPayload,
  skillConfigInputFrom,
  skillMarkdownWriteInputFrom,
  skillNameInputFrom,
  skillTargetDirectoryInputFrom,
  skillToggleInputFrom,
} from './skills.server';

describe('skills server input validation', () => {
  test('accepts valid skill config inputs', () => {
    expect(skillConfigInputFrom({ sourceRepoPath: '/repo/source' })).toEqual({ sourceRepoPath: '/repo/source' });
  });

  test('rejects invalid skill names, target ids, and boolean toggles', () => {
    expect(() => skillNameInputFrom({ skillName: 'Example Skill' })).toThrow('skill name');
    expect(() => skillTargetDirectoryInputFrom({ targetId: 'codex/skills' })).toThrow('target id');
    expect(() => skillToggleInputFrom({ skillName: 'example-skill', enabled: 'false' })).toThrow('enabled');
  });

  test('rejects invalid config paths before workflow calls', () => {
    expect(() => skillConfigInputFrom({ sourceRepoPath: '' })).toThrow('sourceRepoPath');
  });

  test('rejects invalid skill markdown writes before workflow calls', () => {
    expect(() =>
      skillMarkdownWriteInputFrom({
        baseSha256: 'not-a-sha',
        content: '# Edit\n',
        skillName: 'example-skill',
      }),
    ).toThrow('baseSha256');
    expect(() =>
      skillMarkdownWriteInputFrom({
        baseSha256: '0'.repeat(64),
        content: '# Edit\n',
        skillName: 'Example Skill',
      }),
    ).toThrow('skill name');
  });

  test('extracts known project paths from report project sources', () => {
    expect(
      knownSkillProjectPathsFromReportPayload(
        {
          projectGroups: [
            {
              sources: [
                {
                  machineId: 'local-machine',
                  machineLabel: 'Workstation',
                  project: 'ai-usage',
                  sessions: 3,
                  sourcePath: '/home/nathan/Projects/Github/ai-usage',
                },
              ],
            },
          ],
          rows: [],
        },
        {
          directoryExists: () => true,
          localMachineId: 'local-machine',
        },
      ),
    ).toEqual([
      {
        label: 'ai-usage · Workstation',
        machineLabel: 'Workstation',
        path: '/home/nathan/Projects/Github/ai-usage',
        project: 'ai-usage',
        sessions: 3,
      },
    ]);
  });

  test('falls back to report rows when project groups are absent', () => {
    expect(
      knownSkillProjectPathsFromReportPayload(
        {
          rows: [
            {
              project: 'ai-usage',
              source: {
                machineId: 'local-machine',
                machineLabel: 'Workstation',
                sourcePath: '/home/nathan/Projects/Github/ai-usage',
              },
            },
            {
              project: 'ai-usage',
              source: {
                machineId: 'local-machine',
                machineLabel: 'Workstation',
                sourcePath: '/home/nathan/Projects/Github/ai-usage',
              },
            },
          ],
        },
        {
          directoryExists: () => true,
          localMachineId: 'local-machine',
        },
      ),
    ).toMatchObject([{ path: '/home/nathan/Projects/Github/ai-usage', sessions: 2 }]);
  });

  test('filters known project paths to local existing directories', () => {
    expect(
      knownSkillProjectPathsFromReportPayload(
        {
          projectGroups: [
            {
              sources: [
                {
                  machineId: 'local-machine',
                  project: 'local',
                  sessions: 1,
                  sourcePath: '/local/project',
                },
                {
                  machineId: 'remote-machine',
                  project: 'remote',
                  sessions: 1,
                  sourcePath: '/remote/project',
                },
                {
                  machineId: 'local-machine',
                  project: 'file',
                  sessions: 1,
                  sourcePath: '/local/export.csv',
                },
              ],
            },
          ],
          rows: [],
        },
        {
          directoryExists: (projectPath) => projectPath === '/local/project',
          localMachineId: 'local-machine',
        },
      ),
    ).toEqual([
      {
        label: 'local',
        path: '/local/project',
        project: 'local',
        sessions: 1,
      },
    ]);
  });
});
