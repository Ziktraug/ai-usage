import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  knownSkillProjectPathsFromReportPayload,
  localProjectRootExists,
  projectSkillMarkdownInputFrom,
  projectSkillScanPathsFrom,
  readProjectSkillMarkdownForServer,
  skillConfigInputFrom,
  skillMarkdownWriteInputFrom,
  skillNameInputFrom,
  skillTargetDirectoryInputFrom,
  skillToggleInputFrom,
} from './skills.server';

const writeProjectSkill = async (directory: string, name: string, content = `# ${name}\n`) => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---
name: ${name}
description: Helps with tests
---
${content}`,
    'utf8',
  );
};

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

  test('rejects invalid project skill markdown reads before workflow calls', () => {
    expect(() =>
      projectSkillMarkdownInputFrom({
        projectPath: '/project',
        runtimeDirId: 'claude-project',
        skillName: '../example-skill',
      }),
    ).toThrow('skill name');
    expect(() =>
      projectSkillMarkdownInputFrom({
        projectPath: '/project',
        runtimeDirId: 'unknown-runtime',
        skillName: 'example-skill',
      }),
    ).toThrow('runtimeDirId');
  });

  test('extracts known project paths from report project sources', () => {
    expect(
      knownSkillProjectPathsFromReportPayload(
        {
          projectGroups: [
            {
              grouped: false,
              id: 'source:ai-usage',
              name: 'ai-usage',
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
        label: 'ai-usage',
        machineLabel: 'Workstation',
        path: '/home/nathan/Projects/Github/ai-usage',
        project: 'ai-usage',
        sessions: 3,
      },
    ]);
  });

  test('keeps project group identity on known skill project paths', () => {
    expect(
      knownSkillProjectPathsFromReportPayload(
        {
          projectGroups: [
            {
              grouped: true,
              id: 'group:exalibur',
              name: 'exalibur',
              sources: [
                {
                  machineId: 'local-machine',
                  machineLabel: 'Workstation',
                  project: 'exalibur-raw',
                  sessions: 4,
                  sourcePath: '/work/exalibur',
                },
                {
                  machineId: 'local-machine',
                  machineLabel: 'Workstation',
                  project: 'exalibur2',
                  sessions: 2,
                  sourcePath: '/work/exalibur2',
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
        groupId: 'group:exalibur',
        groupLabel: 'exalibur',
        label: 'exalibur',
        machineLabel: 'Workstation',
        path: '/work/exalibur',
        project: 'exalibur-raw',
        sessions: 4,
      },
      {
        groupId: 'group:exalibur',
        groupLabel: 'exalibur',
        label: 'exalibur',
        machineLabel: 'Workstation',
        path: '/work/exalibur2',
        project: 'exalibur2',
        sessions: 2,
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
              grouped: false,
              id: 'source:local',
              name: 'local',
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

  test('drops discovered home paths before project marker checks', () => {
    expect(
      knownSkillProjectPathsFromReportPayload(
        {
          projectGroups: [
            {
              grouped: false,
              id: 'source:home',
              name: 'home',
              sources: [
                {
                  machineId: 'local-machine',
                  project: 'home',
                  sessions: 1,
                  sourcePath: '/home/nathan',
                },
              ],
            },
          ],
          rows: [],
        },
        {
          directoryExists: () => true,
          homePath: '/home/nathan',
          isProjectRoot: () => true,
          localMachineId: 'local-machine',
        },
      ),
    ).toEqual([]);
  });

  test('drops discovered container directories without project markers', () => {
    expect(
      knownSkillProjectPathsFromReportPayload(
        {
          projectGroups: [
            {
              grouped: false,
              id: 'source:Projects',
              name: 'Projects',
              sources: [
                {
                  machineId: 'local-machine',
                  project: 'Projects',
                  sessions: 1,
                  sourcePath: '/home/nathan/Projects',
                },
              ],
            },
          ],
          rows: [],
        },
        {
          directoryExists: () => true,
          isProjectRoot: () => false,
          localMachineId: 'local-machine',
        },
      ),
    ).toEqual([]);
  });

  test('drops discovered paths under tool data directories', () => {
    expect(
      knownSkillProjectPathsFromReportPayload(
        {
          projectGroups: [
            {
              grouped: false,
              id: 'source:real-app',
              name: 'real-app',
              sources: [
                {
                  machineId: 'local-machine',
                  project: 'misty-cabin',
                  sessions: 2,
                  sourcePath: '/home/nathan/.local/share/opencode/worktree/abc123/misty-cabin',
                },
                {
                  machineId: 'local-machine',
                  project: 'real-app',
                  sessions: 1,
                  sourcePath: '/home/nathan/Projects/real-app',
                },
              ],
            },
          ],
          rows: [],
        },
        {
          directoryExists: () => true,
          excludedPathPrefixes: ['/home/nathan/.local/share', '/home/nathan/.cache'],
          homePath: '/home/nathan',
          isProjectRoot: () => true,
          localMachineId: 'local-machine',
        },
      ).map((entry) => entry.path),
    ).toEqual(['/home/nathan/Projects/real-app']);
  });

  test('keeps local project roots with .git files or runtime skill directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-known-projects-'));
    try {
      const worktreePath = path.join(root, 'worktree');
      const runtimeOnlyPath = path.join(root, 'runtime-only');
      await mkdir(worktreePath, { recursive: true });
      await writeFile(path.join(worktreePath, '.git'), 'gitdir: ../.git/worktrees/worktree\n', 'utf8');
      await mkdir(path.join(runtimeOnlyPath, '.claude', 'skills'), { recursive: true });

      expect(localProjectRootExists(worktreePath)).toBe(true);
      expect(localProjectRootExists(runtimeOnlyPath)).toBe(true);
      expect(localProjectRootExists(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not curate configured project paths from scan paths', () => {
    expect(projectSkillScanPathsFrom({ projectPaths: ['/configured/container'] }, [])).toEqual([
      '/configured/container',
    ]);
  });

  test('scans configured and known project paths for project skill inventories', () => {
    expect(
      projectSkillScanPathsFrom({ projectPaths: ['/configured/project'] }, [
        { path: '/known/project' },
        { path: '/configured/project' },
      ]),
    ).toEqual(['/configured/project', '/known/project']);
  });

  test('reads project skill markdown from an allowed scanned project only', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-markdown-'));
    try {
      const projectPath = path.join(root, 'project');
      await writeProjectSkill(path.join(projectPath, '.claude', 'skills', 'example-skill'), 'example-skill');

      const result = await readProjectSkillMarkdownForServer(
        {
          projectPath,
          runtimeDirId: 'claude-project',
          skillName: 'example-skill',
        },
        {
          loadConfig: async () => ({ skills: { projectPaths: [projectPath] } }) as never,
          readKnownProjectPaths: async () => ({ ok: true, data: [] }),
        },
      );

      expect(result).toMatchObject({
        ok: true,
        data: {
          path: path.join(projectPath, '.claude', 'skills', 'example-skill', 'SKILL.md'),
          skillName: 'example-skill',
          truncated: false,
        },
      });
      expect(result.ok ? result.data.content : '').toContain('# example-skill');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects project markdown reads for foreign project paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-markdown-foreign-'));
    try {
      const projectPath = path.join(root, 'project');
      const foreignPath = path.join(root, 'foreign');
      await writeProjectSkill(path.join(foreignPath, '.claude', 'skills', 'example-skill'), 'example-skill');

      const result = await readProjectSkillMarkdownForServer(
        {
          projectPath: foreignPath,
          runtimeDirId: 'claude-project',
          skillName: 'example-skill',
        },
        {
          loadConfig: async () => ({ skills: { projectPaths: [projectPath] } }) as never,
          readKnownProjectPaths: async () => ({ ok: true, data: [] }),
        },
      );

      expect(result).toMatchObject({ ok: false, error: { message: 'project path is not allowed' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
