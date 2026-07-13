import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSkillsApplication, readBoundedProjectSkillMarkdown } from './application';
import type { SkillManagementConfigDocument } from './contracts';

describe('skills application', () => {
  test('owns config updates while preserving unrelated host fields', async () => {
    let config: SkillManagementConfigDocument = { machine: { id: 'machine-a' }, theme: 'dark' };
    const application = createSkillsApplication({
      homePath: '/tmp/application-home',
      readConfig: () => Promise.resolve(config),
      writeConfig: (nextConfig) => {
        config = nextConfig;
        return Promise.resolve();
      },
    });

    const snapshot = await application.writeConfig({ projectPaths: ['/work/project'] });

    expect(config).toEqual({
      machine: { id: 'machine-a' },
      skills: { projectPaths: ['/work/project'] },
      theme: 'dark',
    });
    expect(snapshot.config.projectPaths).toEqual(['/work/project']);
  });

  test('rejects target creation by an unconfigured path or identifier', async () => {
    const application = createSkillsApplication({
      homePath: '/tmp/application-home',
      readConfig: () => Promise.resolve({}),
      writeConfig: () => Promise.resolve(),
    });

    await expect(application.createTarget('/tmp/untrusted-target')).rejects.toThrow('Unknown skill target');
  });

  test('combines host-curated and configured project paths behind the inventory use case', async () => {
    const application = createSkillsApplication({
      homePath: '/tmp/application-home',
      projectPaths: () => Promise.resolve(['/work/from-host']),
      readConfig: () => Promise.resolve({ skills: { projectPaths: ['/work/from-config'] } }),
      writeConfig: () => Promise.resolve(),
    });

    expect(await application.readProjectInventories()).toEqual([
      { diagnostics: [], observations: [], projectPath: '/work/from-config' },
      { diagnostics: [], observations: [], projectPath: '/work/from-host' },
    ]);
  });

  test('owns bounded no-follow project Markdown reads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skills-application-markdown-'));
    try {
      const markdownPath = path.join(root, 'SKILL.md');
      await writeFile(markdownPath, 'abcdefgh');
      expect(await readBoundedProjectSkillMarkdown(markdownPath, 6)).toEqual({
        content: 'abcdef',
        truncated: true,
      });

      const directoryPath = path.join(root, 'directory');
      await mkdir(directoryPath);
      await expect(readBoundedProjectSkillMarkdown(directoryPath, 6)).rejects.toThrow('regular file');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
