import { describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { writeMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { createUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { SourcedRow } from '@ai-usage/report-core/types';
import { approximateApiCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { importPeerMergeBundle, usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import {
  createSkillsServerAdapter,
  createSkillsServerDependencies,
  knownSkillProjectPathsFromReportPayload,
  localProjectRootExists,
  projectSkillMarkdownInputFrom,
  projectSkillScanPathsFrom,
  readBoundedProjectSkillMarkdownFile,
  readProjectSkillMarkdownForServer,
  skillConfigInputFrom,
  skillManagementSnapshotForClient,
  skillMarkdownWriteInputFrom,
  skillNameInputFrom,
  skillTargetDirectoryInputFrom,
  skillToggleInputFrom,
} from './skills.server';
import { readE2ESkillManagementSnapshot } from './skills-e2e-fixture.server';

test('client skill snapshots omit markdown bodies without mutating the domain snapshot', () => {
  const result = readE2ESkillManagementSnapshot();
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  const clientSnapshot = skillManagementSnapshotForClient(result.data);

  expect(clientSnapshot.skills.map((skill) => skill.manifest.markdown)).toEqual(['', '']);
  expect(clientSnapshot.skills.map((skill) => skill.manifest.name)).toEqual(['alpha-skill', 'beta-skill']);
  expect(result.data.skills.map((skill) => skill.manifest.markdown)).toEqual(['# alpha-skill\n', '# beta-skill\n']);
});

test('bounded project markdown reads consume short reads through one regular-file handle', async () => {
  const content = Buffer.from('abcdefgh');
  let closed = false;
  const result = await readBoundedProjectSkillMarkdownFile('/project/SKILL.md', 6, {
    openFile: () =>
      Promise.resolve({
        close: () => {
          closed = true;
          return Promise.resolve();
        },
        read: (buffer, offset, length, position) => {
          const bytesRead = Math.min(2, length, content.length - position);
          if (bytesRead > 0) {
            content.copy(buffer, offset, position, position + bytesRead);
          }
          return Promise.resolve({ buffer, bytesRead });
        },
        stat: () => Promise.resolve({ isFile: () => true, size: content.length }),
      }),
  });

  expect(result).toEqual({ content: 'abcdef', truncated: true });
  expect(closed).toBe(true);
});

test('bounded project markdown reads reject non-regular file handles', async () => {
  let closed = false;
  await expect(
    readBoundedProjectSkillMarkdownFile('/project/SKILL.md', 6, {
      openFile: () =>
        Promise.resolve({
          close: () => {
            closed = true;
            return Promise.resolve();
          },
          read: (buffer) => Promise.resolve({ buffer, bytesRead: 0 }),
          stat: () => Promise.resolve({ isFile: () => false, size: 0 }),
        }),
    }),
  ).rejects.toThrow('regular file');
  expect(closed).toBe(true);
});

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

const writeSourceSkill = async (sourceRepoPath: string, skillName: string, content: string) => {
  const skillPath = path.join(sourceRepoPath, 'skills', skillName);
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, 'SKILL.md'), content, 'utf8');
};

const makeStoredRow = (input: { project: string; sessionId: string; sourcePath: string }): SourcedRow => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: approximateApiCost,
    date: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-01-01T00:01:00.000Z'),
    harness: 'Claude Code',
    model: 'claude-sonnet-4-6',
    name: input.sessionId,
    project: input.project,
    provider: 'Claude API',
    tokens: { cr: 0, cw: 0, in: 10, out: 5 },
  }),
  source: {
    harnessKey: 'claude',
    sourcePath: input.sourcePath,
    sourceSessionId: input.sessionId,
  },
});

