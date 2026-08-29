import { describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { usageStorePath } from '@ai-usage/usage-store/reader';
import {
  createSkillsServerAdapter,
  createSkillsServerDependencies,
  knownSkillProjectPathsFromReportPayload,
  localProjectRootExists,
  projectSkillMarkdownInputFrom,
  projectSkillScanPathsFrom,
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

      const baseDependencies = createSkillsServerDependencies({ configCwd, homePath: home });
      const calls = {
        configReads: [] as { configCwd: string; home: string }[],
        configWrites: [] as string[],
        projectSourceReads: [] as { configCwd?: string; home: string }[],
      };
      const adapter = createSkillsServerAdapter({
        ...baseDependencies,
        readConfig: () => {
          calls.configReads.push({ configCwd: baseDependencies.configCwd, home: baseDependencies.homePath });
          return baseDependencies.readConfig();
        },
        readKnownProjectSources: () => {
          calls.projectSourceReads.push({
            configCwd: baseDependencies.configCwd,
            home: baseDependencies.homePath,
          });
          return baseDependencies.readKnownProjectSources();
        },
        updateSkills: (skills) => {
          calls.configWrites.push(baseDependencies.homePath);
          return baseDependencies.updateSkills(skills);
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
      expect(
        disabled.ok
          ? disabled.data.snapshot.projections.find(
              (projection) => projection.skillName === 'example-skill' && projection.targetId === 'safe',
            )?.state
          : undefined,
      ).toBe('missing');
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps configured project scans available without creating a store or machine config', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-server-no-store-'));
    try {
      const home = path.join(root, 'home');
      const configCwd = path.join(root, 'cwd');
      const projectPath = path.join(root, 'configured-project');
      const configPath = path.join(home, '.config', 'ai-usage', 'config.json');
      await Promise.all([
        writeProjectSkill(path.join(projectPath, '.claude', 'skills', 'configured-skill'), 'configured-skill'),
        mkdir(configCwd, { recursive: true }),
        mkdir(path.dirname(configPath), { recursive: true }),
      ]);
      await writeFile(configPath, `${JSON.stringify({ skills: { projectPaths: [projectPath] } }, null, 2)}\n`, 'utf8');

      const adapter = createSkillsServerAdapter(createSkillsServerDependencies({ configCwd, homePath: home }));
      expect(await adapter.readKnownProjectPaths()).toEqual({ ok: true, data: [] });
      expect(await adapter.readProjectInventories()).toMatchObject({ data: [{ projectPath }], ok: true });
      expect(await Bun.file(usageStorePath(home)).exists()).toBe(false);
      expect(await Bun.file(path.join(home, '.config', 'ai-usage', 'machine.json')).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not hide incompatible or corrupt project projection failures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-server-reader-failure-'));
    try {
      const dependencies = createSkillsServerDependencies({
        configCwd: root,
        homePath: path.join(root, 'home'),
        readModel: {
          readCurrentLocalProjectSources: () =>
            Promise.reject({ message: 'private database path', reason: 'schema-too-new' }),
          readSkillObservations: () => Promise.reject(new Error('Unexpected skill observation read')),
        },
      });

      const result = await createSkillsServerAdapter(dependencies).readKnownProjectPaths();

      expect(result).toEqual({
        error: { message: 'Project discovery is unavailable.', tag: 'Error' },
        ok: false,
      });
      expect(JSON.stringify(result)).not.toContain('private database path');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects an expanded project-source response above the preserved 512 KiB wire budget', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-server-budget-'));
    try {
      const sources = Array.from({ length: 700 }, (_, index) => ({
        label: `Project ${index}`,
        machineId: 'machine-local',
        machineLabel: 'Local machine',
        project: `project-${index}`,
        sessions: 1,
        sourcePath: `/private/${'x'.repeat(900)}/${index}`,
      }));
      expect(Buffer.byteLength(JSON.stringify({ revision: 'revision-a', sources }))).toBeGreaterThan(512 * 1024);
      const dependencies = createSkillsServerDependencies({
        configCwd: root,
        homePath: path.join(root, 'home'),
        readModel: {
          readCurrentLocalProjectSources: () => Promise.resolve({ revision: 'revision-a', sources }),
          readSkillObservations: () => Promise.reject(new Error('Unexpected skill observation read')),
        },
      });

      const result = await createSkillsServerAdapter(dependencies).readKnownProjectPaths();

      expect(result).toEqual({
        error: { message: 'Project discovery exceeds its response budget.', tag: 'Error' },
        ok: false,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('reads skill observations through the read-only seam without touching the skills domain', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-server-observations-'));
    try {
      const dependencies = createSkillsServerDependencies({
        configCwd: root,
        homePath: path.join(root, 'home'),
        readModel: {
          readCurrentLocalProjectSources: () => Promise.reject(new Error('Unexpected project source read')),
          readSkillObservations: () =>
            Promise.resolve({
              harnesses: [
                { harnessKey: 'claude', label: 'Claude Code', observability: 'observable' as const },
                { harnessKey: 'cursor', label: 'Cursor', observability: 'not-observable' as const },
              ],
              lowerBound: false,
              skills: [],
              skipped: 0,
            }),
        },
      });

      const result = await createSkillsServerAdapter(dependencies).readObservations();

      expect(result).toMatchObject({
        data: { harnesses: [{ harnessKey: 'claude' }, { harnessKey: 'cursor', observability: 'not-observable' }] },
        ok: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('reports an unreadable store as unavailable rather than as zero observations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-server-observations-failure-'));
    try {
      const dependencies = createSkillsServerDependencies({
        configCwd: root,
        homePath: path.join(root, 'home'),
        readModel: {
          readCurrentLocalProjectSources: () => Promise.reject(new Error('Unexpected project source read')),
          readSkillObservations: () => Promise.reject({ message: 'private database path', reason: 'store-missing' }),
        },
      });

      const result = await createSkillsServerAdapter(dependencies).readObservations();

      // An empty dataset here would draw every observable harness as a zero for every skill, which
      // is exactly the false reading ADR 0022 forbids.
      expect(result).toEqual({
        error: { message: 'Skill observations are unavailable.', tag: 'Error' },
        ok: false,
      });
      expect(JSON.stringify(result)).not.toContain('private database path');
    } finally {
      await rm(root, { force: true, recursive: true });
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
        groupId: 'source:ai-usage',
        groupLabel: 'ai-usage',
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
              id: 'group:019f9e7d-1111-4111-8111-111111111111',
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
        groupId: 'group:019f9e7d-1111-4111-8111-111111111111',
        groupLabel: 'exalibur',
        label: 'exalibur',
        machineLabel: 'Workstation',
        path: '/work/exalibur',
        project: 'exalibur-raw',
        sessions: 4,
      },
      {
        groupId: 'group:019f9e7d-1111-4111-8111-111111111111',
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
        groupId: 'source:local',
        groupLabel: 'local',
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