describe('real skills server adapter', () => {
  test('uses injected temp storage and workflows for the complete management lifecycle', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-server-adapter-'));
    try {
      const home = path.join(root, 'home');
      const sourceRepoPath = path.join(root, 'source');
      const safeTargetPath = path.join(root, 'targets', 'safe');
      const unsafeTargetPath = path.join(root, 'targets', 'unsafe');
      const projectPath = path.join(root, 'project');
      const configCwd = path.join(root, 'cwd');
      const configPath = path.join(home, '.config', 'ai-usage', 'config.json');
      const originalMarkdown = `---
name: example-skill
description: Helps with adapter tests
---
# Original
`;
      await Promise.all([
        writeSourceSkill(sourceRepoPath, 'example-skill', originalMarkdown),
        writeProjectSkill(path.join(projectPath, '.claude', 'skills', 'project-skill'), 'project-skill'),
        writeProjectSkill(path.join(unsafeTargetPath, 'example-skill'), 'example-skill', '# Unmanaged\n'),
        mkdir(configCwd, { recursive: true }),
        mkdir(path.dirname(configPath), { recursive: true }),
      ]);
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            cursor: { user: 'preserved@example.com' },
            projectAliases: [{ match: ['/legacy/*'], name: 'Preserved alias' }],
            skills: {
              projectPaths: [projectPath],
              sourceRepoPath,
              targets: {
                safe: { enabled: true, kind: 'custom', path: safeTargetPath, scope: 'system' },
                unsafe: { enabled: true, kind: 'custom', path: unsafeTargetPath, scope: 'system' },
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      const storage = createLocalHistoryStorage(home);
      const baseDependencies = createSkillsServerDependencies({ configCwd, storage });
      const calls = {
        configReads: [] as { configCwd: string; home: string }[],
        configWrites: [] as string[],
        projectSourceReads: [] as { configCwd?: string; home: string }[],
        workflowHomes: [] as string[],
        workflowNames: [] as string[],
      };
      const adapter = createSkillsServerAdapter({
        ...baseDependencies,
        readConfig: (input) => {
          calls.configReads.push({ configCwd: input.configCwd, home: input.storage.home });
          return baseDependencies.readConfig(input);
        },
        readKnownProjectSources: (input) => {
          calls.projectSourceReads.push({
            ...(input.request.configCwd === undefined ? {} : { configCwd: input.request.configCwd }),
            home: input.storage.home,
          });
          return baseDependencies.readKnownProjectSources(input);
        },
        updateConfig: (input) => {
          calls.configWrites.push(input.storage.home);
          return baseDependencies.updateConfig(input);
        },
        workflows: {
          ...baseDependencies.workflows,
          createTargetDirectory: (input) => {
            calls.workflowNames.push('createTargetDirectory');
            return baseDependencies.workflows.createTargetDirectory(input);
          },
          loadSnapshot: (input) => {
            calls.workflowHomes.push(input.homePath);
            calls.workflowNames.push('loadSnapshot');
            return baseDependencies.workflows.loadSnapshot(input);
          },
          previewReconcileAll: (input) => {
            calls.workflowHomes.push(input.homePath);
            calls.workflowNames.push('previewReconcileAll');
            return baseDependencies.workflows.previewReconcileAll(input);
          },
          readMarkdown: (input) => {
            calls.workflowNames.push('readMarkdown');
            return baseDependencies.workflows.readMarkdown(input);
          },
          reconcileAll: (input) => {
            calls.workflowHomes.push(input.homePath);
            calls.workflowNames.push('reconcileAll');
            return baseDependencies.workflows.reconcileAll(input);
          },
          reconcileSkill: (input) => {
            calls.workflowHomes.push(input.homePath);
            calls.workflowNames.push('reconcileSkill');
            return baseDependencies.workflows.reconcileSkill(input);
          },
          scanProjects: (input) => {
            calls.workflowNames.push('scanProjects');
            return baseDependencies.workflows.scanProjects(input);
          },
          toggleSkill: (input) => {
            calls.workflowNames.push('toggleSkill');
            return baseDependencies.workflows.toggleSkill(input);
          },
          writeConfig: (input) => {
            calls.workflowNames.push('writeConfig');
            return baseDependencies.workflows.writeConfig(input);
          },
          writeMarkdown: (input) => {
            calls.workflowNames.push('writeMarkdown');
            return baseDependencies.workflows.writeMarkdown(input);
          },
        },
      });

      const snapshot = await adapter.readSnapshot();
      expect(snapshot).toMatchObject({ ok: true, data: { configured: true } });
      expect(snapshot.ok ? snapshot.data.skills[0]?.manifest.markdown : undefined).toBe('');

      const markdown = await adapter.readMarkdown('example-skill');
      expect(markdown).toMatchObject({ ok: true, data: { content: originalMarkdown } });
      if (!markdown.ok) {
        throw new Error(markdown.error.message);
      }

      const skillsConfig = snapshot.ok ? snapshot.data.config : {};
      const savedConfig = await adapter.saveConfig({ ...skillsConfig, projectPaths: [projectPath] });
      expect(savedConfig.ok).toBe(true);
      const persistedConfig = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      expect(persistedConfig.cursor).toEqual({ user: 'preserved@example.com' });
      expect(persistedConfig.projectAliases).toEqual([{ match: ['/legacy/*'], name: 'Preserved alias' }]);

      const conflict = await adapter.saveMarkdown({
        baseSha256: '0'.repeat(64),
        content: originalMarkdown,
        skillName: 'example-skill',
      });
      expect(conflict).toEqual({ ok: true, data: { reason: 'conflict' } });

      const editedMarkdown = originalMarkdown.replace('# Original', '# Edited');
      const savedMarkdown = await adapter.saveMarkdown({
        baseSha256: markdown.data.sha256,
        content: editedMarkdown,
        skillName: 'example-skill',
      });
      expect(savedMarkdown).toMatchObject({ ok: true, data: { document: { content: editedMarkdown } } });

      const unknownTarget = await adapter.createTargetDirectory({ targetId: 'unknown' });
      expect(unknownTarget).toMatchObject({ ok: false, error: { message: 'Unknown skill target: unknown' } });
      const createdTarget = await adapter.createTargetDirectory({ targetId: 'safe' });
      expect(createdTarget.ok).toBe(true);

      const preview = await adapter.previewReconcileAll();
      expect(preview.ok ? preview.data.actions.map((action) => action.type) : []).toEqual([
        'create-symlink',
        'refuse-unmanaged-mutation',
      ]);
      const reconciled = await adapter.reconcileAll();
      expect(reconciled.ok ? reconciled.data.actions.map((action) => action.type) : []).toEqual([
        'create-symlink',
        'refuse-unmanaged-mutation',
      ]);
      expect((await lstat(path.join(safeTargetPath, 'example-skill'))).isSymbolicLink()).toBe(true);

      const disabled = await adapter.toggleSkill({ enabled: false, skillName: 'example-skill' });
      expect(disabled.ok ? disabled.data.actions.map((action) => action.type) : []).toEqual([
        'unlink-managed-symlink',
        'refuse-unmanaged-mutation',
      ]);
      const enabled = await adapter.toggleSkill({ enabled: true, skillName: 'example-skill' });
      expect(enabled).toMatchObject({ ok: true, data: { actions: [] } });
      const reconciledSkill = await adapter.reconcileSkill('example-skill');
      expect(reconciledSkill.ok ? reconciledSkill.data.actions.map((action) => action.type) : []).toContain(
        'create-symlink',
      );

      const inventories = await adapter.readProjectInventories();
      expect(inventories.ok ? inventories.data[0]?.projectPath : undefined).toBe(projectPath);
      expect(calls.configReads.every((call) => call.configCwd === configCwd && call.home === home)).toBe(true);
      expect(calls.configWrites).toEqual([home]);
      expect(calls.projectSourceReads).toEqual([{ configCwd, home }]);
      expect(calls.workflowHomes.every((workflowHome) => workflowHome === home)).toBe(true);
      expect(new Set(calls.workflowNames)).toEqual(
        new Set([
          'createTargetDirectory',
          'loadSnapshot',
          'previewReconcileAll',
          'readMarkdown',
          'reconcileAll',
          'reconcileSkill',
          'scanProjects',
          'toggleSkill',
          'writeConfig',
          'writeMarkdown',
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('excludes imported machine project paths through the real project-source adapter', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-server-imported-'));
    try {
      const home = path.join(root, 'home');
      const configCwd = path.join(root, 'cwd');
      const importedProjectPath = path.join(root, 'imported-project');
      const storage = createLocalHistoryStorage(home);
      const machine: UsageMachine = { id: 'local-machine', label: 'Local Machine' };
      await Promise.all([
        mkdir(path.join(importedProjectPath, '.git'), { recursive: true }),
        mkdir(configCwd, { recursive: true }),
      ]);
      await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
      await Effect.runPromise(
        importPeerMergeBundle({
          bundle: createUsageMergeBundle({
            machine: { id: 'imported-machine', label: 'Imported Machine' },
            rows: [
              makeStoredRow({
                project: 'imported-project',
                sessionId: 'imported-session',
                sourcePath: importedProjectPath,
              }),
            ],
          }),
          dbPath: usageStorePath(home),
          localMachineId: machine.id,
        }),
      );

      const adapter = createSkillsServerAdapter(createSkillsServerDependencies({ configCwd, storage }));
      expect(await adapter.readKnownProjectPaths()).toEqual({ ok: true, data: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('skills server input validation', () => {
  test('accepts valid skill config inputs', () => {
    expect(skillConfigInputFrom({ sourceRepoPath: '/repo/source' })).toEqual({ sourceRepoPath: '/repo/source' });
  });

  test('rejects invalid skill names, target ids, and boolean toggles', () => {
    expect(() => skillNameInputFrom({ skillName: 'Example Skill' })).toThrow('skill name');
    expect(() => skillNameInputFrom({ skillName: '1-example-skill' })).toThrow('skill name');
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

  test('reads project markdown projected from the configured source repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-markdown-source-link-'));
    try {
      const projectPath = path.join(root, 'project');
      const sourceRepoPath = path.join(root, 'source');
      const sourceSkillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const projectSkillsPath = path.join(projectPath, '.claude', 'skills');
      await writeProjectSkill(sourceSkillPath, 'example-skill', '# Shared source\n');
      await mkdir(projectSkillsPath, { recursive: true });
      await symlink(sourceSkillPath, path.join(projectSkillsPath, 'example-skill'), 'dir');

      const result = await readProjectSkillMarkdownForServer(
        {
          projectPath,
          runtimeDirId: 'claude-project',
          skillName: 'example-skill',
        },
        {
          loadConfig: async () => ({ skills: { projectPaths: [projectPath], sourceRepoPath } }) as never,
          readKnownProjectPaths: async () => ({ ok: true, data: [] }),
        },
      );

      expect(result).toMatchObject({
        data: {
          skillName: 'example-skill',
          truncated: false,
        },
        ok: true,
      });
      expect(result.ok ? result.data.content : '').toContain('# Shared source');
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

  test('rejects project markdown reads whose observed skill resolves outside the allowed project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-markdown-symlink-'));
    try {
      const projectPath = path.join(root, 'project');
      const foreignSkillPath = path.join(root, 'foreign', 'example-skill');
      const projectSkillsPath = path.join(projectPath, '.claude', 'skills');
      await writeProjectSkill(foreignSkillPath, 'example-skill', '# Foreign secret\n');
      await mkdir(projectSkillsPath, { recursive: true });
      await symlink(foreignSkillPath, path.join(projectSkillsPath, 'example-skill'), 'dir');

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
        error: { message: 'project skill markdown is not readable' },
        ok: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects owned project markdown whose SKILL.md is an external symlink', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-markdown-file-symlink-'));
    try {
      const projectPath = path.join(root, 'project');
      const foreignSkillPath = path.join(root, 'foreign', 'example-skill');
      const ownedSkillPath = path.join(projectPath, '.claude', 'skills', 'example-skill');
      await writeProjectSkill(foreignSkillPath, 'example-skill', '# Foreign secret\n');
      await mkdir(ownedSkillPath, { recursive: true });
      await symlink(path.join(foreignSkillPath, 'SKILL.md'), path.join(ownedSkillPath, 'SKILL.md'), 'file');

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

      expect(result).toMatchObject({ ok: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
